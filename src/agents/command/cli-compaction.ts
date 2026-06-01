import type { SessionEntry } from "../../config/sessions/types.js";
import type { AgentCompactionMode } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureContextEnginesInitialized as ensureContextEnginesInitializedImpl } from "../../context-engine/init.js";
import { resolveContextEngine as resolveContextEngineImpl } from "../../context-engine/registry.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SkillSnapshot } from "../../skills/types.js";
import { createPreparedEmbeddedAgentSettingsManager as createPreparedEmbeddedAgentSettingsManagerImpl } from "../agent-project-settings.js";
import { OPENCLAW_AGENT_RUNTIME_ID } from "../agent-runtime-id.js";
import { normalizeOptionalAgentRuntimeId } from "../agent-runtime-id.js";
import {
  applyAgentAutoCompactionGuard as applyAgentAutoCompactionGuardImpl,
  resolveEffectiveCompactionMode,
} from "../agent-settings.js";
import { classifyCompactionReason } from "../embedded-agent-runner/compact-reasons.js";
import { buildEmbeddedCompactionRuntimeContext } from "../embedded-agent-runner/compaction-runtime-context.js";
import {
  compactContextEngineWithSafetyTimeout,
  compactWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "../embedded-agent-runner/compaction-safety-timeout.js";
import { runContextEngineMaintenance as runContextEngineMaintenanceImpl } from "../embedded-agent-runner/context-engine-maintenance.js";
import { shouldPreemptivelyCompactBeforePrompt as shouldPreemptivelyCompactBeforePromptImpl } from "../embedded-agent-runner/run/preemptive-compaction.js";
import { resolveLiveToolResultMaxChars as resolveLiveToolResultMaxCharsImpl } from "../embedded-agent-runner/tool-result-truncation.js";
import type { EmbeddedAgentCompactResult } from "../embedded-agent-runner/types.js";
import { isRecoverableNativeHarnessBindingFailure } from "../harness/compaction-recovery.js";
import { ensureSelectedAgentHarnessPlugin as ensureSelectedAgentHarnessPluginImpl } from "../harness/runtime-plugin.js";
import { maybeCompactAgentHarnessSession as maybeCompactAgentHarnessSessionImpl } from "../harness/selection.js";
import type { AgentMessage } from "../runtime/index.js";
import { SessionManager } from "../sessions/session-manager.js";
import {
  clearCliSessionInStore as clearCliSessionInStoreImpl,
  recordCliCompactionInStore as recordCliCompactionInStoreImpl,
} from "./session-store.js";

const CODEX_APP_SERVER_OWNS_AUTO_COMPACTION_REASON = "codex app-server owns automatic compaction";

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
  createPreparedEmbeddedAgentSettingsManager: (params: {
    cwd: string;
    agentDir: string;
    cfg?: OpenClawConfig;
    contextTokenBudget?: number;
  }) => SettingsManagerLike | Promise<SettingsManagerLike>;
  applyAgentAutoCompactionGuard: (params: {
    settingsManager: SettingsManagerLike;
    contextEngineInfo?: ContextEngine["info"];
    compactionMode?: AgentCompactionMode;
  }) => unknown;
  shouldPreemptivelyCompactBeforePrompt: typeof shouldPreemptivelyCompactBeforePromptImpl;
  resolveLiveToolResultMaxChars: typeof resolveLiveToolResultMaxCharsImpl;
  runContextEngineMaintenance: typeof runContextEngineMaintenanceImpl;
  ensureSelectedAgentHarnessPlugin: typeof ensureSelectedAgentHarnessPluginImpl;
  maybeCompactAgentHarnessSession: typeof maybeCompactAgentHarnessSessionImpl;
  clearCliSessionInStore: typeof clearCliSessionInStoreImpl;
  recordCliCompactionInStore: typeof recordCliCompactionInStoreImpl;
};

type NativeHarnessCliCompactionOutcome = {
  compacted: boolean;
  result?: EmbeddedAgentCompactResult;
  fallbackToContextEngine?: boolean;
  clearCliSessionBinding?: boolean;
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
  authProfileId?: string;
  workspaceDir: string;
  cwd?: string;
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
  createPreparedEmbeddedAgentSettingsManager: createPreparedEmbeddedAgentSettingsManagerImpl,
  applyAgentAutoCompactionGuard: applyAgentAutoCompactionGuardImpl,
  shouldPreemptivelyCompactBeforePrompt: shouldPreemptivelyCompactBeforePromptImpl,
  resolveLiveToolResultMaxChars: resolveLiveToolResultMaxCharsImpl,
  runContextEngineMaintenance: runContextEngineMaintenanceImpl,
  ensureSelectedAgentHarnessPlugin: ensureSelectedAgentHarnessPluginImpl,
  maybeCompactAgentHarnessSession: maybeCompactAgentHarnessSessionImpl,
  clearCliSessionInStore: clearCliSessionInStoreImpl,
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
    createPreparedEmbeddedAgentSettingsManager: createPreparedEmbeddedAgentSettingsManagerImpl,
    applyAgentAutoCompactionGuard: applyAgentAutoCompactionGuardImpl,
    shouldPreemptivelyCompactBeforePrompt: shouldPreemptivelyCompactBeforePromptImpl,
    resolveLiveToolResultMaxChars: resolveLiveToolResultMaxCharsImpl,
    runContextEngineMaintenance: runContextEngineMaintenanceImpl,
    ensureSelectedAgentHarnessPlugin: ensureSelectedAgentHarnessPluginImpl,
    maybeCompactAgentHarnessSession: maybeCompactAgentHarnessSessionImpl,
    clearCliSessionInStore: clearCliSessionInStoreImpl,
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
  if (!harnessId || normalizeOptionalAgentRuntimeId(harnessId) === OPENCLAW_AGENT_RUNTIME_ID) {
    return false;
  }
  const providerId = provider.trim().toLowerCase();
  return (
    harnessId === providerId ||
    (harnessId === "copilot" && providerId === "github-copilot") ||
    (harnessId === "codex" && (providerId === "codex" || providerId === "openai"))
  );
}

function isUnsupportedNativeHarnessCompaction(
  result: EmbeddedAgentCompactResult | undefined,
): boolean {
  return result?.ok === false && result.failure?.reason === "unsupported_harness_compaction";
}

function isBelowCompactionTargetReason(reason: string | undefined): boolean {
  return classifyCompactionReason(reason) === "below_threshold";
}

function isIntentionalNativeAutoCompactionSkip(
  result: EmbeddedAgentCompactResult | undefined,
): boolean {
  return (
    result?.ok === true &&
    !result.compacted &&
    result.reason === CODEX_APP_SERVER_OWNS_AUTO_COMPACTION_REASON
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
      authProfileId: params.authProfileId,
      workspaceDir: params.workspaceDir,
      cwd: params.cwd,
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
  cwd?: string;
  agentDir: string;
  provider: string;
  model: string;
  contextTokenBudget: number;
  currentTokenCount: number;
  skillsSnapshot?: SkillSnapshot;
  messageChannel?: string;
  agentAccountId?: string;
  authProfileId?: string;
  senderIsOwner?: boolean;
  thinkLevel?: Parameters<typeof buildEmbeddedCompactionRuntimeContext>[0]["thinkLevel"];
  extraSystemPrompt?: string;
  bestEffortMaintenance?: boolean;
}): Promise<CliTranscriptCompactionOutcome> {
  const runtimeContext = buildCliCompactionRuntimeContext({
    sessionKey: params.sessionKey,
    messageChannel: params.messageChannel,
    agentAccountId: params.agentAccountId,
    authProfileId: params.authProfileId,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
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
    const reason = compactResult.reason ?? "nothing to compact";
    if (isBelowCompactionTargetReason(reason)) {
      log.info(
        `CLI transcript compaction skipped for ${params.provider}/${params.model}: ${reason}`,
      );
      return { compacted: false };
    }
    log.warn(
      `CLI transcript compaction did not reduce context for ${params.provider}/${params.model}: ${reason}`,
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
  cwd?: string;
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
  let result: EmbeddedAgentCompactResult | undefined;
  try {
    const sessionAgentId = readAgentIdFromSessionKey(params.sessionKey);
    const nativeHarnessId = params.sessionEntry.agentHarnessId?.trim();
    const authProfileId = params.sessionEntry.authProfileOverride?.trim() || undefined;
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
          cwd: params.cwd,
          agentDir: params.agentDir,
          config: params.cfg,
          skillsSnapshot: params.skillsSnapshot,
          provider: params.provider,
          model: params.model,
          authProfileId,
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
                  authProfileId,
                  workspaceDir: params.workspaceDir,
                  cwd: params.cwd,
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
    const reason = result?.reason ?? "nothing to compact";
    if (isBelowCompactionTargetReason(reason)) {
      log.info(
        `CLI native harness compaction skipped for ${params.provider}/${params.model}: ${reason}`,
      );
      return { compacted: false };
    }
    if (isIntentionalNativeAutoCompactionSkip(result)) {
      return {
        compacted: false,
        fallbackToContextEngine: true,
        failureReason: CODEX_APP_SERVER_OWNS_AUTO_COMPACTION_REASON,
      };
    }
    const recoverableBindingFailure = isRecoverableNativeHarnessBindingFailure(result);
    const fallbackToContextEngine =
      isUnsupportedNativeHarnessCompaction(result) || recoverableBindingFailure;
    log.warn(
      `CLI native harness compaction did not reduce context for ${params.provider}/${params.model}: ${reason}`,
    );
    return {
      compacted: false,
      fallbackToContextEngine,
      clearCliSessionBinding: recoverableBindingFailure,
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
  cwd?: string;
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
  const settingsManager = await cliCompactionDeps.createPreparedEmbeddedAgentSettingsManager({
    cwd: params.cwd ?? params.workspaceDir,
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
  let nativeCompactionResult: EmbeddedAgentCompactResult | undefined;
  let useContextEngineCompaction = true;
  let nativeFallbackToContextEngine = false;
  let nativeFallbackNeedsBindingClear = false;
  let resolvedContextEngine: ContextEngine | undefined;
  let autoCompactionGuardApplied = false;
  const authProfileId = params.sessionEntry?.authProfileOverride?.trim() || undefined;
  const applyAutoCompactionGuard = async (contextEngine: ContextEngine): Promise<void> => {
    if (autoCompactionGuardApplied) {
      return;
    }
    autoCompactionGuardApplied = true;
    await cliCompactionDeps.applyAgentAutoCompactionGuard({
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
      cwd: params.cwd,
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
    } else if (nativeOutcome.fallbackToContextEngine) {
      nativeFallbackToContextEngine = true;
      nativeFallbackNeedsBindingClear = nativeOutcome.clearCliSessionBinding === true;
    } else if (nativeOutcome.failureReason) {
      throw new Error(
        `CLI native harness compaction failed for ${params.provider}/${params.model}: ${
          nativeOutcome.failureReason ?? "compaction did not reduce context"
        }`,
      );
    } else {
      useContextEngineCompaction = false;
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
      cwd: params.cwd,
      agentDir: params.agentDir,
      provider: params.provider,
      model: params.model,
      contextTokenBudget,
      currentTokenCount,
      skillsSnapshot: params.skillsSnapshot,
      messageChannel: params.messageChannel,
      agentAccountId: params.agentAccountId,
      authProfileId,
      senderIsOwner: params.senderIsOwner,
      thinkLevel: params.thinkLevel,
      extraSystemPrompt: params.extraSystemPrompt,
      bestEffortMaintenance: nativeFallbackToContextEngine,
    });
    compacted = contextOutcome.compacted;
    if (!compacted && contextOutcome.failureReason) {
      throw new Error(
        `CLI transcript compaction failed for ${params.provider}/${params.model}: ${
          contextOutcome.failureReason ?? "compaction did not reduce context"
        }`,
      );
    }
  }

  if (nativeFallbackNeedsBindingClear && !compacted && params.sessionStore && params.storePath) {
    return (
      (await cliCompactionDeps.clearCliSessionInStore({
        provider: params.provider,
        sessionKey: params.sessionKey,
        sessionStore: params.sessionStore,
        storePath: params.storePath,
      })) ?? params.sessionEntry
    );
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
