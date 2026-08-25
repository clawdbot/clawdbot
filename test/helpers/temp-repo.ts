// Temporary repo helper creates Git repositories for integration tests.
import fs from "node:fs";
import path from "node:path";

/** Write formatted JSON to a path, creating parent directories. */
export function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
