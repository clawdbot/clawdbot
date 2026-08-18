import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { resolveSessionModelRef } from "../agents/session-model-ref.js";
import type { SubagentRunReadIndex } from "../agents/subagents/registry/subagent-registry-read.js";
import type { SubagentRunReadRecord } from "../agents/subagents/registry/subagent-registry.types.js";
import type { ThinkLevel, listThinkingLevelOptions } from "../auto-reply/thinking.js";
import type { SessionAcpMeta, SessionEntry } from "../config/sessions.js";
import type { ModelCostConfig } from "../utils/usage-format.js";

export type GatewayModelThinkingProfile = {
  thinkingLevels: ReturnType<typeof listThinkingLevelOptions>;
  thinkingDefault: ThinkLevel;
};

// Store-target shapes live on a registry-free leaf (session-utils-store-target.ts)
// so spawn/runtime can import them without pulling the session-utils barrel.

export type SessionActorProfileIdentity = {
  label?: string;
  avatarUrl?: string;
};

export type SessionListRowContext = {
  subagentRuns: SubagentRunReadIndex<SubagentRunReadRecord>;
  storeChildSessionsByKey: Map<string, string[]>;
  selectedModelByOverrideRef: Map<string, ReturnType<typeof resolveSessionModelRef>>;
  thinkingMetadataByModelRef: Map<string, GatewayModelThinkingProfile>;
  displayModelIdentityByKey: Map<string, { provider?: string; model?: string }>;
  modelCostConfigByModelRef: Map<string, ModelCostConfig | undefined>;
  userProfileIdentityById: Map<string, SessionActorProfileIdentity | undefined>;
  acpSessionMetaByEntry: Map<SessionEntry, SessionAcpMeta | undefined>;
};

export type SessionListRowContextProvider = () => SessionListRowContext;

export function createSessionRowModelCacheKey(
  provider: string | undefined,
  model: string | undefined,
) {
  return `${normalizeLowercaseStringOrEmpty(provider)}\0${normalizeOptionalString(model) ?? ""}`;
}
