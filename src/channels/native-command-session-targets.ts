/**
 * Native command session target resolver.
 *
 * Chooses storage and command target session keys for channel-native command events.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

/**
 * Inputs for resolving where a native channel command should attach session state.
 */
export type ResolveNativeCommandSessionTargetsParams = {
  agentId: string;
  sessionPrefix: string;
  userId: string;
  targetSessionKey: string;
  boundSessionKey?: string;
  lowercaseSessionKey?: boolean;
};

/**
 * Resolves the storage session key and command target key for native command events.
 */
export function resolveNativeCommandSessionTargets(
  params: ResolveNativeCommandSessionTargetsParams,
) {
  const rawSessionKey =
    params.boundSessionKey ?? `agent:${params.agentId}:${params.sessionPrefix}:${params.userId}`;
  return {
    // Some providers normalize user ids case-insensitively; keep this opt-in so existing
    // case-sensitive bindings are preserved for channels that need them.
    sessionKey: params.lowercaseSessionKey
      ? normalizeLowercaseStringOrEmpty(rawSessionKey)
      : rawSessionKey,
    commandTargetSessionKey: params.boundSessionKey ?? params.targetSessionKey,
  };
}
