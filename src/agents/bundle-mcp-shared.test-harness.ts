/**
 * Shared test harness helpers for generating bundle MCP servers and plugin
 * fixture files.
 */
import fs from "node:fs/promises";
import path from "node:path";

/** Writes an executable fixture script with parent directories created. */
export async function writeExecutable(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, { encoding: "utf-8", mode: 0o755 });
}
