import { AsyncLocalStorage } from "node:async_hooks";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import { resolveSessionModelRef } from "../agents/session-model-ref.js";
import type { SessionEntry } from "../config/sessions.js";
import { createAgentPatchedSessionModelFallback } from "../config/sessions/session-model-fallback.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const agentSessionModelPatch = new AsyncLocalStorage<boolean>();

export function withAgentSessionModelPatchOrigin<T>(run: () => T): T {
  return agentSessionModelPatch.run(true, run);
}

export function isAgentSessionModelPatchOrigin(): boolean {
  return agentSessionModelPatch.getStore() === true;
}

export function shouldPreserveSessionAuthProfileOverride(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  currentProvider: string;
  provider: string;
}): boolean {
  const profileOverride = normalizeOptionalString(params.entry.authProfileOverride);
  const provider = normalizeOptionalLowercaseString(params.provider);
  if (!profileOverride || !provider) {
    return false;
  }
  const resolvesToTargetProvider = (rawProvider: string | undefined): boolean => {
    const candidate = normalizeOptionalLowercaseString(rawProvider);
    return Boolean(
      candidate &&
      resolveProviderIdForAuth(candidate, { config: params.cfg }) ===
        resolveProviderIdForAuth(provider, { config: params.cfg }),
    );
  };
  const delimiterIndex = profileOverride.indexOf(":");
  if (delimiterIndex < 0) {
    return resolvesToTargetProvider(params.currentProvider);
  }
  return resolvesToTargetProvider(profileOverride.slice(0, delimiterIndex));
}

export function snapshotAgentModelFallback(
  cfg: OpenClawConfig,
  entry: SessionEntry,
  agentId: string,
  now: number,
): NonNullable<SessionEntry["modelFallback"]> {
  const prior = resolveSessionModelRef(cfg, entry, agentId);
  return createAgentPatchedSessionModelFallback({
    model: prior.model,
    provider: prior.provider,
    entry,
    ts: now,
  });
}
