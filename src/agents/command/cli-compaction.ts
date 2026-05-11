import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { AgentCompactionMode } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ensureContextEnginesInitialized as ensureContextEnginesInitializedImpl } from "../../context-engine/init.js";
import { resolveContextEngine as resolveContextEngineImpl } from "../../context-engine/registry.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { buildEmbeddedCompactionRuntimeContext } from "../pi-embedded-runner/compaction-runtime-context.js";
import { runContextEngineMaintenance as runContextEngineMaintenanceImpl } from "../pi-embedded-runner/context-engine-maintenance.js";
import { shouldPreemptivelyCompactBeforePrompt as shouldPreemptivelyCompactBeforePromptImpl } from "../pi-embedded-runner/run/preemptive-compaction.js";
import { resolveLiveToolResultMaxChars as resolveLiveToolResultMaxCharsImpl } from "../pi-embedded-runner/tool-result-truncation.js";
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
  recordCliCompactionInStore: typeof recordCliCompactionInStoreImpl;
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
}) {
  const runtimeContext = {
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
    trigger: "cli_budget",
  };

  const compactResult = await params.contextEngine.compact({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    tokenBudget: params.contextTokenBudget,
    currentTokenCount: params.currentTokenCount,
    force: true,
    compactionTarget: "budget",
    runtimeContext,
  });

  if (!compactResult.compacted) {
    log.warn(
      `CLI transcript compaction did not reduce context for ${params.provider}/${params.model}: ${compactResult.reason ?? "nothing to compact"}`,
    );
    return false;
  }

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
  return true;
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

  cliCompactionDeps.ensureContextEnginesInitialized();
  const contextEngine = await cliCompactionDeps.resolveContextEngine(params.cfg);
  const sessionManager = cliCompactionDeps.openSessionManager(sessionFile);
  const settingsManager = await cliCompactionDeps.createPreparedEmbeddedPiSettingsManager({
    cwd: params.workspaceDir,
    agentDir: params.agentDir,
    cfg: params.cfg,
    contextTokenBudget,
  });
  await cliCompactionDeps.applyPiAutoCompactionGuard({
    settingsManager,
    contextEngineInfo: contextEngine.info,
    compactionMode: resolveEffectiveCompactionMode(params.cfg),
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

  const compacted = await compactCliTranscript({
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
  });

  if (!compacted || !params.sessionStore || !params.storePath) {
    return params.sessionEntry;
  }

  return (
    (await cliCompactionDeps.recordCliCompactionInStore({
      provider: params.provider,
      sessionKey: params.sessionKey,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
    })) ?? params.sessionEntry
  );
}
