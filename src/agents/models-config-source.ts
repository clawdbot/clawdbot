import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import { resolveDefaultAgentDir } from "./agent-scope.js";

function readModelsJsonIfExists(agentDir: string): string | null {
  try {
    return fs.readFileSync(path.join(agentDir, "models.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/** Resolves an agent-local catalog, falling back to the default agent only when it is absent. */
export function resolveModelsJsonSourceContents(
  config: OpenClawConfig,
  agentDir: string,
): string | null {
  const localContents = readModelsJsonIfExists(agentDir);
  if (localContents !== null) {
    return localContents;
  }
  const defaultAgentDir = resolveDefaultAgentDir(config);
  if (path.resolve(agentDir) === path.resolve(defaultAgentDir)) {
    return null;
  }
  return readModelsJsonIfExists(defaultAgentDir);
}
