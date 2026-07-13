import { promises as dns } from "node:dns";
import { isIP } from "node:net";

function ipv4Number(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return null;
  }
  return octets.reduce((total, octet) => total * 256 + octet, 0) >>> 0;
}

function ipv6Number(value: string): bigint | null {
  let input = value.toLowerCase().split("%")[0] || "";
  const ipv4Tail = input.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Tail) {
    const number = ipv4Number(ipv4Tail);
    if (number === null) return null;
    input = input.slice(0, -ipv4Tail.length) +
      `${((number >>> 16) & 0xffff).toString(16)}:${(number & 0xffff).toString(16)}`;
  }

  const halves = input.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }
  const groups = [...left, ...Array(missing).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
    return null;
  }
  return groups.reduce((total, group) => (total << 16n) | BigInt(`0x${group}`), 0n);
}

function isInIpv4Cidr(address: number, base: string, bits: number): boolean {
  const baseNumber = ipv4Number(base);
  if (baseNumber === null) return true;
  const shift = 32 - bits;
  return (address >>> shift) === (baseNumber >>> shift);
}

function isInIpv6Cidr(address: bigint, base: string, bits: number): boolean {
  const baseNumber = ipv6Number(base);
  if (baseNumber === null) return true;
  const shift = BigInt(128 - bits);
  return (address >> shift) === (baseNumber >> shift);
}

function isNonPublicIpv4(hostname: string): boolean {
  const address = ipv4Number(hostname);
  if (address === null) return true;
  return [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4]
  ].some(([base, bits]) => isInIpv4Cidr(address, base as string, bits as number));
}

function isNonPublicIpv6(hostname: string): boolean {
  const address = ipv6Number(hostname);
  if (address === null) return true;

  // IPv4-mapped IPv6 must inherit the IPv4 range decision.
  if ((address >> 32n) === 0xffffn) {
    const ipv4 = Number(address & 0xffffffffn);
    return isNonPublicIpv4(
      `${ipv4 >>> 24}.${(ipv4 >>> 16) & 255}.${(ipv4 >>> 8) & 255}.${ipv4 & 255}`
    );
  }

  return [
    ["::", 128],
    ["::1", 128],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001:2::", 48],
    ["2001:10::", 28],
    ["2001:20::", 28],
    ["2001:db8::", 32],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8]
  ].some(([base, bits]) => isInIpv6Cidr(address, base as string, bits as number));
}

export function isPrivateOrLocalHostname(rawHostname: string): boolean {
  const hostname = rawHostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");

  const ipVersion = isIP(hostname);

  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    (ipVersion === 4 && isNonPublicIpv4(hostname)) ||
    (ipVersion === 6 && isNonPublicIpv6(hostname))
  );
}

export function isSafePublicHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      !isPrivateOrLocalHostname(parsed.hostname)
    );
  } catch {
    return false;
  }
}

export async function resolvesToPublicAddress(rawHostname: string): Promise<boolean> {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isPrivateOrLocalHostname(hostname)) return false;
  if (isIP(hostname)) return true;

  // Deliberately do not cache this result. Re-resolving immediately before each
  // request narrows the DNS-rebinding window; production still needs an egress
  // firewall because application-level DNS checks cannot pin Chromium's socket.
  return dns.lookup(hostname, { all: true, verbatim: true }).then(
    (addresses) =>
      addresses.length > 0 &&
      addresses.every((item) => !isPrivateOrLocalHostname(item.address)),
    () => false
  );
}

export async function isResolvedPublicHttpUrl(raw: string): Promise<boolean> {
  if (!isSafePublicHttpUrl(raw)) return false;
  return resolvesToPublicAddress(new URL(raw).hostname);
}
