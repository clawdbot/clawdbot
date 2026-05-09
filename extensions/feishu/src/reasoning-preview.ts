import { resolveFeishuConfigReasoningDefault } from "./agent-config.js";
import { loadSessionStore, resolveSessionStoreEntry } from "./bot-runtime-api.js";
import type { ClawdbotConfig } from "./bot-runtime-api.js";

export function resolveFeishuReasoningPreviewEnabled(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  storePath: string;
  sessionKey?: string;
}): boolean {
  const configDefault = resolveFeishuConfigReasoningDefault(params.cfg, params.agentId);

  if (!params.sessionKey) {
    return configDefault === "stream";
  }

  try {
    const store = loadSessionStore(params.storePath, { skipCache: true });
    const level = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey }).existing
      ?.reasoningLevel;
    if (level === "on" || level === "stream" || level === "off") {
      return level === "stream";
    }
  } catch {
    return false;
  }
  return configDefault === "stream";
}
