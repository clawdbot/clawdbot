/**
 * Session runtime compatibility helpers.
 *
 * Resolves persisted runtime overrides without leaking provider-specific CLI runtime bindings across model routes.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions.js";
import { isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import { normalizeOptionalAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveCliRuntimeModelBackendBinding } from "./cli-backends.js";
import { resolveContextConfigProviderForRuntime } from "./openai-routing.js";

/** Persisted runtime fields used to recover session runtime compatibility. */
export type SessionRuntimeCompatEntry = Pick<
  SessionEntry,
  "agentHarnessId" | "agentRuntimeOverride"
>;

/** Resolves the persisted runtime id, preferring explicit overrides. */
export function resolvePersistedSessionRuntimeId(
  entry?: SessionRuntimeCompatEntry,
): string | undefined {
  const runtimeOverride = normalizeOptionalAgentRuntimeId(entry?.agentRuntimeOverride);
  if (runtimeOverride && !isDefaultAgentRuntimeId(runtimeOverride)) {
    return runtimeOverride;
  }
  return normalizeOptionalAgentRuntimeId(entry?.agentHarnessId);
}

/** Resolves whether a session runtime override applies to the selected provider. */
export function resolveSessionRuntimeOverrideForProvider(params: {
  provider: string;
  entry?: Pick<SessionEntry, "agentRuntimeOverride">;
}): string | undefined {
  const provider = normalizeLowercaseStringOrEmpty(params.provider);
  const runtime = normalizeOptionalAgentRuntimeId(params.entry?.agentRuntimeOverride);
  if (!runtime || isDefaultAgentRuntimeId(runtime)) {
    return undefined;
  }
  if (runtime === "openclaw") {
    return "openclaw";
  }
  if (provider === "openai" && runtime === "codex") {
    return "codex";
  }
  // CLI runtime bindings are provider-specific; an override from another
  // provider must not leak into this session's model route.
  return resolveCliRuntimeModelBackendBinding({ provider, runtime })?.runtime;
}

/** Resolves the context config provider for a persisted session runtime route. */
export function resolveContextConfigProviderForSessionRuntime(params: {
  provider: string;
  entry?: SessionRuntimeCompatEntry;
}): string | undefined {
  const runtimeId = resolvePersistedSessionRuntimeId(params.entry);
  return runtimeId
    ? resolveContextConfigProviderForRuntime({
        provider: params.provider,
        runtimeId,
      })
    : undefined;
}
