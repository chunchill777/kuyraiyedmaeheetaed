import { openDb } from "./db";
import { clearLegacyPendingQueue } from "./sourceQueue";

export function main() {
  if (
    process.env.CONFIRM_CLEAR_LEGACY_QUEUE !== "true" &&
    !process.argv.includes("--confirm")
  ) {
    throw new Error(
      "Refusing to clear the legacy queue without --confirm or CONFIRM_CLEAR_LEGACY_QUEUE=true"
    );
  }

  const db = openDb();
  try {
    const cleared = clearLegacyPendingQueue(db);
    console.log(JSON.stringify({ clearedLegacyPendingUrls: cleared }, null, 2));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("Failed to clear legacy queue:", error);
    process.exitCode = 1;
  }
}
