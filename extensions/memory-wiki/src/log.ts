import fs from "node:fs/promises";
import path from "node:path";

type MemoryWikiLogEntry = {
  type: "init" | "ingest" | "compile" | "lint";
  timestamp: string;
  details?: Record<string, unknown>;
};

export async function appendMemoryWikiLog(
  vaultRoot: string,
  entry: MemoryWikiLogEntry,
): Promise<void> {
  const logPath = path.join(vaultRoot, ".openclaw-wiki", "log.jsonl");
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
}
