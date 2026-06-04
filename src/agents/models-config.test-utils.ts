import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentDir } from "./agent-scope.js";

// Test helper for reading the generated per-agent models snapshot.
/** Read and parse the generated `models.json` file for assertions. */
export async function readGeneratedModelsJson<T>(
  agentDir = resolveDefaultAgentDir({}),
): Promise<T> {
  const modelPath = path.join(agentDir, "models.json");
  const raw = await fs.readFile(modelPath, "utf8");
  return JSON.parse(raw) as T;
}
