import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import type { SkillSnapshot } from "../../agents/skills.js";
import { normalizeToolList } from "../../agents/tool-policy.js";
import type { ThinkLevel, VerboseLevel } from "../../auto-reply/thinking.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import type { CronAgentExecutionPhaseUpdate, CronJob } from "../types.js";
import {
  resolveCronChannelOutputPolicy,
  resolveCurrentChannelTarget,
} from "./channel-output-policy.js";
import { resolveCronPayloadOutcome } from "./helpers.js";
import {
  getCliSessionId,
  isCliProvider,
  LiveSessionModelSwitchError,
  logWarn,
  normalizeVerboseLevel,
  registerAgentRunContext,
  resolveBootstrapWarningSignaturesSeen,
  resolveCronAgentLane,
  resolveSessionTranscriptPath,
  runCliAgent,
  runWithModelFallback,
} from "./run-execution.runtime.js";
import { resolveCronFallbacksOverride } from "./run-fallback-policy.js";
import type {
  CronLiveSelection,
  MutableCronSession,
  PersistCronSessionEntry,
} from "./run-session-state.js";
import { syncCronSessionLiveSelection } from "./run-session-state.js";
import { isLikelyInterimCronMessage } from "./subagent-followup-hints.js";

type AgentTurnPayload = Extract<CronJob["payload"], { kind: "agentTurn" }> | null;
type CronPromptRunResult = Awaited<ReturnType<typeof runCliAgent>>;
type CronEmbeddedRuntime = typeof import("./run-embedded.runtime.js");
type CronSubagentRegistryRuntime = typeof import("./run-subagent-registry.runtime.js");

const cronEmbeddedRuntimeLoader = createLazyImportLoader<CronEmbeddedRuntime>(
  () => import("./run-embedded.runtime.js"),
);
const cronSubagentRegistryRuntimeLoader = createLazyImportLoader<CronSubagentRegistryRuntime>(
  () => import("./run-subagent-registry.runtime.js"),
);

async function loadCronEmbeddedRuntime() {
  return await cronEmbeddedRuntimeLoader.load();
}

async function loadCronSubagentRegistryRuntime() {
  return await cronSubagentRegistryRuntimeLoader.load();
}

function resolveCronOwnerOnlyToolAllowlist(toolsAllow: string[] | undefined): string[] | undefined {
  if (!normalizeToolList(toolsAllow).includes("cron")) {
    return undefined;
  }
  return ["cron"];
}

export type CronExecutionResult = {
  runResult: CronPromptRunResult;
  fallbackProvider: string;
  fallbackModel: string;
  runStartedAt: number;
  runEndedAt: number;
  liveSelection: CronLiveSelection;
};

export function createCronPromptExecutor(params: {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  job: CronJob;
  agentId: string;
  agentDir: string;
  agentSessionKey: string;
  runSessionKey: string;
  workspaceDir: string;
  lane?: string;
  resolvedVerboseLevel: VerboseLevel;
  thinkLevel: ThinkLevel | undefined;
  timeoutMs: number;
  senderIsOwner: boolean;
  messageChannel: string | undefined;
  suppressExecNotifyOnExit: boolean;
  resolvedDelivery: {
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  toolPolicy: {
    requireExplicitMessageTarget: boolean;
    disableMessageTool: boolean;
    forceMessageTool: boolean;
  };
  skillsSnapshot: SkillSnapshot;
  agentPayload: AgentTurnPayload;
  liveSelection: CronLiveSelection;
  cronSession: MutableCronSession;
  abortSignal?: AbortSignal;
  abortReason: () => string;
  onExecutionStarted?: () => void;
  onExecutionPhase?: (
    info: Pick<CronAgentExecutionPhaseUpdate, "phase"> &
      Partial<Omit<CronAgentExecutionPhaseUpdate, "jobId" | "phase">>,
  ) => void;
}) {
  const sessionFile =
    params.cronSession.sessionEntry.sessionFile?.trim() ||
    resolveSessionTranscriptPath(params.cronSession.sessionEntry.sessionId, params.agentId);
  // Fallback for callers that bypass prepareCronRunContext before persisting retries.
  if (!params.cronSession.sessionEntry.sessionFile?.trim()) {
    params.cronSession.sessionEntry.sessionFile = sessionFile;
  }
  const cronFallbacksOverride = resolveCronFallbacksOverride({
    cfg: params.cfg,
    job: params.job,
    agentId: params.agentId,
  });
  let runResult: CronPromptRunResult | undefined;
  let fallbackProvider = params.liveSelection.provider;
  let fallbackModel = params.liveSelection.model;
  let runEndedAt = Date.now();
  let bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
    params.cronSession.sessionEntry.systemPromptReport,
  );

  const runPrompt = async (promptText: string) => {
    const fallbackResult = await runWithModelFallback({
      cfg: params.cfgWithAgentDefaults,
      provider: params.liveSelection.provider,
      model: params.liveSelection.model,
      runId: params.cronSession.sessionEntry.sessionId,
      sessionId: params.cronSession.sessionEntry.sessionId,
      lane: resolveCronAgentLane(params.lane),
      agentDir: params.agentDir,
      fallbacksOverride: cronFallbacksOverride,
      run: async (providerOverride, modelOverride, runOptions) => {
        if (params.abortSignal?.aborted) {
          throw new Error(params.abortReason());
        }
        const executionProvider =
          resolveCliRuntimeExecutionProvider({
            provider: providerOverride,
            cfg: params.cfgWithAgentDefaults,
            agentId: params.agentId,
            modelId: modelOverride,
          }) ?? providerOverride;
        const bootstrapPromptWarningSignature =
          bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1];
        if (isCliProvider(executionProvider, params.cfgWithAgentDefaults)) {
          const cliSessionId = params.cronSession.isNewSession
            ? undefined
            : await getCliSessionId(params.cronSession.sessionEntry, executionProvider);
          const result = await runCliAgent({
            sessionId: params.cronSession.sessionEntry.sessionId,
            sessionKey: params.runSessionKey,
            agentId: params.agentId,
            trigger: "cron",
            jobId: params.job.id,
            sessionFile,
            workspaceDir: params.workspaceDir,
            config: params.cfgWithAgentDefaults,
            prompt: promptText,
            provider: executionProvider,
            model: modelOverride,
            thinkLevel: params.thinkLevel,
            timeoutMs: params.timeoutMs,
            runId: params.cronSession.sessionEntry.sessionId,
            lane: resolveCronAgentLane(params.lane),
            cliSessionId,
            skillsSnapshot: params.skillsSnapshot,
            messageChannel: params.messageChannel,
            abortSignal: params.abortSignal,
            onExecutionStarted: params.onExecutionStarted,
            onExecutionPhase: params.onExecutionPhase,
            bootstrapPromptWarningSignaturesSeen,
            bootstrapPromptWarningSignature,
            senderIsOwner: params.senderIsOwner,
          });
          bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
            result.meta?.systemPromptReport,
          );
          return result;
        }
        const { resolveFastModeState, runEmbeddedPiAgent } = await loadCronEmbeddedRuntime();
        const currentChannelId = await resolveCurrentChannelTarget({
          channel: params.messageChannel,
          to: params.resolvedDelivery.to,
          threadId: params.resolvedDelivery.threadId,
        });
        const result = await runEmbeddedPiAgent({
          sessionId: params.cronSession.sessionEntry.sessionId,
          sessionKey: params.runSessionKey,
          agentId: params.agentId,
          trigger: "cron",
          jobId: params.job.id,
          cleanupBundleMcpOnRunEnd: params.job.sessionTarget === "isolated",
          allowGatewaySubagentBinding: true,
          senderIsOwner: false,
          ownerOnlyToolAllowlist: resolveCronOwnerOnlyToolAllowlist(
            params.agentPayload?.toolsAllow,
          ),
          messageChannel: params.messageChannel,
          agentAccountId: params.resolvedDelivery.accountId,
          messageTo: params.resolvedDelivery.to,
          messageThreadId: params.resolvedDelivery.threadId,
          currentChannelId,
          sessionFile,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          config: params.cfgWithAgentDefaults,
          skillsSnapshot: params.skillsSnapshot,
          prompt: promptText,
          lane: resolveCronAgentLane(params.lane),
          provider: providerOverride,
          model: modelOverride,
          authProfileId: params.liveSelection.authProfileId,
          authProfileIdSource: params.liveSelection.authProfileId
            ? params.liveSelection.authProfileIdSource
            : undefined,
          thinkLevel: params.thinkLevel,
          fastMode: resolveFastModeState({
            cfg: params.cfgWithAgentDefaults,
            provider: providerOverride,
            model: modelOverride,
            agentId: params.agentId,
            sessionEntry: params.cronSession.sessionEntry,
          }).enabled,
          verboseLevel: params.resolvedVerboseLevel,
          timeoutMs: params.timeoutMs,
          bootstrapContextMode: params.agentPayload?.lightContext ? "lightweight" : undefined,
          bootstrapContextRunKind: "cron",
          toolsAllow: params.agentPayload?.toolsAllow,
          execOverrides: params.suppressExecNotifyOnExit
            ? {
                notifyOnExit: false,
                notifyOnExitEmptySuccess: false,
              }
            : undefined,
          runId: params.cronSession.sessionEntry.sessionId,
          requireExplicitMessageTarget: params.toolPolicy.requireExplicitMessageTarget,
          disableMessageTool: params.toolPolicy.disableMessageTool,
          forceMessageTool: params.toolPolicy.forceMessageTool,
          allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
          abortSignal: params.abortSignal,
          onExecutionStarted: params.onExecutionStarted,
          onExecutionPhase: params.onExecutionPhase,
          bootstrapPromptWarningSignaturesSeen,
          bootstrapPromptWarningSignature,
        });
        bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
          result.meta?.systemPromptReport,
        );
        return result;
      },
    });
    runResult = fallbackResult.result;
    fallbackProvider = fallbackResult.provider;
    fallbackModel = fallbackResult.model;
    params.liveSelection.provider = fallbackResult.provider;
    params.liveSelection.model = fallbackResult.model;
    runEndedAt = Date.now();
  };

  return {
    runPrompt,
    getState: () => ({
      runResult,
      fallbackProvider,
      fallbackModel,
      runEndedAt,
      liveSelection: params.liveSelection,
    }),
  };
}

export async function executeCronRun(params: {
  cfg: OpenClawConfig;
  cfgWithAgentDefaults: OpenClawConfig;
  job: CronJob;
  agentId: string;
  agentDir: string;
  agentSessionKey: string;
  runSessionKey: string;
  workspaceDir: string;
  lane?: string;
  resolvedDelivery: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  toolPolicy: {
    requireExplicitMessageTarget: boolean;
    disableMessageTool: boolean;
    forceMessageTool: boolean;
  };
  skillsSnapshot: SkillSnapshot;
  agentPayload: AgentTurnPayload;
  agentVerboseDefault: AgentDefaultsConfig["verboseDefault"];
  liveSelection: CronLiveSelection;
  cronSession: MutableCronSession;
  commandBody: string;
  persistSessionEntry: PersistCronSessionEntry;
  abortSignal?: AbortSignal;
  abortReason: () => string;
  isAborted: () => boolean;
  onExecutionStarted?: () => void;
  onExecutionPhase?: (
    info: Pick<CronAgentExecutionPhaseUpdate, "phase"> &
      Partial<Omit<CronAgentExecutionPhaseUpdate, "jobId" | "phase">>,
  ) => void;
  thinkLevel: ThinkLevel | undefined;
  timeoutMs: number;
  senderIsOwner: boolean;
  suppressExecNotifyOnExit: boolean;
  runStartedAt?: number;
}): Promise<CronExecutionResult> {
  const resolvedVerboseLevel: VerboseLevel =
    normalizeVerboseLevel(params.cronSession.sessionEntry.verboseLevel) ??
    normalizeVerboseLevel(params.agentVerboseDefault) ??
    "off";
  registerAgentRunContext(params.cronSession.sessionEntry.sessionId, {
    sessionKey: params.runSessionKey,
    verboseLevel: resolvedVerboseLevel,
  });
  const executor = createCronPromptExecutor({
    cfg: params.cfg,
    cfgWithAgentDefaults: params.cfgWithAgentDefaults,
    job: params.job,
    agentId: params.agentId,
    agentDir: params.agentDir,
    agentSessionKey: params.agentSessionKey,
    runSessionKey: params.runSessionKey,
    workspaceDir: params.workspaceDir,
    lane: params.lane,
    resolvedVerboseLevel,
    thinkLevel: params.thinkLevel,
    timeoutMs: params.timeoutMs,
    messageChannel: params.resolvedDelivery.channel,
    suppressExecNotifyOnExit: params.suppressExecNotifyOnExit,
    resolvedDelivery: params.resolvedDelivery,
    toolPolicy: params.toolPolicy,
    skillsSnapshot: params.skillsSnapshot,
    agentPayload: params.agentPayload,
    liveSelection: params.liveSelection,
    cronSession: params.cronSession,
    abortSignal: params.abortSignal,
    abortReason: params.abortReason,
    onExecutionStarted: params.onExecutionStarted,
    onExecutionPhase: params.onExecutionPhase,
    senderIsOwner: params.senderIsOwner,
  });

  const runStartedAt = params.runStartedAt ?? Date.now();
  const MAX_MODEL_SWITCH_RETRIES = 2;
  let modelSwitchRetries = 0;
  while (true) {
    try {
      await executor.runPrompt(params.commandBody);
      break;
    } catch (err) {
      if (!(err instanceof LiveSessionModelSwitchError)) {
        throw err;
      }
      modelSwitchRetries += 1;
      if (modelSwitchRetries > MAX_MODEL_SWITCH_RETRIES) {
        logWarn(
          `[cron:${params.job.id}] LiveSessionModelSwitchError retry limit reached (${MAX_MODEL_SWITCH_RETRIES}); aborting`,
        );
        throw err;
      }
      params.liveSelection.provider = err.provider;
      params.liveSelection.model = err.model;
      params.liveSelection.authProfileId = err.authProfileId;
      params.liveSelection.authProfileIdSource = err.authProfileId
        ? err.authProfileIdSource
        : undefined;
      syncCronSessionLiveSelection({
        entry: params.cronSession.sessionEntry,
        liveSelection: params.liveSelection,
      });
      try {
        await params.persistSessionEntry();
      } catch (persistErr) {
        logWarn(
          `[cron:${params.job.id}] Failed to persist model switch session entry: ${String(persistErr)}`,
        );
      }
      continue;
    }
  }

  let { runResult, fallbackProvider, fallbackModel, runEndedAt } = executor.getState();
  if (!runResult) {
    throw new Error("cron isolated run returned no result");
  }

  if (!params.isAborted()) {
    const interimPayloads = runResult.payloads ?? [];
    const {
      deliveryPayloadHasStructuredContent: interimPayloadHasStructuredContent,
      hasFatalErrorPayload: interimHasFatalErrorPayload,
      outputText: interimOutputText,
    } = resolveCronPayloadOutcome({
      payloads: interimPayloads,
      runLevelError: runResult.meta?.error,
      failureSignal: runResult.meta?.failureSignal,
      finalAssistantVisibleText: runResult.meta?.finalAssistantVisibleText,
      preferFinalAssistantVisibleText: (
        await resolveCronChannelOutputPolicy(params.resolvedDelivery.channel)
      ).preferFinalAssistantVisibleText,
    });
    const interimText = interimOutputText?.trim() ?? "";
    const shouldRetryInterimAck =
      !runResult.meta?.error &&
      !interimHasFatalErrorPayload &&
      !runResult.didSendViaMessagingTool &&
      !interimPayloadHasStructuredContent &&
      !interimPayloads.some((payload) => payload?.isError === true) &&
      isLikelyInterimCronMessage(interimText);

    let hasFreshDescendants = false;
    let hasActiveDescendants = false;
    if (shouldRetryInterimAck) {
      const { countActiveDescendantRuns, listDescendantRunsForRequester } =
        await loadCronSubagentRegistryRuntime();
      hasFreshDescendants = listDescendantRunsForRequester(params.runSessionKey).some((entry) => {
        const descendantStartedAt =
          typeof entry.startedAt === "number" ? entry.startedAt : entry.createdAt;
        return typeof descendantStartedAt === "number" && descendantStartedAt >= runStartedAt;
      });
      hasActiveDescendants = countActiveDescendantRuns(params.runSessionKey) > 0;
    }

    if (shouldRetryInterimAck && !hasFreshDescendants && !hasActiveDescendants) {
      const continuationPrompt = [
        "Your previous response was only an acknowledgement and did not complete this cron task.",
        "Complete the original task now.",
        "Do not send a status update like 'on it'.",
        "Use tools when needed, including sessions_spawn for parallel subtasks, wait for spawned subagents to finish, then return only the final summary.",
      ].join(" ");
      await executor.runPrompt(continuationPrompt);
      ({ runResult, fallbackProvider, fallbackModel, runEndedAt } = executor.getState());
    }
  }

  if (!runResult) {
    throw new Error("cron isolated run returned no result");
  }
  return {
    runResult,
    fallbackProvider,
    fallbackModel,
    runStartedAt,
    runEndedAt,
    liveSelection: params.liveSelection,
  };
}
