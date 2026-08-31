/**
 * Shared assertions helpers for models-config tests. These helpers read the
 * generated agent-local model snapshot through the same path setup uses.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveDefaultAgentDir } from "./agent-scope.js";

/** Read and parse the generated `models.json` file for assertions. */
export async function readGeneratedModelsJson<T>(
  agentDir = resolveDefaultAgentDir({}),
): Promise<T> {
  const modelPath = path.join(agentDir, "models.json");
  const raw = await fs.readFile(modelPath, "utf8");
  return JSON.parse(raw) as T;
}
