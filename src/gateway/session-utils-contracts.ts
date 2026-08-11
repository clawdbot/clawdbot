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

export type SessionActorProfileIdentity = {
  label?: string;
  avatarUrl?: string;
};

export type SessionListRowContext = {
  subagentRuns: SubagentRunReadIndex<SubagentRunReadRecord>;
  storeChildSessionsByKey: Map<string, string[]>;
  selectedModelByOverrideRef: Map<string, ReturnType<typeof resolveSessionModelRef>>;
  thinkingMetadataByModelRef: Map<
    string,
    {
      levels: ReturnType<typeof listThinkingLevelOptions>;
      defaultLevel: ThinkLevel;
    }
  >;
  displayModelIdentityByKey: Map<string, { provider?: string; model?: string }>;
  modelCostConfigByModelRef: Map<string, ModelCostConfig | undefined>;
  userProfileIdentityById: Map<string, SessionActorProfileIdentity | undefined>;
  acpSessionMetaByEntry: Map<SessionEntry, SessionAcpMeta | undefined>;
};

export type SessionListRowContextProvider = () => SessionListRowContext;

export type GatewaySessionStoreTarget = {
  agentId: string;
  storePath: string;
  canonicalKey: string;
  storeKeys: string[];
};

export type GatewaySessionStoreTargetWithStore = GatewaySessionStoreTarget & {
  canonicalValidationError?: Error;
  store: Record<string, SessionEntry>;
};

export function createSessionRowModelCacheKey(
  provider: string | undefined,
  model: string | undefined,
) {
  return `${normalizeLowercaseStringOrEmpty(provider)}\0${normalizeOptionalString(model) ?? ""}`;
}
