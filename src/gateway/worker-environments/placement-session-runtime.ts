import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection-cli.js";
import { resolveSessionModelRef } from "../../agents/session-model-ref.js";
import { resolveSessionRuntimeOverrideForProvider } from "../../agents/session-runtime-compat.js";
import { resolveEffectiveAgentRuntime } from "../../agents/thinking-runtime.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import type { GatewayAgentRuntime } from "../../shared/session-types.js";
import { resolveWorkerPlacementCapabilities } from "./placement-capabilities.js";
import type { WorkerPlacementExecutionMode } from "./placement-record.js";

export { resolveWorkerPlacementCapabilities } from "./placement-capabilities.js";

export function resolveWorkerPlacementSessionRuntime(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentId: string;
  sessionKey: string;
}): string {
  const selectedModel = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  return resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider: selectedModel.provider,
    modelId: selectedModel.model,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionEntry: params.entry,
  });
}

export function resolveWorkerPlacementExecutionMode(
  runtime: string,
): WorkerPlacementExecutionMode | undefined {
  return resolveWorkerPlacementCapabilities(runtime).executionMode;
}

/**
 * Resolves placement capabilities for the model a session would use after a
 * patch. Mirrors the dispatch path's CLI-classification precedence
 * (`agent-runner-fallback-candidate.ts`): resolve the session runtime override
 * first, skip CLI aliasing when a non-CLI override is active, and pass the
 * selected auth profile to the alias resolver. A model whose dispatch runs as
 * a local CLI process has no cloud placement capability, so it is rejected
 * before persistence instead of being misread as the built-in `openclaw`
 * worker-turn runtime.
 */
export function resolveWorkerPlacementSessionRuntimeCapabilities(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentId: string;
  sessionKey: string;
}): {
  executionMode?: WorkerPlacementExecutionMode;
  devicePlacement?: NonNullable<GatewayAgentRuntime["devicePlacement"]>;
} {
  const selectedModel = resolveSessionModelRef(params.cfg, params.entry, params.agentId);
  // Resolve the same session runtime override and pinned-harness state the
  // dispatch path consults, so an explicit non-CLI override (e.g.
  // agentRuntimeOverride="openclaw") bypasses CLI aliasing instead of being
  // rejected before the override takes effect.
  const sessionRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
    provider: selectedModel.provider,
    entry: params.entry,
    cfg: params.cfg,
  });
  const pinnedHarnessId = resolveSessionPinnedHarnessId(params.entry);
  const locksPersistedHarness =
    pinnedHarnessId !== undefined && pinnedHarnessId === sessionRuntimeOverride;
  const pinnedCliRuntime =
    !locksPersistedHarness &&
    sessionRuntimeOverride &&
    isCliProvider(sessionRuntimeOverride, params.cfg)
      ? sessionRuntimeOverride
      : undefined;
  // When a non-CLI override is active the dispatch path skips CLI aliasing
  // entirely and runs the embedded runtime; the guard must not reject that.
  const cliExecutionProvider =
    pinnedCliRuntime ??
    (sessionRuntimeOverride
      ? undefined
      : resolveCliRuntimeExecutionProvider({
          provider: selectedModel.provider,
          cfg: params.cfg,
          agentId: params.agentId,
          modelId: selectedModel.model,
          authProfileId: params.entry.authProfileOverride,
        }));
  const useCliExecution =
    pinnedCliRuntime !== undefined ||
    (!sessionRuntimeOverride &&
      isCliProvider(cliExecutionProvider ?? selectedModel.provider, params.cfg));
  if (useCliExecution) {
    return {};
  }
  const runtime = resolveEffectiveAgentRuntime({
    cfg: params.cfg,
    provider: selectedModel.provider,
    modelId: selectedModel.model,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionEntry: params.entry,
  });
  return resolveWorkerPlacementCapabilities(runtime);
}

export function projectWorkerPlacementAgentRuntime(
  runtime: GatewayAgentRuntime,
): GatewayAgentRuntime & {
  cloudPlacementSupported: boolean;
  cloudPlacementExecutionMode?: WorkerPlacementExecutionMode;
  devicePlacement?: NonNullable<GatewayAgentRuntime["devicePlacement"]>;
  devicePlacementSupported: boolean;
} {
  const { source, ...identity } = runtime;
  const { executionMode, devicePlacement } = resolveWorkerPlacementCapabilities(runtime.id);
  return {
    ...identity,
    cloudPlacementSupported: executionMode !== undefined,
    ...(executionMode ? { cloudPlacementExecutionMode: executionMode } : {}),
    ...(devicePlacement ? { devicePlacement } : {}),
    devicePlacementSupported: devicePlacement !== undefined,
    source,
  };
}
