import { resolveInlineAgentImageAttachments } from "../../auto-reply/reply/agent-turn-attachments.js";
import type { CliDeps } from "../../cli/deps.types.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  registerAgentRunContext,
} from "../../infra/agent-events.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { RuntimeEnv } from "../../runtime.js";
import { prepareInternalSessionEffectsSession } from "../internal-session-effects.js";
import type { AgentRunSessionTarget } from "../run-session-target.js";
import { isAgentRunRestartAbortReason } from "../run-termination.js";
import { applyAgentRunAbortMetadata } from "./lifecycle.js";
import type { PreparedAgentCommandExecution } from "./prepare.js";
import {
  loadAcpPolicyRuntime,
  loadAcpRuntimeErrorsRuntime,
  loadAcpSessionIdentifiersRuntime,
  loadAttemptExecutionRuntime,
  loadDeliveryRuntime,
} from "./runtime-loaders.js";
import { resolveInternalSessionEffectsSource } from "./session-helpers.js";
import type { AgentCommandOpts } from "./types.js";

const log = createSubsystemLogger("agents/agent-command");

type AcpReadyResolution = Extract<
  NonNullable<PreparedAgentCommandExecution["acpResolution"]>,
  { kind: "ready" }
>;

export async function runAcpAgentCommand(params: {
  cfg: OpenClawConfig;
  deps: CliDeps;
  runtime: RuntimeEnv;
  opts: AgentCommandOpts;
  outboundSession: PreparedAgentCommandExecution["outboundSession"];
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  body: string;
  transcriptBody: string;
  suppressVisibleSessionEffects: boolean;
  provenance: "agent" | "human" | "system";
  sessionAgentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
  workspaceDir: string;
  runId: string;
  lifecycleGeneration: string;
  acpManager: PreparedAgentCommandExecution["acpManager"];
  acpResolution: AcpReadyResolution;
  trackInternalModelRunTarget: (target: AgentRunSessionTarget | undefined) => void;
}) {
  const attemptExecutionRuntime = await loadAttemptExecutionRuntime();
  const acpToolTracker = attemptExecutionRuntime.createAcpToolLifecycleTracker();
  const startedAt = Date.now();
  registerAgentRunContext(params.runId, {
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.sessionAgentId,
    lifecycleGeneration: params.lifecycleGeneration,
    ...(params.suppressVisibleSessionEffects ? { isControlUiVisible: false } : {}),
  });
  attemptExecutionRuntime.emitAcpLifecycleStart({
    runId: params.runId,
    startedAt,
    agentId: params.sessionAgentId,
    lifecycleGeneration: params.lifecycleGeneration,
  });

  const visibleTextAccumulator = attemptExecutionRuntime.createAcpVisibleTextAccumulator();
  let stopReason: string | undefined;
  let resultStatus: "completed" | "cancelled" | undefined;
  let terminalOutcome: "blocked" | undefined;
  try {
    const {
      resolveAcpAgentPolicyError,
      resolveAcpDispatchPolicyError,
      resolveAcpExplicitTurnPolicyError,
    } = await loadAcpPolicyRuntime();
    const turnPolicyError =
      params.opts.acpTurnSource === "manual_spawn"
        ? resolveAcpExplicitTurnPolicyError(params.cfg)
        : resolveAcpDispatchPolicyError(params.cfg);
    if (turnPolicyError) {
      terminalOutcome = "blocked";
      throw turnPolicyError;
    }
    const acpAgent = normalizeAgentId(
      params.acpResolution.meta.agent || resolveAgentIdFromSessionKey(params.sessionKey),
    );
    const agentPolicyError = resolveAcpAgentPolicyError(params.cfg, acpAgent);
    if (agentPolicyError) {
      terminalOutcome = "blocked";
      throw agentPolicyError;
    }

    const acpImageAttachments = resolveInlineAgentImageAttachments(params.opts.images);
    assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
    await params.acpManager.runTurn({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      provenance: params.provenance,
      text: params.body,
      attachments: acpImageAttachments.length > 0 ? acpImageAttachments : undefined,
      mode: "prompt",
      requestId: params.runId,
      signal: params.opts.abortSignal,
      onLifecycle: (event) => {
        if (event.type === "prompt_submitted") {
          attemptExecutionRuntime.emitAcpPromptSubmitted({
            runId: params.runId,
            sessionKey: params.sessionKey,
            at: event.at,
          });
        }
      },
      onEvent: (event) => {
        if (event.type !== "text_delta") {
          attemptExecutionRuntime.emitAcpRuntimeEvent({
            runId: params.runId,
            toolTracker: acpToolTracker,
            sessionKey: params.sessionKey,
            agentId: params.sessionAgentId,
            abortSignal: params.opts.abortSignal,
            event,
          });
        }
        if (event.type === "done") {
          stopReason = event.stopReason;
          resultStatus = event.status;
          return;
        }
        if (
          event.type !== "text_delta" ||
          (event.stream && event.stream !== "output") ||
          !event.text
        ) {
          return;
        }
        const visibleUpdate = visibleTextAccumulator.consume(event.text);
        if (visibleUpdate) {
          attemptExecutionRuntime.emitAcpAssistantDelta({
            runId: params.runId,
            text: visibleUpdate.text,
            delta: visibleUpdate.delta,
          });
        }
      },
    });
    if (isAgentRunRestartAbortReason(params.opts.abortSignal?.reason)) {
      throw params.opts.abortSignal?.reason;
    }
  } catch (error) {
    const { toAcpRuntimeError } = await loadAcpRuntimeErrorsRuntime();
    const acpError = toAcpRuntimeError({
      error,
      fallbackCode: "ACP_TURN_FAILED",
      fallbackMessage: "ACP turn failed before completion.",
    });
    attemptExecutionRuntime.emitAcpLifecycleError({
      runId: params.runId,
      toolTracker: acpToolTracker,
      error: acpError,
      sessionKey: params.sessionKey,
      agentId: params.sessionAgentId,
      lifecycleGeneration: params.lifecycleGeneration,
      abortSignal: params.opts.abortSignal,
      ...(terminalOutcome ? { terminalOutcome } : {}),
    });
    throw acpError;
  }

  const finalTextRaw = visibleTextAccumulator.finalizeRaw();
  const finalText = visibleTextAccumulator.finalize();
  let sessionEntry = params.sessionEntry;
  try {
    const { resolveAcpSessionCwd } = await loadAcpSessionIdentifiersRuntime();
    const internalSource = params.suppressVisibleSessionEffects
      ? resolveInternalSessionEffectsSource({
          agentId: params.sessionAgentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          storePath: params.storePath,
        })
      : undefined;
    const internalTarget = params.suppressVisibleSessionEffects
      ? await prepareInternalSessionEffectsSession({
          agentId: params.sessionAgentId,
          cwd: resolveAcpSessionCwd(params.acpResolution.meta) ?? params.workspaceDir,
          runId: params.runId,
          source: internalSource,
          storePath: params.storePath,
        })
      : undefined;
    params.trackInternalModelRunTarget(internalTarget);
    const transcriptResult = await attemptExecutionRuntime.persistAcpTurnTranscript({
      body: params.body,
      transcriptBody: params.transcriptBody,
      ...(params.opts.suppressPromptPersistence !== true && params.opts.transcriptMedia?.length
        ? {
            userInput: {
              text: params.transcriptBody,
              media: params.opts.transcriptMedia,
              mediaOnlyText: "[User sent media without caption]",
            },
          }
        : {}),
      finalText: finalTextRaw,
      sessionId: internalTarget?.sessionId ?? params.sessionId,
      sessionKey: internalTarget?.sessionKey ?? params.sessionKey,
      sessionEntry: internalTarget?.sessionEntry ?? sessionEntry,
      sessionStore: params.suppressVisibleSessionEffects ? undefined : params.sessionStore,
      storePath: internalTarget?.storePath ?? params.storePath,
      sessionAgentId: internalTarget?.agentId ?? params.sessionAgentId,
      threadId: params.opts.threadId,
      sessionCwd: resolveAcpSessionCwd(params.acpResolution.meta) ?? params.workspaceDir,
      config: params.cfg,
    });
    if (!internalTarget) {
      sessionEntry = transcriptResult.sessionEntry;
    }
  } catch (error) {
    log.warn(
      `ACP transcript persistence failed for ${params.sessionKey}: ${formatErrorMessage(error)}`,
    );
  }
  const restartAbortReason = params.opts.abortSignal?.reason;
  if (isAgentRunRestartAbortReason(restartAbortReason)) {
    attemptExecutionRuntime.emitAcpLifecycleError({
      runId: params.runId,
      toolTracker: acpToolTracker,
      error: restartAbortReason,
      sessionKey: params.sessionKey,
      agentId: params.sessionAgentId,
      lifecycleGeneration: params.lifecycleGeneration,
      abortSignal: params.opts.abortSignal,
    });
    throw restartAbortReason;
  }
  attemptExecutionRuntime.emitAcpLifecycleEnd({
    runId: params.runId,
    toolTracker: acpToolTracker,
    agentId: params.sessionAgentId,
    lifecycleGeneration: params.lifecycleGeneration,
    abortSignal: params.opts.abortSignal,
    stopReason,
    resultStatus,
  });

  const result = applyAgentRunAbortMetadata(
    attemptExecutionRuntime.buildAcpResult({
      payloadText: finalText,
      startedAt,
      stopReason,
      resultStatus,
      abortSignal: params.opts.abortSignal,
    }),
    params.opts.abortSignal,
  );
  const { deliverAgentCommandResult } = await loadDeliveryRuntime();
  return await deliverAgentCommandResult({
    cfg: params.cfg,
    deps: params.deps,
    runtime: params.runtime,
    opts: params.opts,
    outboundSession: params.outboundSession,
    sessionEntry,
    result,
    payloads: result.payloads,
    assertDeliveryCurrent: () =>
      assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration),
  });
}
