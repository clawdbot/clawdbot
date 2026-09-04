import path from "node:path";
import type { CodexAppServerClient } from "./client.js";
import { isJsonObject, type CodexConfigReadResponse } from "./protocol.js";

// Native session flags override these layers. Legacy managed layers sit above
// them, so app admission and restricted turns cannot replace their tool policy.
export const CODEX_SESSION_OVERRIDABLE_LAYER_TYPES = new Set([
  "packagedDefaults",
  "mdm",
  "system",
  "enterpriseManaged",
  "user",
  "project",
  "sessionFlags",
]);

/** Read one effective snapshot for the current boundary's reviewer and tool-policy checks. */
export async function readCodexEffectiveConfig(
  client: Pick<CodexAppServerClient, "request">,
  cwd: string,
  signal?: AbortSignal,
): Promise<CodexConfigReadResponse> {
  const response = await client.request(
    "config/read",
    { cwd: path.resolve(cwd), includeLayers: true },
    { signal },
  );
  if (!isJsonObject(response) || !isJsonObject(response.config)) {
    throw new Error("Codex config/read returned an invalid effective config");
  }
  return response;
}
