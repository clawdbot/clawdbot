import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawAgentDir } from "./agent-paths.js";

export async function readGeneratedModelsJson<T>(agentDir = resolveOpenClawAgentDir()): Promise<T> {
  const modelPath = path.join(agentDir, "models.json");
  const raw = await fs.readFile(modelPath, "utf8");
  return JSON.parse(raw) as T;
}
