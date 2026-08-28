/** Main agent command orchestration for sessions, model selection, delivery, and attempts. */
import path from "node:path";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import type { VerboseLevel } from "../auto-reply/thinking.js";
import type { CliDeps } from "../cli/deps.types.js";
import {
  isSessionWorkStartInvalidatedError,
  resolveSessionWorkStartError,
} from "../config/sessions/lifecycle.js";
import { buildRestartRecoveryClaimCleanupPatch } from "../config/sessions/restart-recovery-state.js";
import type { RestartRecoveryTerminalDeliveryEvidenceResult } from "../config/sessions/restart-recovery-types.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  captureAgentRunLifecycleGeneration,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { clearAgentRunContext } from "../infra/agent-run-registry.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { isSubagentSessionKey } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { isAgentMediatedCompletionSourceTool } from "../sessions/input-provenance.js";
import { resolveSendPolicy } from "../sessions/send-policy.js";
import { ensureSessionDiffBaseline } from "../sessions/session-diff-baseline.js";
import { beginSessionWorkAdmission } from "../sessions/session-lifecycle-admission.js";
import { classifySessionStateActor } from "../sessions/session-state-events.js";
import { sessionDeliveryChannel, type DeliveryContext } from "../utils/delivery-context.shared.js";
import {
  executionIdentity,
  prepareAgentCommandExecutionIdentity,
  sanitizePublicAgentCommandIngressOpts,
  type AgentCommandAdmissionIngress,
} from "./agent-command-execution-identity.js";
import { runLocalAgentCommand } from "./agent-command-local.js";
import { runWithAgentCommandRecoveryOwner } from "./agent-command-recovery-owner.js";
import {
  buildCurrentRunRestartRecoveryClaim,
  shouldPersistRestartRecoveryCleanup,
  shouldPersistRestartRecoveryContextClaim,
} from "./agent-command-restart-recovery.js";
import { runAcpAgentCommand } from "./command/acp-execution.js";
import { repairPendingAssistantTranscriptTurns } from "./command/assistant-transcript-repair.js";
import { persistAgentSession } from "./command/attempt-execution.shared.js";
import { emitIngressModelUsageDiagnostic } from "./command/ingress-diagnostics.js";
import { assertInternalDeliveryConstraints } from "./command/internal-delivery-constraints.js";
import { resolveEmbeddedModelSelection } from "./command/model-selection.js";
import { finalizeEmbeddedAgentCommand } from "./command/post-run.js";
import {
  prepareAgentCommandExecution,
  type PreparedAgentCommandRuntimeContext,
} from "./command/prepare.js";
import { acquireSessionReplyLane } from "./command/reply-run-lane.js";
import { runEmbeddedAgentAttempt } from "./command/run-embedded-attempt.js";
import { loadSessionStoreRuntime, resolveAgentCommandDeps } from "./command/runtime-loaders.js";
import { prepareCurrentRunDelivery } from "./command/session-helpers.js";
import { prepareEmbeddedSessionState } from "./command/session-preparation.js";
import { clearRotatedSessionMetadata } from "./command/session.js";
import type {
  AgentCommandGatewayIngressOpts,
  AgentCommandIngressOpts,
  AgentCommandOpts,
} from "./command/types.js";
import {
  removeInternalSessionEffectsSession,
  resolveInternalSessionEffectsTarget,
} from "./internal-session-effects.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import type { MainSessionRecoveryPendingTarget } from "./main-session-recovery/main-session-recovery-store.js";
import type { AgentRunSessionTarget } from "./run-session-target.js";
import { createAgentRunRestartAbortError } from "./run-termination.js";
import { withAgentPluginRegistry } from "./runtime-plugins.js";
import { measureAgentStartup } from "./startup-timing.js";

const log = createSubsystemLogger("agents/agent-command");

async function agentCommandInternal(
  prepared: Awaited<ReturnType<typeof prepareAgentCommandExecution>>,
  initialOpts: AgentCommandOpts,
  admissionIngress: AgentCommandAdmissionIngress,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
  watchSkills = false,
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
  assertInternalDeliveryConstraints(preparedOpts);
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
    sessionId: preparedRunSessionId,
    sessionKey,
    sessionStore,
    storePath,
    isNewSession,
    persistedThinking,
    persistedVerbose,
    sessionAgentId,
    outboundSession,
    workspaceDir,
    cwd,
    runId,
    isSubagentLane,
    acpManager,
    acpResolution,
    pluginsEnabled,
    manifestMetadataSnapshot,
    modelManifestContext,
  } = prepared;
  let lifecycleGeneration = opts.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(runId);
  // A recovery successor handoff can rotate the durable entry while this turn
  // waits for the reply lane. The lane adopts the rotated identity, so this is
  // the run's identity from acquisition onwards: admission, the durable entry
  // and delivery must all speak of the session the lane actually holds.
  let sessionId = preparedRunSessionId;
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
  let preparedRunAdmission: ReturnType<typeof prepareAgentCommandExecutionIdentity> | undefined;
  let sessionReplyLane: ReplyOperation | undefined;
  try {
    assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
    const sessionStoreRuntime =
      storePath && sessionKey ? await loadSessionStoreRuntime() : undefined;
    // Reset marks its mutation before interrupting work. An aborted run must not
    // queue behind that mutation or reset would wait on the run holding the queue.
    // Serialize against the reply-run registry so this turn neither races a
    // live channel-delivered run nor hides from later channel arrivals. Runs
    // before session-work admission: assertAllowed then revalidates the session
    // against rotation that happened during a potentially long wait. Internal
    // model runs never touch the visible transcript, so they skip it.
    if (sessionKey && !isRawModelRun && !suppressVisibleSessionEffects) {
      const laneOptions = { abortSignal: opts.abortSignal, routeThreadId: opts.threadId };
      sessionReplyLane = await acquireSessionReplyLane(sessionKey, sessionId, laneOptions);
      sessionId = sessionReplyLane.sessionId;
      runOwnedSessionId = sessionId;
      assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
    }
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
      preparedRunAdmission = prepareAgentCommandExecutionIdentity({
        opts,
        // Recovery binds the execution identity to a session id; after a
        // handoff that must be the adopted one, not the one prepared before
        // the wait.
        prepared: sessionId === prepared.sessionId ? prepared : { ...prepared, sessionId },
        ingress: admissionIngress,
        lifecycleGeneration,
      });
      if (sessionStore && sessionKey && !suppressVisibleSessionEffects) {
        try {
          await repairPendingAssistantTranscriptTurns({
            context: {
              sessionKey,
              sessionEntry,
              sessionStore,
              storePath,
              sessionAgentId,
              config: cfg,
            },
          });
          sessionEntry = sessionStore[sessionKey] ?? sessionEntry;
        } catch (error) {
          if (!isNewSession) {
            throw error;
          }
          // A reset starts a fresh transcript. Do not let predecessor repair
          // state leak into it when the old transcript remains unavailable.
          log.warn(
            `Could not repair predecessor transcript before session reset for ${sessionKey}: ${formatErrorMessage(error)}`,
          );
        }
      }
      if (opts.deliver === true) {
        const sendPolicy = resolveSendPolicy({
          cfg,
          entry: sessionEntry,
          sessionKey,
          channel: sessionDeliveryChannel(sessionEntry),
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
      const prepareDeliveryForRun = async (candidateSessionEntry?: InternalSessionEntry) => {
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
            `delivery preflight failed; continuing model run with requested delivery intent because bestEffortDeliver is enabled: ${coerceErrorMessage(error)}`,
          );
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
        const next: InternalSessionEntry = {
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
        const persisted = await persistAgentSession({
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
      if (sessionEntry && sessionKey && !suppressVisibleSessionEffects) {
        try {
          sessionEntry = await ensureSessionDiffBaseline({
            cwd: cwd ?? workspaceDir,
            entry: sessionEntry,
            isNewSession,
            sessionKey,
            storePath,
          });
          if (sessionStore) {
            sessionStore[sessionKey] = sessionEntry;
          }
        } catch (error) {
          if (isSessionWorkStartInvalidatedError(error)) {
            throw error;
          }
          log.warn(
            `session diff baseline capture failed; continuing without attribution filtering: ${coerceErrorMessage(error)}`,
          );
        }
      }
      await prepareDeliveryForRun(sessionEntry);

      if (!isRawModelRun && acpResolution?.kind === "ready" && sessionKey) {
        assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
        return await runAcpAgentCommand({
          replyOperation: sessionReplyLane,
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
          preparedRunAdmission,
        });
      }

      const embeddedSessionState = await measureAgentStartup(
        "session-state",
        () =>
          prepareEmbeddedSessionState({
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
            executionSkillsDir: path.join(
              sessionEntry?.worktree?.canonicalWorkspaceDir ?? cwd ?? workspaceDir,
              "skills",
            ),
            watchSkills,
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
            ...(manifestMetadataSnapshot
              ? { pluginMetadataSnapshot: manifestMetadataSnapshot }
              : {}),
          }),
        { config: cfg },
      );
      sessionEntry = embeddedSessionState.sessionEntry;
      const { requestedThinkLevel, runContext } = embeddedSessionState;

      const modelSelection = await measureAgentStartup(
        "model-selection",
        () =>
          resolveEmbeddedModelSelection({
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
          }),
        { config: cfg },
      );
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
        preparedRunAdmission,
        replyOperation: sessionReplyLane,
      });
      if (embeddedAttempt.fallbackExhausted) {
        opts.onModelFallbackExhausted?.();
      }
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
    sessionReplyLane?.complete();
    await preparedRunAdmission?.finish();
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
          log.warn(`failed to remove model-run SQLite session: ${coerceErrorMessage(error)}`);
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
          const next: InternalSessionEntry = {
            ...entry,
            ...buildRestartRecoveryClaimCleanupPatch({
              entry,
              recordTerminalSource: true,
              terminalRunId: runId,
              terminalDeliveryEvidence: restartRecoveryTerminalDeliveryEvidence,
            }),
            updatedAt: Date.now(),
          };
          const persisted = await persistAgentSession({
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
          `failed to clear restart recovery delivery context for ${sessionKey}: ${coerceErrorMessage(error)}`,
        );
      }
    }
    clearAgentRunContext(runId, lifecycleGeneration);
  }
}

async function agentCommandWithAdmissionIngress(
  opts: AgentCommandOpts,
  admissionIngress: AgentCommandAdmissionIngress,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  return await runLocalAgentCommand({
    opts,
    runtime,
    deps,
    operatorAuthority: admissionIngress.kind === "local-cli",
    run: async (prepared, resolvedDeps) =>
      await agentCommandInternal(prepared, prepared.opts, admissionIngress, runtime, resolvedDeps),
  });
}

export async function agentCommand(
  opts: AgentCommandOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  const { localIngress } = executionIdentity;
  return await agentCommandWithAdmissionIngress(opts, localIngress, runtime, deps);
}

export async function agentCommandFromSystem(
  opts: AgentCommandOpts,
  admission: { boundary: string },
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  const ingress = executionIdentity.systemIngress(admission.boundary);
  return await agentCommandWithAdmissionIngress(opts, ingress, runtime, deps);
}

async function agentCommandFromIngressInternal(
  opts: AgentCommandGatewayIngressOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
  recovery?: {
    restoreAdmittedRecovery?: () => Promise<MainSessionRecoveryPendingTarget | undefined>;
  },
  runtimeContext?: PreparedAgentCommandRuntimeContext,
) {
  if (typeof opts.allowModelOverride !== "boolean") {
    throw new Error("allowModelOverride must be explicitly set for ingress agent runs.");
  }
  const lifecycleGeneration =
    opts.lifecycleGeneration ?? captureAgentRunLifecycleGeneration(opts.runId ?? "");
  const generation = runtimeContext?.pluginGeneration;
  const executeIngress = () =>
    withAgentRunLifecycleGeneration(lifecycleGeneration, async () => {
      let preparedAgentDir: string | undefined;
      const result = await runWithAgentCommandRecoveryOwner({
        lifecycleGeneration,
        mode: "claim",
        opts: {
          ...opts,
          lifecycleGeneration,
          senderIsOwner: opts.senderIsOwner === true,
        },
        prepare: async (preparedOpts) =>
          await prepareAgentCommandExecution(preparedOpts, runtime, runtimeContext),
        restoreAdmittedRecovery: recovery?.restoreAdmittedRecovery,
        run: async (prepared) => {
          preparedAgentDir = prepared.agentDir;
          const run = async () =>
            await agentCommandInternal(
              prepared,
              prepared.opts,
              { kind: "api", boundary: "agent-command.from-ingress", state: "unknown" },
              runtime,
              deps,
              true,
            );
          return generation
            ? await run()
            : await withAgentPluginRegistry({
                config: prepared.cfg,
                workspaceDir: prepared.workspaceDir,
                run,
              });
        },
      });

      if (result && preparedAgentDir) {
        emitIngressModelUsageDiagnostic(result, opts, preparedAgentDir);
      }

      return result;
    });
  return generation && runtimeContext
    ? await withPluginRuntimeGenerationScope(
        {
          config: runtimeContext.config,
          metadataSnapshot: generation.pluginMetadataSnapshot,
          pluginRegistry: generation.pluginRegistry,
        },
        executeIngress,
      )
    : await executeIngress();
}

/** Runs an agent turn from an inbound channel/gateway ingress context. */
export async function agentCommandFromIngress(
  opts: AgentCommandIngressOpts,
  runtime: RuntimeEnv = defaultRuntime,
  deps?: CliDeps,
) {
  // Plugin SDK callers may be plain JavaScript. Enforce the private recovery
  // boundary at runtime so extra or inherited properties cannot author audit identity.
  return await agentCommandFromIngressInternal(
    sanitizePublicAgentCommandIngressOpts(opts),
    runtime,
    deps,
  );
}

/** Internal Gateway entrypoint that restores a rejected restart-recovery admission. */
export async function agentCommandFromGatewayIngress(
  opts: AgentCommandGatewayIngressOpts,
  runtime: RuntimeEnv,
  deps: CliDeps | undefined,
  recovery: {
    restoreAdmittedRecovery?: () => Promise<MainSessionRecoveryPendingTarget | undefined>;
  },
  runtimeContext?: PreparedAgentCommandRuntimeContext,
) {
  return await agentCommandFromIngressInternal(opts, runtime, deps, recovery, runtimeContext);
}
