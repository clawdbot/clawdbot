import type { SkillSnapshot } from "../../agents/skills.js";
import type { ThinkLevel, VerboseLevel } from "../../auto-reply/thinking.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../types.js";
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

let cronEmbeddedRuntimePromise: Promise<CronEmbeddedRuntime> | undefined;
let cronSubagentRegistryRuntimePromise: Promise<CronSubagentRegistryRuntime> | undefined;

async function loadCronEmbeddedRuntime() {
  cronEmbeddedRuntimePromise ??= import("./run-embedded.runtime.js");
  return await cronEmbeddedRuntimePromise;
}

async function loadCronSubagentRegistryRuntime() {
  cronSubagentRegistryRuntimePromise ??= import("./run-subagent-registry.runtime.js");
  return await cronSubagentRegistryRuntimePromise;
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
  workspaceDir: string;
  lane?: string;
  resolvedVerboseLevel: VerboseLevel;
  thinkLevel: ThinkLevel | undefined;
  timeoutMs: number;
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
      agentDir: params.agentDir,
      fallbacksOverride: cronFallbacksOverride,
      run: async (providerOverride, modelOverride, runOptions) => {
        if (params.abortSignal?.aborted) {
          throw new Error(params.abortReason());
        }
        const bootstrapPromptWarningSignature =
          bootstrapPromptWarningSignaturesSeen[bootstrapPromptWarningSignaturesSeen.length - 1];
        if (isCliProvider(providerOverride, params.cfgWithAgentDefaults)) {
          const cliSessionId = params.cronSession.isNewSession
            ? undefined
            : await getCliSessionId(params.cronSession.sessionEntry, providerOverride);
          const result = await runCliAgent({
            sessionId: params.cronSession.sessionEntry.sessionId,
            sessionKey: params.agentSessionKey,
            agentId: params.agentId,
            trigger: "cron",
            sessionFile,
            workspaceDir: params.workspaceDir,
            config: params.cfgWithAgentDefaults,
            prompt: promptText,
            provider: providerOverride,
            model: modelOverride,
            thinkLevel: params.thinkLevel,
            timeoutMs: params.timeoutMs,
            runId: params.cronSession.sessionEntry.sessionId,
            cliSessionId,
            skillsSnapshot: params.skillsSnapshot,
            messageChannel: params.messageChannel,
            bootstrapPromptWarningSignaturesSeen,
            bootstrapPromptWarningSignature,
            senderIsOwner: true,
          });
          bootstrapPromptWarningSignaturesSeen = resolveBootstrapWarningSignaturesSeen(
            result.meta?.systemPromptReport,
          );
          return result;
        }
        const { resolveFastModeState, resolveNestedAgentLane, runEmbeddedPiAgent } =
          await loadCronEmbeddedRuntime();
        const currentChannelId = await resolveCurrentChannelTarget({
          channel: params.messageChannel,
          to: params.resolvedDelivery.to,
          threadId: params.resolvedDelivery.threadId,
        });
        const result = await runEmbeddedPiAgent({
          sessionId: params.cronSession.sessionEntry.sessionId,
          sessionKey: params.agentSessionKey,
          agentId: params.agentId,
          trigger: "cron",
          cleanupBundleMcpOnRunEnd: params.job.sessionTarget === "isolated",
          allowGatewaySubagentBinding: true,
          senderIsOwner: false,
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
          lane: resolveNestedAgentLane(params.lane),
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
  thinkLevel: ThinkLevel | undefined;
  timeoutMs: number;
  suppressExecNotifyOnExit: boolean;
  runStartedAt?: number;
}): Promise<CronExecutionResult> {
  const resolvedVerboseLevel: VerboseLevel =
    normalizeVerboseLevel(params.cronSession.sessionEntry.verboseLevel) ??
    normalizeVerboseLevel(params.agentVerboseDefault) ??
    "off";
  registerAgentRunContext(params.cronSession.sessionEntry.sessionId, {
    sessionKey: params.agentSessionKey,
    verboseLevel: resolvedVerboseLevel,
  });
  const executor = createCronPromptExecutor({
    cfg: params.cfg,
    cfgWithAgentDefaults: params.cfgWithAgentDefaults,
    job: params.job,
    agentId: params.agentId,
    agentDir: params.agentDir,
    agentSessionKey: params.agentSessionKey,
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
      outputText: interimOutputText,
    } = resolveCronPayloadOutcome({
      payloads: interimPayloads,
      runLevelError: runResult.meta?.error,
      finalAssistantVisibleText: runResult.meta?.finalAssistantVisibleText,
      preferFinalAssistantVisibleText: (
        await resolveCronChannelOutputPolicy(params.resolvedDelivery.channel)
      ).preferFinalAssistantVisibleText,
    });
    const interimText = interimOutputText?.trim() ?? "";
    const shouldRetryInterimAck =
      !runResult.meta?.error &&
      !runResult.didSendViaMessagingTool &&
      !interimPayloadHasStructuredContent &&
      !interimPayloads.some((payload) => payload?.isError === true) &&
      isLikelyInterimCronMessage(interimText);

    let hasFreshDescendants = false;
    let hasActiveDescendants = false;
    if (shouldRetryInterimAck) {
      const { countActiveDescendantRuns, listDescendantRunsForRequester } =
        await loadCronSubagentRegistryRuntime();
      hasFreshDescendants = listDescendantRunsForRequester(params.agentSessionKey).some((entry) => {
        const descendantStartedAt =
          typeof entry.startedAt === "number" ? entry.startedAt : entry.createdAt;
        return typeof descendantStartedAt === "number" && descendantStartedAt >= runStartedAt;
      });
      hasActiveDescendants = countActiveDescendantRuns(params.agentSessionKey) > 0;
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
