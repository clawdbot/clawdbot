import { mergeCodexThreadConfigs } from "./plugin-thread-config.js";
import type { JsonObject } from "./protocol.js";

const CODEX_NATIVE_PROJECT_DOC_MAX_BYTES = 128 * 1024;

export function buildCodexProjectDocThreadConfig(config?: JsonObject): JsonObject {
  const defaults: JsonObject = { project_doc_max_bytes: CODEX_NATIVE_PROJECT_DOC_MAX_BYTES };
  return mergeCodexThreadConfigs(defaults, config) ?? defaults;
}
