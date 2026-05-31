import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions.js";
import { isDefaultAgentRuntimeId } from "./agent-runtime-id.js";
import { normalizeOptionalAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveCliRuntimeModelBackendBinding } from "./cli-backends.js";
import { resolveContextConfigProviderForRuntime } from "./openai-routing.js";

export type SessionRuntimeCompatEntry = Pick<
  SessionEntry,
  "agentHarnessId" | "agentRuntimeOverride"
>;

export function resolvePersistedSessionRuntimeId(
  entry?: SessionRuntimeCompatEntry,
): string | undefined {
  const runtimeOverride = normalizeOptionalAgentRuntimeId(entry?.agentRuntimeOverride);
  if (runtimeOverride && !isDefaultAgentRuntimeId(runtimeOverride)) {
    return runtimeOverride;
  }
  return normalizeOptionalAgentRuntimeId(entry?.agentHarnessId);
}

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
  return resolveCliRuntimeModelBackendBinding({ provider, runtime })?.runtime;
}

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
