import path from "node:path";
import type { CodexConfigReadParams, CodexConfigReadResponse } from "./protocol-control-plane.js";
import { isJsonObject } from "./protocol.js";

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

export type CodexConfigReadClient = {
  request(
    method: "config/read",
    params: CodexConfigReadParams,
    options: { signal?: AbortSignal },
  ): Promise<CodexConfigReadResponse>;
};

/** Read one effective snapshot for the current boundary's reviewer and tool-policy checks. */
export async function readCodexEffectiveConfig(
  client: CodexConfigReadClient,
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
