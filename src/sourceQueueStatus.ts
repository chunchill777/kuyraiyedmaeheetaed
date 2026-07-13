import { openDb } from "./db";
import { getSourceQueueStats } from "./sourceQueue";

export function main() {
  const db = openDb();
  try {
    console.log(JSON.stringify(getSourceQueueStats(db), null, 2));
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error("Failed to read source queue:", error);
    process.exitCode = 1;
  }
}
