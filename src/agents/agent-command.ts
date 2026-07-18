/** Main agent command orchestration for sessions, model selection, delivery, and attempts. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { VerboseLevel } from "../auto-reply/thinking.js";
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSessionWorkStartError } from "../config/sessions/lifecycle.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../config/sessions/restart-recovery-state.js";
import type { RestartRecoveryTerminalDeliveryEvidenceResult } from "../config/sessions/restart-recovery-types.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { withLocalGatewayRequestScope } from "../gateway/local-request-context.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  captureAgentRunLifecycleGeneration,
  clearAgentRunContext,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { isAgentMediatedCompletionSourceTool } from "../sessions/input-provenance.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { classifySessionStateActor } from "../sessions/session-state-events.js";
import type { DeliveryContext } from "../utils/delivery-context.shared.js";
import { runWithAgentCommandRecoveryOwner } from "./agent-command-recovery-owner.js";
import {
  buildCurrentRunRestartRecoveryClaim,
  shouldPersistRestartRecoveryCleanup,
  shouldPersistRestartRecoveryContextClaim,
} from "./agent-command-restart-recovery.js";
import { resolveAgentRuntimeConfig } from "./agent-runtime-config.js";
import { runAcpAgentCommand } from "./command/acp-execution.js";
import {
  emitIngressModelUsageDiagnostic,
  ingressDiagnosticChannel,
} from "./command/ingress-diagnostics.js";
import { resolveAgentRunLifecycleEndLogLevel } from "./command/lifecycle.js";
import { resolveEmbeddedModelSelection } from "./command/model-selection.js";
import { finalizeEmbeddedAgentCommand } from "./command/post-run.js";
import {
  prepareAgentCommandExecution,
  resolveExplicitAgentCommandSessionKey,
} from "./command/prepare.js";
import { runEmbeddedAgentAttempt } from "./command/run-embedded-attempt.js";
import { loadSessionStoreRuntime, resolveAgentCommandDeps } from "./command/runtime-loaders.js";
import { persistSessionEntry, prepareCurrentRunDelivery } from "./command/session-helpers.js";
import { prepareEmbeddedSessionState } from "./command/session-preparation.js";
import { clearRotatedSessionMetadata } from "./command/session.js";
import type { AgentCommandIngressOpts, AgentCommandOpts } from "./command/types.js";
import {
  removeInternalSessionEffectsSession,
  resolveInternalSessionEffectsTarget,
} from "./internal-session-effects.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import type { MainSessionRecoveryPendingTarget } from "./main-session-recovery-store.js";
import type { AgentRunSessionTarget } from "./run-session-target.js";
import { createAgentRunRestartAbortError } from "./run-termination.js";

const log = createSubsystemLogger("agents/agent-command");

async function agentCommandInternal(
  prepared: Awaited<ReturnType<typeof prepareAgentCommandExecution>>,
  initialOpts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  const resolvedDeps = await resolveAgentCommandDeps(deps);
  const isRawModelRun = initialOpts.modelRun === true || initialOpts.promptMode === "none";
  const suppressVisibleSessionEffects = initialOpts.sessionEffects === "internal";
  const preserveUserFacingSessionModelState =
    initialOpts.preserveUserFacingSessionModelState === true;
  const lifecycleAbortController = new AbortController();
  const storedDeliveryMediaUrls =
    prepared.sessionEntry?.restartRecoveryDeliveryRunId === prepared.runId &&
    Array.isArray(prepared.sessionEntry.restartRecoveryDeliveryMediaUrls)
      ? prepared.sessionEntry.restartRecoveryDeliveryMediaUrls
      : undefined;
  const preparedOpts =
    storedDeliveryMediaUrls !== undefined
      ? {
          ...prepared.opts,
          internalDeliveryMediaUrls: [...storedDeliveryMediaUrls],
          internalDeliverySuppressText: prepared.sessionEntry?.restartRecoverySuppressTextDelivery,
          sourceReplyDeliveryMode: prepared.sessionEntry?.restartRecoverySourceReplyDeliveryMode,
          disableMessageTool: prepared.sessionEntry?.restartRecoveryDisableMessageTool,
          forceRestartSafeTools: prepared.sessionEntry?.restartRecoveryForceSafeTools,
        }
      : prepared.opts;
  if (
    (preparedOpts.internalDeliverySuppressText === true &&
      preparedOpts.internalDeliveryMediaUrls === undefined) ||
    ((preparedOpts.internalDeliveryMediaUrls !== undefined ||
      preparedOpts.internalDeliverySuppressText === true) &&
      (preparedOpts.forceRestartSafeTools !== true ||
        preparedOpts.disableMessageTool !== true ||
        preparedOpts.sourceReplyDeliveryMode !== "automatic"))
  ) {
    throw new Error(
      "internal delivery media constraints require automatic delivery with restart-safe tools and no message tool",
    );
  }
  let opts: AgentCommandOpts = {
    ...preparedOpts,
    abortSignal: preparedOpts.abortSignal
      ? AbortSignal.any([preparedOpts.abortSignal, lifecycleAbortController.signal])
      : lifecycleAbortController.signal,
  };
  const {
    body,
    transcriptBody,
    cfg,
    configuredThinkingCatalog,
    agentCfg,
    thinkOverride,
    thinkOnce,
    verboseOverride,
    sessionId,
    sessionKey,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
    sessionAgentId,
    outboundSession,
    workspaceDir,
    runId,
    isSubagentLane,
    acpManager,
    acpResolution,
    pluginsEnabled,
    manifestMetadataSnapshot,
    modelManifestContext,
  } = prepared;
  let lifecycleGeneration = opts.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(runId);
  let sessionEntry = prepared.sessionEntry,
    runOwnedSessionId = sessionId;
  const sessionStateActor = classifySessionStateActor({
    inputProvenance: opts.inputProvenance,
    internalEvents: opts.internalEvents,
    sessionEffects: opts.sessionEffects,
  });
  // Subagent-lane turns are the parent's own task dispatch into the child (they
  // carry no inter_session provenance today); classifying them as human would tell
  // the parent a human interjected on every spawn, for embedded and ACP children alike.
  const isSubagentLaneTurn = normalizeOptionalString(opts.lane) === AGENT_LANE_SUBAGENT;
  let sessionReboundDuringRun = false;
  let trackedRestartRecoveryDeliveryClaim = false;
  let currentRunDeliveryContext: DeliveryContext | undefined;
  let restartRecoveryTerminalDeliveryEvidence:
    | RestartRecoveryTerminalDeliveryEvidenceResult
    | undefined;
  const preparedSessionId = sessionEntry?.sessionId;
  const internalModelRunTargets =
    initialOpts.modelRun === true && suppressVisibleSessionEffects
      ? new Map<string, AgentRunSessionTarget>()
      : undefined;
  const trackInternalModelRunTarget = (target: AgentRunSessionTarget | undefined) => {
    if (!internalModelRunTargets || !target?.sessionKey || !target.storePath) {
      return;
    }
    internalModelRunTargets.set(`${target.storePath}\n${target.sessionKey}`, target);
  };
  if (internalModelRunTargets && storePath) {
    trackInternalModelRunTarget(
      resolveInternalSessionEffectsTarget({ agentId: sessionAgentId, runId, storePath }),
    );
  }

  let sessionWorkAdmission: Awaited<ReturnType<typeof beginSessionWorkAdmission>> | undefined;
  try {
    assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
    const sessionStoreRuntime =
      storePath && sessionKey ? await loadSessionStoreRuntime() : undefined;
    // Reset marks its mutation before interrupting work. An aborted run must not
    // queue behind that mutation or reset would wait on the run holding the queue.
    sessionWorkAdmission = await beginSessionWorkAdmission({
      scope: storePath ?? `agent:${sessionAgentId}`,
      identities: [sessionKey, sessionId],
      signal: opts.abortSignal,
      onInterrupt: () => lifecycleAbortController.abort(createAgentRunRestartAbortError()),
      assertAllowed: () => {
        const currentEntry =
          sessionStoreRuntime && storePath && sessionKey
            ? sessionStoreRuntime.loadSessionEntry({
                storePath,
                sessionKey,
                readConsistency: "latest",
              })
            : sessionEntry;
        if (!currentEntry && preparedSessionId) {
          throw new Error(
            `Session "${sessionKey ?? sessionId}" changed while starting work. Retry.`,
          );
        }
        const matchesIntentionalRollover =
          isNewSession && currentEntry?.sessionId === preparedSessionId;
        if (currentEntry && currentEntry.sessionId !== sessionId && !matchesIntentionalRollover) {
          throw new Error(
            `Session "${sessionKey ?? sessionId}" changed while starting work. Retry.`,
          );
        }
        const archivedSessionError = resolveSessionWorkStartError(
          sessionKey ?? sessionId,
          currentEntry,
        );
        if (archivedSessionError) {
          throw new Error(archivedSessionError);
        }
        sessionEntry = currentEntry;
        if (sessionStore && sessionKey) {
          if (currentEntry) {
            sessionStore[sessionKey] = currentEntry;
          } else {
            delete sessionStore[sessionKey];
          }
        }
      },
    });
    return await sessionWorkAdmission.run(async () => {
      if (opts.deliver === true) {
        const sendPolicy = resolveSendPolicy({
          cfg,
          entry: sessionEntry,
          sessionKey,
          channel: sessionEntry?.channel,
          chatType: sessionEntry?.chatType,
        });
        if (sendPolicy === "deny") {
          throw new Error("send blocked by session policy");
        }
      }

      if (!isRawModelRun && acpResolution?.kind === "stale") {
        throw acpResolution.error;
      }

      let currentRunDeliveryPrepared = false;
      const prepareDeliveryForRun = async (candidateSessionEntry?: SessionEntry) => {
        if (currentRunDeliveryPrepared || opts.deliver !== true) {
          return;
        }
        currentRunDeliveryPrepared = true;
        let preparedDelivery: Awaited<ReturnType<typeof prepareCurrentRunDelivery>>;
        try {
          preparedDelivery = await prepareCurrentRunDelivery({
            cfg,
            opts,
            agentId: sessionAgentId,
            currentSessionKey: sessionKey,
            sessionEntry: candidateSessionEntry,
          });
        } catch (error) {
          if (opts.bestEffortDeliver !== true) {
            throw error;
          }
          log.warn(
            `delivery preflight failed; continuing session-only because bestEffortDeliver is enabled: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          opts = { ...opts, deliver: false };
        }
        assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        if (preparedDelivery) {
          currentRunDeliveryContext = preparedDelivery.context;
          opts = {
            ...opts,
            replyChannel: preparedDelivery.context.channel,
            replyTo: preparedDelivery.context.to,
            replyAccountId: preparedDelivery.context.accountId,
            threadId: preparedDelivery.context.threadId,
            deliveryTargetMode: preparedDelivery.targetMode,
          };
        }
      };

      if (
        sessionStore &&
        sessionKey &&
        !suppressVisibleSessionEffects &&
        !isSubagentSessionKey(sessionKey)
      ) {
        const now = Date.now();
        const currentStoreEntry = sessionStore[sessionKey];
        const allowCreateRestartRecoveryEntry =
          currentStoreEntry === undefined && sessionEntry === undefined;
        const initialEntry = currentStoreEntry ??
          sessionEntry ?? { sessionId, updatedAt: now, sessionStartedAt: now };
        const isSessionRollover = isNewSession && initialEntry.sessionId !== sessionId;
        const entry = isSessionRollover ? clearRotatedSessionMetadata(initialEntry) : initialEntry;
        await prepareDeliveryForRun(entry);
        const generatedMediaSourceRunId =
          opts.internalDeliveryMediaUrls !== undefined &&
          opts.inputProvenance?.kind === "inter_session" &&
          isAgentMediatedCompletionSourceTool(opts.inputProvenance.sourceTool)
            ? runId
            : undefined;
        assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        const next: SessionEntry = {
          ...entry,
          sessionId,
          updatedAt: now,
          sessionStartedAt: isSessionRollover ? now : entry.sessionStartedAt,
          lastInteractionAt: isSessionRollover ? now : entry.lastInteractionAt,
          ...buildCurrentRunRestartRecoveryClaim({
            deliveryContext: currentRunDeliveryContext,
            deliveryMediaUrls: opts.internalDeliveryMediaUrls,
            disableMessageTool: opts.disableMessageTool,
            entry,
            forceRestartSafeTools: opts.forceRestartSafeTools,
            runId,
            sourceIngress: generatedMediaSourceRunId ? "internal" : undefined,
            sourceRunId: generatedMediaSourceRunId,
            sourceReplyDeliveryMode: opts.sourceReplyDeliveryMode,
            suppressTextDelivery: opts.internalDeliverySuppressText,
          }),
        };
        const persisted = await persistSessionEntry({
          sessionStore,
          sessionKey,
          storePath,
          initialEntry,
          entry: next,
          shouldPersist: (current) =>
            isSessionRollover
              ? current?.sessionId === initialEntry.sessionId
              : shouldPersistRestartRecoveryContextClaim(
                  current,
                  sessionId,
                  runId,
                  allowCreateRestartRecoveryEntry,
                ),
        });
        sessionEntry = persisted;
        trackedRestartRecoveryDeliveryClaim = persisted?.restartRecoveryDeliveryRunId === runId;
      }
      await prepareDeliveryForRun(sessionEntry);

      if (!isRawModelRun && acpResolution?.kind === "ready" && sessionKey) {
        assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        return await runAcpAgentCommand({
          cfg,
          deps: resolvedDeps,
          runtime,
          opts,
          outboundSession,
          sessionEntry,
          sessionStore,
          body,
          transcriptBody,
          suppressVisibleSessionEffects,
          provenance: isSubagentLaneTurn ? "agent" : sessionStateActor.actorType,
          sessionAgentId,
          sessionId,
          sessionKey,
          storePath,
          workspaceDir,
          runId,
          lifecycleGeneration,
          acpManager,
          acpResolution,
          trackInternalModelRunTarget,
        });
      }

      const embeddedSessionState = await prepareEmbeddedSessionState({
        cfg,
        opts,
        sessionEntry,
        sessionStore,
        sessionKey,
        sessionId,
        storePath,
        sessionAgentId,
        lifecycleGeneration,
        runId,
        workspaceDir,
        isNewSession,
        isSubagentLaneTurn,
        suppressVisibleSessionEffects,
        thinkOnce,
        thinkOverride,
        persistedThinking,
        verboseOverride,
        persistedVerbose,
        verboseDefault: agentCfg?.verboseDefault as VerboseLevel | undefined,
        sessionStateActor,
      });
      sessionEntry = embeddedSessionState.sessionEntry;
      const { requestedThinkLevel, runContext } = embeddedSessionState;

      const modelSelection = await resolveEmbeddedModelSelection({
        cfg,
        opts,
        sessionEntry,
        sessionStore,
        sessionKey,
        sessionId,
        storePath,
        sessionAgentId,
        workspaceDir,
        pluginsEnabled,
        manifestMetadataSnapshot,
        modelManifestContext,
        configuredThinkingCatalog,
        requestedThinkLevel,
        thinkOverride,
        thinkOnce,
        isSubagentLane,
        suppressVisibleSessionEffects,
        runContext,
      });
      sessionEntry = modelSelection.sessionEntry;
      const embeddedAttempt = await runEmbeddedAgentAttempt({
        prepared,
        opts,
        sessionEntry,
        lifecycleGeneration,
        onLifecycleGenerationChanged: (nextLifecycleGeneration) => {
          lifecycleGeneration = nextLifecycleGeneration;
        },
        suppressVisibleSessionEffects,
        preserveUserFacingSessionModelState,
        modelSelection,
        embeddedSessionState,
        trackInternalModelRunTarget,
      });
      sessionEntry = embeddedAttempt.sessionEntry;
      lifecycleGeneration = embeddedAttempt.lifecycleGeneration;
      const finalized = await finalizeEmbeddedAgentCommand({
        prepared,
        opts,
        deps: resolvedDeps,
        runtime,
        sessionEntry,
        attempt: embeddedAttempt,
        embeddedSessionState,
        suppressVisibleSessionEffects,
        preserveUserFacingSessionModelState,
        currentRunDeliveryContext,
        sessionOwnership: { runOwnedSessionId, sessionReboundDuringRun },
        trackInternalModelRunTarget,
        onSessionOwnershipChanged: (ownership) => {
          runOwnedSessionId = ownership.runOwnedSessionId;
          sessionReboundDuringRun = ownership.sessionReboundDuringRun;
        },
        onTerminalDeliveryEvidenceChanged: (evidence) => {
          restartRecoveryTerminalDeliveryEvidence = evidence;
        },
      });
      sessionEntry = finalized.sessionEntry;
      runOwnedSessionId = finalized.runOwnedSessionId;
      sessionReboundDuringRun = finalized.sessionReboundDuringRun;
      return finalized.deliveryResult;
    });
  } finally {
    sessionWorkAdmission?.release();
    if (internalModelRunTargets) {
      // Compaction may rotate a private session identity. Remove every owned
      // SQLite row only after delivery; transcript and trajectory rows cascade.
      for (const target of internalModelRunTargets.values()) {
        try {
          await removeInternalSessionEffectsSession(target);
        } catch (error) {
          // Cleanup remains best-effort so a terminal SQLite write failure does
          // not replace the completed model-run result; the DB layer warns too.
          log.warn(
            `failed to remove model-run SQLite session: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    if (
      !sessionReboundDuringRun &&
      trackedRestartRecoveryDeliveryClaim &&
      sessionStore &&
      sessionKey
    ) {
      try {
        const entry = sessionStore[sessionKey] ?? sessionEntry;
        if (entry?.restartRecoveryDeliveryRunId === runId) {
          const next: SessionEntry = {
            ...entry,
            ...buildRestartRecoveryClaimCleanupPatch({
              entry,
              recordTerminalSource: true,
              terminalRunId: runId,
              terminalDeliveryEvidence: restartRecoveryTerminalDeliveryEvidence,
            }),
            updatedAt: Date.now(),
          };
          const persisted = await persistSessionEntry({
            sessionStore,
            sessionKey,
            storePath,
            initialEntry: entry,
            entry: next,
            shouldPersist: (current) =>
              shouldPersistRestartRecoveryCleanup(current, runOwnedSessionId, runId),
          });
          sessionEntry = persisted;
        }
      } catch (error) {
        log.warn(
          `failed to clear restart recovery delivery context for ${sessionKey}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    clearAgentRunContext(runId, lifecycleGeneration);
  }
}

/** Runs an agent turn from CLI/runtime options against the resolved session and model policy. */
export async function agentCommand(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  const resolvedDeps = await resolveAgentCommandDeps(deps);
  const lifecycleGeneration =
    opts.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(opts.runId ?? "");
  return await withAgentRunLifecycleGeneration(lifecycleGeneration, () =>
    withLocalGatewayRequestScope(
      {
        deps: resolvedDeps,
        getRuntimeConfig,
      },
      async () =>
        await runWithAgentCommandRecoveryOwner({
          lifecycleGeneration,
          mode: "reject_uncoordinated",
          opts: {
            ...opts,
            lifecycleGeneration,
            // agentCommand is the trusted-operator entrypoint used by CLI/local flows.
            // Ingress callers must opt into owner identity explicitly via
            // agentCommandFromIngress so network-facing paths cannot inherit this default by accident.
            senderIsOwner: opts.senderIsOwner ?? true,
            // Local/CLI callers are trusted by default for per-run model overrides.
            allowModelOverride: opts.allowModelOverride ?? true,
          },
          prepare: async (preparedOpts) =>
            await prepareAgentCommandExecution(preparedOpts, runtime),
          run: async (prepared) =>
            await agentCommandInternal(prepared, prepared.opts, runtime, resolvedDeps),
        }),
    ),
  );
}

async function agentCommandFromIngressInternal(
  opts: AgentCommandIngressOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
  recovery?: {
    restoreAdmittedRecovery?: () => Promise<MainSessionRecoveryPendingTarget | undefined>;
  },
) {
  if (typeof opts.allowModelOverride !== "boolean") {
    throw new Error("allowModelOverride must be explicitly set for ingress agent runs.");
  }
  const lifecycleGeneration =
    opts.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(opts.runId ?? "");
  return await withAgentRunLifecycleGeneration(lifecycleGeneration, async () => {
    const result = await runWithAgentCommandRecoveryOwner({
      lifecycleGeneration,
      mode: "claim",
      opts: {
        ...opts,
        lifecycleGeneration,
        senderIsOwner: opts.senderIsOwner === true,
      },
      prepare: async (preparedOpts) => await prepareAgentCommandExecution(preparedOpts, runtime),
      restoreAdmittedRecovery: recovery?.restoreAdmittedRecovery,
      run: async (prepared) => await agentCommandInternal(prepared, prepared.opts, runtime, deps),
    });

    if (result) {
      emitIngressModelUsageDiagnostic(result, opts);
    }

    return result;
  });
}

/** Runs an agent turn from an inbound channel/gateway ingress context. */
export async function agentCommandFromIngress(
  opts: AgentCommandIngressOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  return await agentCommandFromIngressInternal(opts, runtime, deps);
}

/** Internal Gateway entrypoint that restores a rejected restart-recovery admission. */
export async function agentCommandFromGatewayIngress(
  opts: AgentCommandIngressOpts,
  runtime: RuntimeEnv,
  deps: CliDeps | undefined,
  recovery: {
    restoreAdmittedRecovery?: () => Promise<MainSessionRecoveryPendingTarget | undefined>;
  },
) {
  return await agentCommandFromIngressInternal(opts, runtime, deps, recovery);
}

export const testing = {
  resolveAgentRuntimeConfig,
  prepareAgentCommandExecution,
  resolveExplicitAgentCommandSessionKey,
  resolveAgentRunLifecycleEndLogLevel,
  ingressDiagnosticChannel,
  emitIngressModelUsageDiagnostic,
};
