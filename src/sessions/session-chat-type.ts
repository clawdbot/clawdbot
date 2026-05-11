import { getBootstrapChannelPlugin } from "../channels/plugins/bootstrap-registry.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  deriveSessionChatTypeFromKey,
  type SessionKeyChatType,
} from "./session-chat-type-shared.js";
import { parseAgentSessionKey } from "./session-key-utils.js";

export {
  deriveSessionChatTypeFromKey,
  type SessionKeyChatType,
} from "./session-chat-type-shared.js";

type LegacySessionChatTypeDeriver = NonNullable<
  NonNullable<ReturnType<typeof getBootstrapChannelPlugin>>["messaging"]
>["deriveLegacySessionChatType"];

function resolveScopedSessionKey(sessionKey: string | undefined | null): string {
  const raw = normalizeLowercaseStringOrEmpty(sessionKey);
  if (!raw) {
    return "";
  }
  return parseAgentSessionKey(raw)?.rest ?? raw;
}

function collectLegacyChatTypeCandidatePluginIds(scopedSessionKey: string): string[] {
  const ids = new Set<string>();
  const firstToken = scopedSessionKey.split(":").find(Boolean);
  if (firstToken) {
    ids.add(firstToken);
  }
  if (scopedSessionKey.includes("@g.us")) {
    ids.add("whatsapp");
  }
  return Array.from(ids);
}

function derivePluginLegacySessionChatType(
  scopedSessionKey: string,
  deriveLegacySessionChatType: LegacySessionChatTypeDeriver,
): SessionKeyChatType | undefined {
  if (!deriveLegacySessionChatType) {
    return undefined;
  }
  return deriveLegacySessionChatType(scopedSessionKey);
}

export function deriveSessionChatType(sessionKey: string | undefined | null): SessionKeyChatType {
  const builtInType = deriveSessionChatTypeFromKey(sessionKey);
  if (builtInType !== "unknown") {
    return builtInType;
  }

  const scopedSessionKey = resolveScopedSessionKey(sessionKey);
  for (const pluginId of collectLegacyChatTypeCandidatePluginIds(scopedSessionKey)) {
    const derived = derivePluginLegacySessionChatType(
      scopedSessionKey,
      getBootstrapChannelPlugin(pluginId)?.messaging?.deriveLegacySessionChatType,
    );
    if (derived) {
      return derived;
    }
  }
  return "unknown";
}
