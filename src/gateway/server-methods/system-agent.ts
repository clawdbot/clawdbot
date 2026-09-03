// OpenClaw gateway methods host the setup/repair conversation for clients.
import {
  buildSystemAgentInferenceUnavailableErrorDetails,
  buildSystemAgentSessionInvalidatedErrorDetails,
  ErrorCodes,
  errorShape,
  validateSystemAgentChatParams,
  validateSystemAgentChatHistoryParams,
  validateSystemAgentSetupActivateParams,
  validateSystemAgentSetupActivateStartParams,
  validateSystemAgentSetupAuthStartParams,
  validateSystemAgentSetupDetectParams,
  validateSystemAgentSetupVerifyParams,
  type SystemAgentChatQuestion,
} from "../../../packages/gateway-protocol/src/index.js";
import { defaultRuntime } from "../../runtime.js";
import {
  SystemAgentChatEngine,
  SystemAgentWizardAnswerError,
} from "../../system-agent/chat-engine.js";
import {
  acknowledgeSystemAgentGreetingDelivery,
  buildSystemAgentGreetingQuestion,
  loadSystemAgentGreetingFacts,
  resolveSystemAgentGreeting,
} from "../../system-agent/greeting.js";
import { isSystemAgentInferenceUnavailableError } from "../../system-agent/inference-error.js";
import { buildNewAgentWelcome } from "../../system-agent/new-agent-welcome.js";
import { buildOnboardingWelcome } from "../../system-agent/onboarding-welcome.js";
import { appendTranscriptReset, readTranscriptTail } from "../../system-agent/transcript-store.js";
import { resolveUserPath } from "../../utils.js";
import { listVisiblePendingApprovalRequests } from "./approval-shared.js";
import {
  authenticatedProfileUnavailableError,
  isGatewayClientProfilePending,
} from "./gateway-client-identity.js";
import { startModelsAuthLoginWizard } from "./models-auth-login.js";
import {
  runExclusiveSystemAgentSetupActivation,
  respondSetupAdmissionBusy,
  SetupAdmissionBusyError,
} from "./setup-admission.js";
import type { GatewaySystemAgentSession as SystemAgentChatSession } from "./shared-types.js";
import { prepareDelegatedSystemAgentApproval } from "./system-agent-approval.js";
import { sanitizeSystemAgentChatParams } from "./system-agent-chat-params.js";
import {
  buildSystemAgentChatResult,
  buildSystemAgentRejoinResult,
  getSystemAgentChatInputError,
  persistSystemAgentEngineHistory,
  runSystemAgentChatInput,
} from "./system-agent-chat-turn.js";
import {
  activateGatewaySetupInference,
  runSystemAgentGatewayTask,
  verifyGatewaySetupInference,
} from "./system-agent-execution.js";
import { resolveSystemAgentSessionOwnerKey } from "./system-agent-session-owner.js";
import { startSetupActivationWizard } from "./system-agent-setup-wizard.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";
import { gatewayWizardStepRuntime, startGatewayWizardSession } from "./wizard-session-start.js";

export type { SystemAgentChatSession };

/**
 * `openclaw.chat` lets clients (macOS app onboarding, future UIs) run the
 * same conversational setup as `openclaw setup`. Structured setup owns
 * the pre-inference phase; a new chat session starts only after a live model
 * turn succeeds.
 *
 * The bounded session map owns only in-flight wizard and approval state. The
 * sanitized conversation is a durable machine-wide logbook; `reset: true`
 * replaces the in-memory session without deleting that transcript.
 */
const MAX_SYSTEM_AGENT_SESSIONS = 8;
const SYSTEM_AGENT_SEED_HISTORY_LIMIT = 30;
const DEFAULT_SYSTEM_AGENT_HISTORY_LIMIT = 100;
const ACTIVATION_SESSION_TIMEOUT_MS = 8 * 60 * 1000;
const PROVIDER_PREPARE_SESSION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
function acknowledgeDeliveredSystemAgentWelcome(session: SystemAgentChatSession): void {
  const auditSequence = session.welcomeAuditSequence;
  if (auditSequence === undefined) {
    return;
  }
  acknowledgeSystemAgentGreetingDelivery({ auditSequence });
  delete session.welcomeAuditSequence;
}

async function evictOldestSession(
  sessions: Map<string, SystemAgentChatSession>,
  context: GatewayRequestContext,
): Promise<void> {
  if (sessions.size < MAX_SYSTEM_AGENT_SESSIONS) {
    return;
  }
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, session] of sessions) {
    if (session.lastUsedAt < oldestAt) {
      oldestAt = session.lastUsedAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== undefined) {
    const oldest = sessions.get(oldestKey);
    if (oldest?.pendingApproval) {
      context.systemAgentApprovalManager?.expire(oldest.pendingApproval.id, "session-evicted");
    }
    await oldest?.engine.dispose();
    sessions.delete(oldestKey);
  }
}

export const systemAgentHandlers: GatewayRequestHandlers = {
  "openclaw.approval.list": async ({ respond, client, context }) => {
    const manager = context.systemAgentApprovalManager;
    respond(
      true,
      manager
        ? listVisiblePendingApprovalRequests({
            manager,
            client,
            ...(client?.authenticatedUserProfile ? { cfg: context.getRuntimeConfig() } : {}),
          })
        : [],
      undefined,
    );
  },
  "openclaw.chat.history": ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentChatHistoryParams,
        "openclaw.chat.history",
        respond,
      )
    ) {
      return;
    }
    respond(
      true,
      { turns: readTranscriptTail(params.limit ?? DEFAULT_SYSTEM_AGENT_HISTORY_LIMIT) },
      undefined,
    );
  },
  /** Structured onboarding: list reusable AI access on this host. */
  "openclaw.setup.detect": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupDetectParams,
        "openclaw.setup.detect",
        respond,
      )
    ) {
      return;
    }
    // Detection is read-only and may load native provider code. Keep it outside
    // the mutation lane and off the Gateway event loop so health stays live.
    const { detectSetupInferenceIsolated } = await import("../../system-agent/setup-inference.js");
    respond(true, await detectSetupInferenceIsolated(params), undefined);
  },
  /** Re-run the exact current default-agent inference route without mutating setup. */
  "openclaw.setup.verify": async ({ params, respond, context }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupVerifyParams,
        "openclaw.setup.verify",
        respond,
      )
    ) {
      return;
    }
    await runSystemAgentGatewayTask(async () => {
      const result = await verifyGatewaySetupInference({
        runtime: defaultRuntime,
        context,
        ...params,
      });
      respond(true, result, undefined);
    });
  },
  /** Start one provider-owned OAuth/device-code login over the shared wizard transport. */
  "openclaw.setup.auth.start": async ({ params, respond, context, client, signal }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupAuthStartParams,
        "openclaw.setup.auth.start",
        respond,
      )
    ) {
      return;
    }
    await startModelsAuthLoginWizard({
      authChoice: params.authChoice,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionId: params.sessionId,
      context,
      respond,
      ...(client?.connId ? { ownerConnId: client.connId } : {}),
      ...(signal ? { requestSignal: signal } : {}),
    });
  },
  /** Activate a detected or manual route with server-owned capability review. */
  "openclaw.setup.activate.start": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupActivateStartParams,
        "openclaw.setup.activate.start",
        respond,
      )
    ) {
      return;
    }
    const { sessionId, ...activation } = params;
    await startSetupActivationWizard({
      sessionId,
      activation,
      timeoutMs: ACTIVATION_SESSION_TIMEOUT_MS,
      context,
      respond,
      ownerConnId: client?.connId,
    });
  },
  /** Run one provider-owned prepare flow over the shared wizard transport. */
  "openclaw.setup.prepare.start": async ({ params, respond, context, client }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupAuthStartParams,
        "openclaw.setup.prepare.start",
        respond,
      )
    ) {
      return;
    }
    await startGatewayWizardSession({
      context,
      respond,
      sessionId: params.sessionId,
      ownerConnId: client?.connId,
      timeoutMs: PROVIDER_PREPARE_SESSION_TIMEOUT_MS,
      run: async (prompter, signal, runnerSession) => {
        await runSystemAgentGatewayTask(async () => {
          const [{ applyAuthChoiceLoadedPluginProvider }, setupShared] = await Promise.all([
            import("../../plugins/provider-auth-choice.js"),
            import("../../wizard/setup.shared.js"),
          ]);
          const snapshot = await setupShared.readSetupConfigFileSnapshot();
          if (!snapshot.valid) {
            throw new Error("Config is invalid. Run `openclaw doctor` before preparing a model.");
          }
          // Match the classic wizard: mutate the authored shape, not runtimeConfig,
          // so setup never writes resolved runtime defaults into openclaw.json.
          const baseConfig = snapshot.exists ? snapshot.sourceConfig : {};
          const workspaceDir = params.workspace?.trim()
            ? resolveUserPath(params.workspace.trim())
            : undefined;
          const applied = await applyAuthChoiceLoadedPluginProvider({
            authChoice: params.authChoice,
            ...(params.agentId ? { agentId: params.agentId } : {}),
            config: baseConfig,
            prompter,
            runtime: gatewayWizardStepRuntime,
            setDefaultModel: false,
            preserveExistingDefaultModel: true,
            ...(workspaceDir ? { workspaceDir } : {}),
            signal,
            isRemote: true,
            beforePersistentEffect: () => {
              signal.throwIfAborted();
              runnerSession.lockCancellation();
            },
          });
          if (!applied || applied.retrySelection) {
            throw new Error(
              `Provider setup resolution failed for "${params.authChoice}". Run \`openclaw doctor --fix\`, restart the Gateway, and try again.`,
            );
          }
          signal.throwIfAborted();
          runnerSession.lockCancellation();
          await setupShared.writeWizardConfigFile(applied.config, {
            allowConfigSizeDrop: false,
            baseSnapshot: snapshot,
            ...(snapshot.hash ? { baseHash: snapshot.hash } : {}),
          });
          if (applied.agentModelOverride) {
            runnerSession.setPreparedModelRef(applied.agentModelOverride);
          }
        });
      },
    });
  },
  /**
   * Structured onboarding: live-test one candidate and persist it on success.
   * Single-flight per gateway process because testing and persistence span
   * multiple config/plugin mutations. Concurrent callers fail fast instead of
   * queueing work that could outlive their RPC timeout. Verification failures never
   * commit a broken model; post-commit application failures explain the saved state.
   */
  "openclaw.setup.activate": async ({ params, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSystemAgentSetupActivateParams,
        "openclaw.setup.activate",
        respond,
      )
    ) {
      return;
    }
    try {
      await runExclusiveSystemAgentSetupActivation(async () => {
        const result = await activateGatewaySetupInference({
          kind: params.kind,
          ...(params.agentId ? { agentId: params.agentId } : {}),
          ...(params.modelRef !== undefined ? { modelRef: params.modelRef } : {}),
          ...(params.authChoice !== undefined ? { authChoice: params.authChoice } : {}),
          ...(params.apiKey !== undefined ? { apiKey: params.apiKey } : {}),
          ...(params.workspace !== undefined ? { workspace: params.workspace } : {}),
          surface: "gateway",
          runtime: gatewayWizardStepRuntime,
        });
        respond(true, result, undefined);
      });
    } catch (error) {
      if (!(error instanceof SetupAdmissionBusyError)) {
        throw error;
      }
      respondSetupAdmissionBusy(respond);
    }
  },
  "openclaw.chat": async ({ params: rawParams, respond, client, context }) => {
    const params = sanitizeSystemAgentChatParams(rawParams);
    if (!assertValidParams(params, validateSystemAgentChatParams, "openclaw.chat", respond)) {
      return;
    }
    const inputError = getSystemAgentChatInputError(params);
    if (inputError) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, inputError));
      return;
    }
    const pending = await runSystemAgentGatewayTask(async () => {
      const sessions = context.systemAgentSessions;
      const sessionId = params.sessionId;
      // Initialization, resets, turns, and approval application share this task owner.
      const ownerKey = resolveSystemAgentSessionOwnerKey({
        delegation: params.delegation,
        client,
      });
      if (!ownerKey) {
        if (isGatewayClientProfilePending(client)) {
          respond(false, undefined, authenticatedProfileUnavailableError());
          return undefined;
        }
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "OpenClaw caller identity unavailable."),
        );
        return undefined;
      }
      const boundSession = sessions.get(sessionId);
      if (boundSession && boundSession.ownerKey !== ownerKey) {
        // Structured invalidation details let clients with a persisted id mint a
        // fresh one instead of retry-looping against the foreign live session.
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "OpenClaw session belongs to another caller.", {
            details: buildSystemAgentSessionInvalidatedErrorDetails(),
          }),
        );
        return undefined;
      }
      if (params.reset) {
        const existing = sessions.get(sessionId);
        // Persist the reset first; a failed write must leave the live session intact.
        appendTranscriptReset();
        sessions.delete(sessionId);
        if (existing?.pendingApproval) {
          context.systemAgentApprovalManager?.expire(existing.pendingApproval.id, "session-reset");
        }
        await existing?.engine.dispose();
      }
      let session = sessions.get(sessionId);
      if ((params.wizardAnswer !== undefined || params.wizardCancel !== undefined) && !session) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            params.wizardCancel !== undefined
              ? "No active OpenClaw chat session is awaiting that wizard cancel."
              : "No active OpenClaw chat session is awaiting that wizard answer.",
            { details: buildSystemAgentSessionInvalidatedErrorDetails() },
          ),
        );
        return undefined;
      }
      let greetingAuditSequence: number | undefined;
      const welcomeOnly =
        params.wizardAnswer === undefined &&
        params.wizardCancel === undefined &&
        (params.message === undefined || !params.message.trim());
      if (!session) {
        const { verifySystemAgentInferenceWithFallback } =
          await import("../../system-agent/inference-fallback.js");
        const inference = await verifySystemAgentInferenceWithFallback({
          ...(params.delegation ? { requestingAgentId: params.delegation.agentId } : {}),
          runtime: defaultRuntime,
        });
        if (!inference.ok) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.UNAVAILABLE,
              `OpenClaw requires working inference: ${inference.error}`,
              {
                details: buildSystemAgentInferenceUnavailableErrorDetails(),
              },
            ),
          );
          return undefined;
        }
        // The gateway surface must never install/restart its own daemon; the
        // engine's setup path honors this via surface: "gateway".
        const engine = new SystemAgentChatEngine({
          surface: "gateway",
          verifiedInference: inference.binding,
          operatorApprovalOnly: params.delegation !== undefined,
          ...(params.delegation?.agentId ? { requesterAgentId: params.delegation.agentId } : {}),
        });
        // `reset: true` keeps the durable logbook but deliberately starts
        // model context clean; only ordinary fresh sessions receive its tail.
        if (!params.reset) {
          engine.seedHistory(
            readTranscriptTail(SYSTEM_AGENT_SEED_HISTORY_LIMIT, { afterLastReset: true }).map(
              ({ role, text }) => ({ role, text }),
            ),
          );
        }
        const welcomeHistoryStart = engine.historyLength();
        let persistWelcome = !welcomeOnly;
        let welcome: string;
        let welcomeQuestion: SystemAgentChatQuestion | undefined;
        try {
          if (params.welcomeVariant === "onboarding") {
            const onboardingWelcome = await buildOnboardingWelcome({ engine });
            welcome = onboardingWelcome.text;
            welcomeQuestion = onboardingWelcome.question;
          } else if (params.welcomeVariant === "new-agent") {
            welcome = buildNewAgentWelcome({ engine });
          } else {
            const overview = await engine.loadOverview();
            const facts = loadSystemAgentGreetingFacts();
            greetingAuditSequence = facts.auditSequence;
            persistWelcome ||= facts.recentExternalEdit;
            welcome = (
              await resolveSystemAgentGreeting({
                overview,
                facts,
                planner: (plannerParams) => engine.planGreeting(plannerParams),
                allowInference: welcomeOnly,
              })
            ).text;
            welcomeQuestion = buildSystemAgentGreetingQuestion(overview, facts);
            engine.noteAssistantMessage(welcome);
          }
        } catch (error) {
          await engine.dispose().catch(() => undefined);
          if (!isSystemAgentInferenceUnavailableError(error)) {
            throw error;
          }
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, error.message));
          return undefined;
        }
        // Passive welcomes are ephemeral; an external-edit alert must survive
        // before delivery acknowledges the audit cursor that would hide it.
        if (persistWelcome) {
          persistSystemAgentEngineHistory(engine, welcomeHistoryStart);
        }
        await evictOldestSession(sessions, context);
        session = {
          engine,
          welcome,
          ...(welcomeQuestion ? { welcomeQuestion } : {}),
          ...(greetingAuditSequence !== undefined
            ? { welcomeAuditSequence: greetingAuditSequence }
            : {}),
          lastUsedAt: Date.now(),
          ownerKey,
        };
        sessions.set(sessionId, session);
        if (welcomeOnly) {
          respond(
            true,
            {
              sessionId,
              reply: session.welcome,
              action: "none",
              ...(session.welcomeQuestion ? { question: session.welcomeQuestion } : {}),
            },
            undefined,
          );
          acknowledgeDeliveredSystemAgentWelcome(session);
          return undefined;
        }
      }
      session.lastUsedAt = Date.now();
      // Inline check (not `welcomeOnly`) so TS narrows params.message below.
      if (
        params.wizardAnswer === undefined &&
        params.wizardCancel === undefined &&
        (params.message === undefined || !params.message.trim())
      ) {
        respond(
          true,
          buildSystemAgentRejoinResult({
            sessionId,
            welcome: session.welcome,
            ...(session.welcomeQuestion ? { welcomeQuestion: session.welcomeQuestion } : {}),
            engine: session.engine,
          }),
          undefined,
        );
        acknowledgeDeliveredSystemAgentWelcome(session);
        return undefined;
      }
      const historyStart = session.engine.historyLength();
      let reply: Awaited<ReturnType<SystemAgentChatEngine["handle"]>>;
      let resolveProposal:
        | Awaited<ReturnType<typeof prepareDelegatedSystemAgentApproval>>
        | undefined;
      try {
        if (params.delegation) {
          resolveProposal = await prepareDelegatedSystemAgentApproval({
            context,
            sessions,
            session,
            sessionId,
            delegation: params.delegation,
          });
        }
        const turnReply = await runSystemAgentChatInput({
          engine: session.engine,
          input: params,
        });
        if (!turnReply) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "OpenClaw chat input is missing."),
          );
          return undefined;
        }
        reply = turnReply;
      } catch (error) {
        persistSystemAgentEngineHistory(session.engine, historyStart);
        if (error instanceof SystemAgentWizardAnswerError) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
          return undefined;
        }
        if (!isSystemAgentInferenceUnavailableError(error)) {
          throw error;
        }
        // A failed inference turn invalidates this conversation. Remove the
        // exact engine before cleanup so a retry must pass the live gate and
        // cannot resume partial proposal or CLI-session state.
        // Initialization failures stay unmarked because no live session existed.
        if (sessions.get(sessionId)?.engine === session.engine) {
          sessions.delete(sessionId);
        }
        try {
          await session.engine.dispose();
        } catch {
          // The inference error is authoritative; cleanup stays best-effort.
        }
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, error.message, {
            details: buildSystemAgentSessionInvalidatedErrorDetails(),
          }),
        );
        return undefined;
      }
      let pendingApproval: SystemAgentChatSession["pendingApproval"];
      if (resolveProposal) {
        const proposal = session.engine.getPendingOperatorProposal();
        if (proposal) {
          const resolution = await resolveProposal(proposal);
          if (resolution.kind === "completed") {
            reply = resolution.reply;
          } else {
            pendingApproval = resolution;
          }
        }
      }
      persistSystemAgentEngineHistory(session.engine, historyStart);
      if (pendingApproval) {
        return pendingApproval;
      }
      respond(true, buildSystemAgentChatResult({ sessionId, reply }), undefined);
      return undefined;
    });
    // Human waiting must retain the requesting tool, but release the task queue:
    // the approval owner reenters it to apply the exact proposal.
    if (pending) {
      const reply = await pending.completion;
      respond(true, buildSystemAgentChatResult({ sessionId: params.sessionId, reply }), undefined);
    }
  },
};
