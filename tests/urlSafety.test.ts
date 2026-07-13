import assert from "node:assert/strict";
import test from "node:test";

import {
  isPrivateOrLocalHostname,
  isSafePublicHttpUrl
} from "../src/urlSafety";

test("blocks local, private, metadata, and IPv4-mapped hosts", () => {
  for (const hostname of [
    "localhost",
    "api.internal",
    "127.0.0.1",
    "10.1.2.3",
    "172.20.1.1",
    "192.168.1.2",
    "169.254.169.254",
    "198.18.0.1",
    "224.0.0.1",
    "240.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "fe9a::1",
    "fec0::1",
    "ff02::1",
    "2001:db8::1"
  ]) {
    assert.equal(isPrivateOrLocalHostname(hostname), true, hostname);
  }
});

test("accepts only credential-free public HTTP(S) URL syntax", () => {
  assert.equal(isSafePublicHttpUrl("https://example.com/news"), true);
  assert.equal(isSafePublicHttpUrl("ftp://example.com/file"), false);
  assert.equal(isSafePublicHttpUrl("https://user:pass@example.com/news"), false);
  assert.equal(isSafePublicHttpUrl("http://127.0.0.1/admin"), false);
  assert.equal(isSafePublicHttpUrl("https://[fe80::1]/admin"), false);
  assert.equal(isPrivateOrLocalHostname("8.8.8.8"), false);
  assert.equal(isPrivateOrLocalHostname("2606:4700:4700::1111"), false);
});
