import {
  isThinkingLevelSupported,
  resolveSupportedThinkingLevel,
  type ThinkLevel,
  type ThinkingCatalogEntry,
} from "../auto-reply/thinking.js";
/** Resolves the concrete harness runtime that owns the next agent turn. */
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentHarnessPolicy } from "./harness/policy.js";
import { resolveAutoAgentHarnessId } from "./harness/support.js";
import { resolveSessionRuntimeOverrideForProvider } from "./session-runtime-compat.js";

/** Convert residual auto policy into the built-in fallback when no registry selection is needed. */
export function concretizeAgentRuntime(runtime: string): string {
  return runtime === "auto" ? "openclaw" : runtime;
}

/** Resolves an explicit session override before configured model/provider policy. */
export function resolveEffectiveAgentRuntime(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
  agentId?: string;
  sessionKey?: string;
  sessionEntry?: Pick<SessionEntry, "agentHarnessId" | "agentRuntimeOverride">;
}): string {
  const sessionRuntime = resolveSessionRuntimeOverrideForProvider({
    provider: params.provider,
    entry: params.sessionEntry,
    cfg: params.cfg,
  });
  const runtime =
    sessionRuntime ??
    resolveAgentHarnessPolicy({
      provider: params.provider,
      modelId: params.modelId,
      config: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
    }).runtime;
  if (runtime === "auto") {
    // Reuse the loaded harness registry without triggering plugin discovery.
    // This keeps thinking policy aligned with the harness that would own the turn.
    return (
      resolveAutoAgentHarnessId({
        provider: params.provider,
        modelId: params.modelId,
        config: params.cfg,
      }) ?? "openclaw"
    );
  }
  return concretizeAgentRuntime(runtime);
}

/** Revalidates a turn-local thinking level after fallback selects its actual model/runtime. */
export function resolveCandidateThinkingLevel(params: {
  cfg?: OpenClawConfig;
  provider: string;
  modelId: string;
  level?: ThinkLevel;
  catalog?: ThinkingCatalogEntry[];
  agentId?: string;
  sessionKey?: string;
  sessionEntry?: Pick<SessionEntry, "agentHarnessId" | "agentRuntimeOverride">;
  /** Concrete harness already selected by the caller, when selection is pinned. */
  agentRuntime?: string | null;
}): ThinkLevel | undefined {
  if (!params.level) {
    return undefined;
  }
  const concreteRuntime = params.agentRuntime?.trim().toLowerCase();
  const agentRuntime =
    concreteRuntime && concreteRuntime !== "auto" && concreteRuntime !== "default"
      ? concreteRuntime
      : resolveEffectiveAgentRuntime({
          cfg: params.cfg ?? {},
          provider: params.provider,
          modelId: params.modelId,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          sessionEntry: params.sessionEntry,
        });
  const policy = {
    provider: params.provider,
    model: params.modelId,
    level: params.level,
    catalog: params.catalog,
    agentRuntime,
  };
  return isThinkingLevelSupported(policy) ? params.level : resolveSupportedThinkingLevel(policy);
}
