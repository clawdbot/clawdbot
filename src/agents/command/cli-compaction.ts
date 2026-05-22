import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { AgentCompactionMode } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureContextEnginesInitialized as ensureContextEnginesInitializedImpl } from "../../context-engine/init.js";
import { resolveContextEngine as resolveContextEngineImpl } from "../../context-engine/registry.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ensureSelectedAgentHarnessPlugin as ensureSelectedAgentHarnessPluginImpl } from "../harness/runtime-plugin.js";
import { maybeCompactAgentHarnessSession as maybeCompactAgentHarnessSessionImpl } from "../harness/selection.js";
import { buildEmbeddedCompactionRuntimeContext } from "../pi-embedded-runner/compaction-runtime-context.js";
import {
  compactContextEngineWithSafetyTimeout,
  compactWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "../pi-embedded-runner/compaction-safety-timeout.js";
import { runContextEngineMaintenance as runContextEngineMaintenanceImpl } from "../pi-embedded-runner/context-engine-maintenance.js";
import { shouldPreemptivelyCompactBeforePrompt as shouldPreemptivelyCompactBeforePromptImpl } from "../pi-embedded-runner/run/preemptive-compaction.js";
import { resolveLiveToolResultMaxChars as resolveLiveToolResultMaxCharsImpl } from "../pi-embedded-runner/tool-result-truncation.js";
import type { EmbeddedPiCompactResult } from "../pi-embedded-runner/types.js";
import { createPreparedEmbeddedPiSettingsManager as createPreparedEmbeddedPiSettingsManagerImpl } from "../pi-project-settings.js";
import {
  applyPiAutoCompactionGuard as applyPiAutoCompactionGuardImpl,
  resolveEffectiveCompactionMode,
} from "../pi-settings.js";
import type { SkillSnapshot } from "../skills.js";
import { recordCliCompactionInStore as recordCliCompactionInStoreImpl } from "./session-store.js";

type SessionManagerLike = ReturnType<typeof SessionManager.open>;
type SettingsManagerLike = {
  getCompactionReserveTokens: () => number;
  getCompactionKeepRecentTokens: () => number;
  applyOverrides: (overrides: {
    compaction: {
      reserveTokens?: number;
      keepRecentTokens?: number;
    };
  }) => void;
  setCompactionEnabled?: (enabled: boolean) => void;
};
type CliCompactionDeps = {
  openSessionManager: (sessionFile: string) => SessionManagerLike;
  ensureContextEnginesInitialized: () => void;
  resolveContextEngine: (cfg: OpenClawConfig) => Promise<ContextEngine>;
  createPreparedEmbeddedPiSettingsManager: (params: {
    cwd: string;
    agentDir: string;
    cfg?: OpenClawConfig;
    contextTokenBudget?: number;
  }) => SettingsManagerLike | Promise<SettingsManagerLike>;
  applyPiAutoCompactionGuard: (params: {
    settingsManager: SettingsManagerLike;
    contextEngineInfo?: ContextEngine["info"];
    compactionMode?: AgentCompactionMode;
  }) => unknown;
  shouldPreemptivelyCompactBeforePrompt: typeof shouldPreemptivelyCompactBeforePromptImpl;
  resolveLiveToolResultMaxChars: typeof resolveLiveToolResultMaxCharsImpl;
  runContextEngineMaintenance: typeof runContextEngineMaintenanceImpl;
  ensureSelectedAgentHarnessPlugin: typeof ensureSelectedAgentHarnessPluginImpl;
  maybeCompactAgentHarnessSession: typeof maybeCompactAgentHarnessSessionImpl;
  recordCliCompactionInStore: typeof recordCliCompactionInStoreImpl;
};

type NativeHarnessCliCompactionOutcome = {
  compacted: boolean;
  result?: EmbeddedPiCompactResult;
  fallbackToContextEngine?: boolean;
  failureReason?: string;
};
type CliTranscriptCompactionOutcome = {
  compacted: boolean;
  failureReason?: string;
};
type CliCompactionRuntimeContextParams = {
  sessionKey: string;
  messageChannel?: string;
  agentAccountId?: string;
  workspaceDir: string;
  agentDir: string;
  cfg: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  senderIsOwner?: boolean;
  provider: string;
  model: string;
  thinkLevel?: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["thinkLevel"];
  extraSystemPrompt?: string;
  currentTokenCount: number;
  contextTokenBudget: number;
  trigger: string;
};

const log = createSubsystemLogger("agents/cli-compaction");

const cliCompactionDeps: CliCompactionDeps = {
  openSessionManager: (sessionFile: string) => SessionManager.open(sessionFile),
  ensureContextEnginesInitialized: ensureContextEnginesInitializedImpl,
  resolveContextEngine: resolveContextEngineImpl,
  createPreparedEmbeddedPiSettingsManager: createPreparedEmbeddedPiSettingsManagerImpl,
  applyPiAutoCompactionGuard: applyPiAutoCompactionGuardImpl,
  shouldPreemptivelyCompactBeforePrompt: shouldPreemptivelyCompactBeforePromptImpl,
  resolveLiveToolResultMaxChars: resolveLiveToolResultMaxCharsImpl,
  runContextEngineMaintenance: runContextEngineMaintenanceImpl,
  ensureSelectedAgentHarnessPlugin: ensureSelectedAgentHarnessPluginImpl,
  maybeCompactAgentHarnessSession: maybeCompactAgentHarnessSessionImpl,
  recordCliCompactionInStore: recordCliCompactionInStoreImpl,
};

export function setCliCompactionTestDeps(overrides: Partial<typeof cliCompactionDeps>): void {
  Object.assign(cliCompactionDeps, overrides);
}

export function resetCliCompactionTestDeps(): void {
  Object.assign(cliCompactionDeps, {
    openSessionManager: (sessionFile: string) => SessionManager.open(sessionFile),
    ensureContextEnginesInitialized: ensureContextEnginesInitializedImpl,
    resolveContextEngine: resolveContextEngineImpl,
    createPreparedEmbeddedPiSettingsManager: createPreparedEmbeddedPiSettingsManagerImpl,
    applyPiAutoCompactionGuard: applyPiAutoCompactionGuardImpl,
    shouldPreemptivelyCompactBeforePrompt: shouldPreemptivelyCompactBeforePromptImpl,
    resolveLiveToolResultMaxChars: resolveLiveToolResultMaxCharsImpl,
    runContextEngineMaintenance: runContextEngineMaintenanceImpl,
    ensureSelectedAgentHarnessPlugin: ensureSelectedAgentHarnessPluginImpl,
    maybeCompactAgentHarnessSession: maybeCompactAgentHarnessSessionImpl,
    recordCliCompactionInStore: recordCliCompactionInStoreImpl,
  });
}

function resolvePositiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function getSessionBranchMessages(sessionManager: SessionManagerLike): AgentMessage[] {
  return sessionManager
    .getBranch()
    .flatMap((entry) =>
      entry.type === "message" && typeof entry.message === "object" && entry.message !== null
        ? [entry.message]
        : [],
    );
}

function resolveSessionTokenSnapshot(sessionEntry: SessionEntry | undefined): number | undefined {
  return resolvePositiveInteger(
    sessionEntry?.totalTokensFresh === false ? undefined : sessionEntry?.totalTokens,
  );
}

function isNativeHarnessCompactionSession(
  sessionEntry: SessionEntry | undefined,
  provider: string,
): sessionEntry is SessionEntry {
  const harnessId = sessionEntry?.agentHarnessId?.trim().toLowerCase();
  if (!harnessId || harnessId === "pi") {
    return false;
  }
  const providerId = provider.trim().toLowerCase();
  return (
    harnessId === providerId ||
    (harnessId === "codex" &&
      (providerId === "codex" || providerId === "openai" || providerId === "openai-codex"))
  );
}

function isUnsupportedNativeHarnessCompaction(
  result: EmbeddedPiCompactResult | undefined,
): boolean {
  return result?.ok === false && result.failure?.reason === "unsupported_harness_compaction";
}

function isRecoverableNativeHarnessCompactionFailure(
  result: EmbeddedPiCompactResult | undefined,
): boolean {
  return (
    result?.ok === false &&
    (result.failure?.reason === "missing_thread_binding" ||
      result.failure?.reason === "stale_thread_binding")
  );
}

function readAgentIdFromSessionKey(sessionKey: string): string | undefined {
  const parts = sessionKey.trim().split(":");
  return parts[0] === "agent" && parts[1]?.trim() ? parts[1].trim() : undefined;
}

function buildCliCompactionRuntimeContext(params: CliCompactionRuntimeContextParams) {
  return {
    ...buildEmbeddedCompactionRuntimeContext({
      sessionKey: params.sessionKey,
      messageChannel: params.messageChannel,
      messageProvider: params.messageChannel,
      agentAccountId: params.agentAccountId,
      authProfileId: undefined,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      config: params.cfg,
      skillsSnapshot: params.skillsSnapshot,
      senderIsOwner: params.senderIsOwner,
      provider: params.provider,
      modelId: params.model,
      thinkLevel: params.thinkLevel,
      extraSystemPrompt: params.extraSystemPrompt,
    }),
    currentTokenCount: params.currentTokenCount,
    tokenBudget: params.contextTokenBudget,
    trigger: params.trigger,
  };
}

async function compactCliTranscript(params: {
  contextEngine: ContextEngine;
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  sessionManager: SessionManagerLike;
  cfg: OpenClawConfig;
  workspaceDir: string;
  agentDir: string;
  provider: string;
  model: string;
  contextTokenBudget: number;
  currentTokenCount: number;
  skillsSnapshot?: SkillSnapshot;
  messageChannel?: string;
  agentAccountId?: string;
  senderIsOwner?: boolean;
  thinkLevel?: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["thinkLevel"];
  extraSystemPrompt?: string;
  bestEffortMaintenance?: boolean;
}): Promise<CliTranscriptCompactionOutcome> {
  const runtimeContext = buildCliCompactionRuntimeContext({
    sessionKey: params.sessionKey,
    messageChannel: params.messageChannel,
    agentAccountId: params.agentAccountId,
    workspaceDir: params.workspaceDir,
    agentDir: params.agentDir,
    cfg: params.cfg,
    skillsSnapshot: params.skillsSnapshot,
    senderIsOwner: params.senderIsOwner,
    provider: params.provider,
    model: params.model,
    thinkLevel: params.thinkLevel,
    extraSystemPrompt: params.extraSystemPrompt,
    currentTokenCount: params.currentTokenCount,
    contextTokenBudget: params.contextTokenBudget,
    trigger: "cli_budget",
  });

  let compactResult: Awaited<ReturnType<typeof params.contextEngine.compact>>;
  try {
    compactResult = await compactContextEngineWithSafetyTimeout(
      params.contextEngine,
      {
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        tokenBudget: params.contextTokenBudget,
        currentTokenCount: params.currentTokenCount,
        force: true,
        compactionTarget: "budget",
        runtimeContext,
      },
      resolveCompactionTimeoutMs(params.cfg),
    );
  } catch (error) {
    log.warn(
      `CLI transcript compaction failed for ${params.provider}/${params.model}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      compacted: false,
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!compactResult.compacted) {
    log.warn(
      `CLI transcript compaction did not reduce context for ${params.provider}/${params.model}: ${compactResult.reason ?? "nothing to compact"}`,
    );
    return {
      compacted: false,
      failureReason: compactResult.reason ?? "compaction did not reduce context",
    };
  }

  try {
    await cliCompactionDeps.runContextEngineMaintenance({
      contextEngine: params.contextEngine,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      reason: "compaction",
      sessionManager: params.sessionManager,
      runtimeContext,
      config: params.cfg,
    });
  } catch (error) {
    if (!params.bestEffortMaintenance) {
      throw error;
    }
    log.warn(
      `CLI transcript compaction maintenance failed after fallback for ${params.provider}/${params.model}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { compacted: true };
}

async function compactNativeHarnessCliTranscript(params: {
  cfg: OpenClawConfig;
  sessionId: string;
  sessionKey: string;
  sessionFile: string;
  sessionEntry: SessionEntry;
  workspaceDir: string;
  agentDir: string;
  provider: string;
  model: string;
  contextTokenBudget: number;
  currentTokenCount: number;
  contextEngine?: ContextEngine;
  skillsSnapshot?: SkillSnapshot;
  messageChannel?: string;
  agentAccountId?: string;
  senderIsOwner?: boolean;
  thinkLevel?: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["thinkLevel"];
  extraSystemPrompt?: string;
}): Promise<NativeHarnessCliCompactionOutcome> {
  let result: EmbeddedPiCompactResult | undefined;
  try {
    const sessionAgentId = readAgentIdFromSessionKey(params.sessionKey);
    const nativeHarnessId = params.sessionEntry.agentHarnessId?.trim();
    await cliCompactionDeps.ensureSelectedAgentHarnessPlugin({
      provider: params.provider,
      modelId: params.model,
      config: params.cfg,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      ...(sessionAgentId ? { agentId: sessionAgentId } : {}),
      ...(nativeHarnessId ? { agentHarnessRuntimeOverride: nativeHarnessId } : {}),
    });
    result = await compactWithSafetyTimeout(
      (abortSignal) =>
        cliCompactionDeps.maybeCompactAgentHarnessSession({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionFile: params.sessionFile,
          workspaceDir: params.workspaceDir,
          agentDir: params.agentDir,
          config: params.cfg,
          skillsSnapshot: params.skillsSnapshot,
          provider: params.provider,
          model: params.model,
          contextTokenBudget: params.contextTokenBudget,
          currentTokenCount: params.currentTokenCount,
          trigger: "budget",
          force: true,
          messageChannel: params.messageChannel,
          agentAccountId: params.agentAccountId,
          senderIsOwner: params.senderIsOwner,
          thinkLevel: params.thinkLevel,
          extraSystemPrompt: params.extraSystemPrompt,
          allowGatewaySubagentBinding: true,
          ...(params.contextEngine
            ? {
                contextEngine: params.contextEngine,
                contextEngineRuntimeContext: buildCliCompactionRuntimeContext({
                  sessionKey: params.sessionKey,
                  messageChannel: params.messageChannel,
                  agentAccountId: params.agentAccountId,
                  workspaceDir: params.workspaceDir,
                  agentDir: params.agentDir,
                  cfg: params.cfg,
                  skillsSnapshot: params.skillsSnapshot,
                  senderIsOwner: params.senderIsOwner,
                  provider: params.provider,
                  model: params.model,
                  thinkLevel: params.thinkLevel,
                  extraSystemPrompt: params.extraSystemPrompt,
                  currentTokenCount: params.currentTokenCount,
                  contextTokenBudget: params.contextTokenBudget,
                  trigger: "cli_native_budget",
                }),
              }
            : {}),
          ...(nativeHarnessId ? { agentHarnessId: nativeHarnessId } : {}),
          ...(abortSignal ? { abortSignal } : {}),
        }),
      resolveCompactionTimeoutMs(params.cfg),
    );
  } catch (error) {
    log.warn(
      `CLI native harness compaction failed for ${params.provider}/${params.model}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      compacted: false,
      failureReason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!result?.compacted) {
    const fallbackToContextEngine =
      isUnsupportedNativeHarnessCompaction(result) ||
      isRecoverableNativeHarnessCompactionFailure(result);
    log.warn(
      `CLI native harness compaction did not reduce context for ${params.provider}/${params.model}: ${result?.reason ?? "nothing to compact"}`,
    );
    return {
      compacted: false,
      fallbackToContextEngine,
      failureReason: result?.reason ?? "native harness compaction did not reduce context",
    };
  }

  return { compacted: true, result };
}

export async function runCliTurnCompactionLifecycle(params: {
  cfg: OpenClawConfig;
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore?: Record<string, SessionEntry>;
  storePath?: string;
  sessionAgentId: string;
  workspaceDir: string;
  agentDir: string;
  provider: string;
  model: string;
  skillsSnapshot?: SkillSnapshot;
  messageChannel?: string;
  agentAccountId?: string;
  senderIsOwner?: boolean;
  thinkLevel?: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["thinkLevel"];
  extraSystemPrompt?: string;
}): Promise<SessionEntry | undefined> {
  const sessionFile = params.sessionEntry?.sessionFile;
  const contextTokenBudget = resolvePositiveInteger(params.sessionEntry?.contextTokens);
  if (!sessionFile || !contextTokenBudget) {
    return params.sessionEntry;
  }

  const sessionManager = cliCompactionDeps.openSessionManager(sessionFile);
  const settingsManager = await cliCompactionDeps.createPreparedEmbeddedPiSettingsManager({
    cwd: params.workspaceDir,
    agentDir: params.agentDir,
    cfg: params.cfg,
    contextTokenBudget,
  });

  const preemptiveCompaction = cliCompactionDeps.shouldPreemptivelyCompactBeforePrompt({
    messages: getSessionBranchMessages(sessionManager),
    prompt: "",
    contextTokenBudget,
    reserveTokens: settingsManager.getCompactionReserveTokens(),
    toolResultMaxChars: cliCompactionDeps.resolveLiveToolResultMaxChars({
      contextWindowTokens: contextTokenBudget,
      cfg: params.cfg,
      agentId: params.sessionAgentId,
    }),
  });
  const tokenSnapshot = resolveSessionTokenSnapshot(params.sessionEntry);
  const currentTokenCount = Math.max(
    preemptiveCompaction.estimatedPromptTokens,
    tokenSnapshot ?? 0,
  );
  if (
    !preemptiveCompaction.shouldCompact &&
    currentTokenCount <= preemptiveCompaction.promptBudgetBeforeReserve
  ) {
    return params.sessionEntry;
  }

  let compacted = false;
  let nativeCompactionResult: EmbeddedPiCompactResult | undefined;
  let useContextEngineCompaction = true;
  let nativeFallbackToContextEngine = false;
  let resolvedContextEngine: ContextEngine | undefined;
  let autoCompactionGuardApplied = false;
  const applyAutoCompactionGuard = async (contextEngine: ContextEngine): Promise<void> => {
    if (autoCompactionGuardApplied) {
      return;
    }
    autoCompactionGuardApplied = true;
    await cliCompactionDeps.applyPiAutoCompactionGuard({
      settingsManager,
      contextEngineInfo: contextEngine.info,
      compactionMode: resolveEffectiveCompactionMode(params.cfg),
    });
  };

  if (isNativeHarnessCompactionSession(params.sessionEntry, params.provider)) {
    cliCompactionDeps.ensureContextEnginesInitialized();
    resolvedContextEngine = await cliCompactionDeps.resolveContextEngine(params.cfg);
    await applyAutoCompactionGuard(resolvedContextEngine);
    const nativeOutcome = await compactNativeHarnessCliTranscript({
      cfg: params.cfg,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile,
      sessionEntry: params.sessionEntry,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      provider: params.provider,
      model: params.model,
      contextTokenBudget,
      currentTokenCount,
      contextEngine: resolvedContextEngine,
      skillsSnapshot: params.skillsSnapshot,
      messageChannel: params.messageChannel,
      agentAccountId: params.agentAccountId,
      senderIsOwner: params.senderIsOwner,
      thinkLevel: params.thinkLevel,
      extraSystemPrompt: params.extraSystemPrompt,
    });
    if (nativeOutcome.compacted) {
      compacted = true;
      nativeCompactionResult = nativeOutcome.result;
      useContextEngineCompaction = false;
    } else if (!nativeOutcome.fallbackToContextEngine) {
      throw new Error(
        `CLI native harness compaction failed for ${params.provider}/${params.model}: ${
          nativeOutcome.failureReason ?? "compaction did not reduce context"
        }`,
      );
    } else {
      nativeFallbackToContextEngine = true;
    }
  }

  if (useContextEngineCompaction) {
    if (!resolvedContextEngine) {
      cliCompactionDeps.ensureContextEnginesInitialized();
      resolvedContextEngine = await cliCompactionDeps.resolveContextEngine(params.cfg);
    }
    const contextEngine = resolvedContextEngine;
    await applyAutoCompactionGuard(contextEngine);

    const contextOutcome = await compactCliTranscript({
      contextEngine,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile,
      sessionManager,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      provider: params.provider,
      model: params.model,
      contextTokenBudget,
      currentTokenCount,
      skillsSnapshot: params.skillsSnapshot,
      messageChannel: params.messageChannel,
      agentAccountId: params.agentAccountId,
      senderIsOwner: params.senderIsOwner,
      thinkLevel: params.thinkLevel,
      extraSystemPrompt: params.extraSystemPrompt,
      bestEffortMaintenance: nativeFallbackToContextEngine,
    });
    compacted = contextOutcome.compacted;
    if (!compacted) {
      throw new Error(
        `CLI transcript compaction failed for ${params.provider}/${params.model}: ${
          contextOutcome.failureReason ?? "compaction did not reduce context"
        }`,
      );
    }
  }

  if (!compacted || !params.sessionStore || !params.storePath) {
    return params.sessionEntry;
  }

  return (
    (await cliCompactionDeps.recordCliCompactionInStore({
      provider: params.provider,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
      tokensAfter: nativeCompactionResult?.result?.tokensAfter,
      newSessionId: nativeCompactionResult?.result?.sessionId,
      newSessionFile: nativeCompactionResult?.result?.sessionFile,
    })) ?? params.sessionEntry
  );
}
