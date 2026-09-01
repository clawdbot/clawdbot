// Gateway-lifetime dispatcher for plugin-bound external approval verification.
import { createHash, randomUUID } from "node:crypto";
import { formatErrorMessage } from "../infra/errors.js";
import type { ExecApprovalForwarder } from "../infra/exec-approval-forwarder.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import {
  clearExternalVerificationCompletionRuntime,
  setExternalVerificationCompletionRuntime,
} from "../plugins/external-verification-approval-runtime-state.js";
import type {
  PluginExternalVerificationAttempt,
  PluginExternalVerificationAttemptSnapshot,
  PluginExternalVerificationCompletionResult,
  PluginExternalVerificationContext,
} from "../plugins/external-verification-approval-types.js";
import { getPluginExternalApprovalVerifier } from "../plugins/hook-runner-global-state.js";
import { onPluginRegistryLifecycleChange } from "../plugins/registry-lifecycle.js";
import type { PluginExternalApprovalVerifierRegistration } from "../plugins/registry-types.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import type {
  ExecApprovalManager,
  OperatorApprovalLifecycleEvent,
} from "./exec-approval-manager.js";
import {
  getOperatorApprovalDetailed,
  type OperatorApprovalRecord,
} from "./operator-approval-store.js";
import {
  cancelRetiredExternalVerificationAttempt,
  completeExternalVerificationAttempt,
  failExternalVerificationAttempt,
  getExternalVerificationAttemptSnapshot,
  getExternalVerificationNativeActionState,
  resolveApprovalsCoveredBySessionGrant,
  startExternalVerificationAttempt,
} from "./plugin-external-verification-store.js";
import {
  publishAppliedApprovalResolution,
  type PluginApprovalIosPushDelivery,
} from "./server-methods/approval-publication.js";
import { buildApprovalSnapshot } from "./server-methods/approval.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const MAX_EXTERNAL_VERIFICATION_PRESENTATION_LENGTH = 8_192;
const MAX_EXTERNAL_VERIFICATION_PRESENTATIONS = 8;
const EXTERNAL_VERIFICATION_ERROR_CLASS_PATTERN = /^[A-Za-z][A-Za-z0-9._:-]{0,63}$/u;

type PresentExternalVerification = (message: string) => Promise<void>;

type LiveAttempt = {
  approvalId: string;
  controller: AbortController;
  presentations: string[];
  pluginId: string;
  ready: boolean;
  reviewerDeviceId?: string;
  verifierOwner: object;
};

type AttemptSetup = {
  approvalId: string;
  presentations: string[];
  reviewerDeviceId?: string;
  promise: Promise<{
    outcome: "started";
    attempt: PluginExternalVerificationAttemptSnapshot;
  }>;
};

type NativeAction = {
  approvalId: string;
  decision: "allow-once" | "allow-always";
  expectedAttemptId: string | null;
  interactionId: string;
  intent: "start" | "retry";
  pluginId: string;
  reviewerDeviceId?: string;
  token: string;
  verifierOwner: object;
};

export type PreparedExternalVerificationNativeAction = Pick<NativeAction, "intent" | "token">;

export type ExternalVerificationNativeDispatchResult = {
  outcome: "started" | "replay" | "stale-action";
  attempt: PluginExternalVerificationAttemptSnapshot;
  presentations: string[];
};

type ExternalVerificationRuntimeState = {
  active: PluginExternalVerificationRuntime | null;
};

const runtimeStateKey = Symbol.for("openclaw.plugin-external-verification-runtime");

function getRuntimeState(): ExternalVerificationRuntimeState {
  return resolveGlobalSingleton<ExternalVerificationRuntimeState>(runtimeStateKey, () => ({
    active: null,
  }));
}

function requireApprovalRecord(
  approvalId: string,
  databaseOptions?: OpenClawStateDatabaseOptions,
): OperatorApprovalRecord {
  const lookup = getOperatorApprovalDetailed({ id: approvalId, databaseOptions });
  if (lookup.outcome !== "found") {
    throw new Error("external verification approval is no longer available");
  }
  return lookup.record;
}

function snapshotAttemptWithRecord(
  attempt: PluginExternalVerificationAttemptSnapshot,
  record: OperatorApprovalRecord,
): PluginExternalVerificationAttemptSnapshot {
  return Object.freeze({
    ...attempt,
    context: Object.freeze({
      ...attempt.context,
      toolName: record.source.toolName ?? attempt.context.toolName,
      ...(record.source.toolCallId ? { toolCallId: record.source.toolCallId } : {}),
      ...(record.source.agentId ? { agentId: record.source.agentId } : {}),
      ...(record.source.sessionKey ? { sessionKey: record.source.sessionKey } : {}),
      ...(record.source.sessionId ? { sessionId: record.source.sessionId } : {}),
    }),
  });
}

function classifyExternalVerificationError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown-error";
  }
  try {
    const rawName: unknown = error.name;
    const name = typeof rawName === "string" ? rawName.trim() : "";
    return EXTERNAL_VERIFICATION_ERROR_CLASS_PATTERN.test(name) ? name : "unknown-error";
  } catch {
    return "unknown-error";
  }
}

export class PluginExternalVerificationRuntime {
  private readonly attemptSetups = new Map<string, AttemptSetup>();
  private context: GatewayRequestContext | null = null;
  private readonly liveAttempts = new Map<string, LiveAttempt>();
  private readonly nativeActionsByGeneration = new Map<string, NativeAction>();
  private readonly nativeActionsByToken = new Map<string, NativeAction>();
  private readonly verifierOwnerIds = new WeakMap<object, string>();
  private readonly stopRegistryLifecycleListener: () => void;

  constructor(
    private readonly params: {
      manager: ExecApprovalManager<PluginApprovalRequestPayload>;
      runtimeEpoch: string;
      forwarder?: ExecApprovalForwarder;
      iosPushDelivery?: PluginApprovalIosPushDelivery;
      databaseOptions?: OpenClawStateDatabaseOptions;
      publishResolution?: typeof publishAppliedApprovalResolution;
      resolveVerifier?: (pluginId: string) => PluginExternalApprovalVerifierRegistration | null;
    },
  ) {
    getRuntimeState().active = this;
    setExternalVerificationCompletionRuntime(this, (owner, pluginId, completion) =>
      this.complete(owner, pluginId, completion),
    );
    this.stopRegistryLifecycleListener = onPluginRegistryLifecycleChange(() =>
      this.revokeRetiredVerifierAttempts(),
    );
  }

  attachContext(context: GatewayRequestContext): void {
    this.context = context;
  }

  onApprovalLifecycle(event: OperatorApprovalLifecycleEvent): void {
    if (event.phase !== "terminal" || event.record.kind !== "plugin") {
      return;
    }
    this.abortApprovalAttempts(event.record.id, event.record.terminalReason ?? "approval-terminal");
    this.clearApprovalAttemptSetups(event.record.id);
    this.clearApprovalNativeActions(event.record.id);
  }

  private abortApprovalAttempts(approvalId: string, reason: string, exceptId?: string): void {
    for (const [attemptId, live] of this.liveAttempts) {
      if (live.approvalId !== approvalId || attemptId === exceptId) {
        continue;
      }
      live.controller.abort(new Error(`external verification cancelled: ${reason}`));
      this.liveAttempts.delete(attemptId);
    }
  }

  private clearApprovalNativeActions(approvalId: string): void {
    for (const [generation, action] of this.nativeActionsByGeneration) {
      if (action.approvalId !== approvalId) {
        continue;
      }
      this.nativeActionsByGeneration.delete(generation);
      this.nativeActionsByToken.delete(action.token);
    }
  }

  private clearApprovalAttemptSetups(approvalId: string): void {
    for (const [attemptId, setup] of this.attemptSetups) {
      if (setup.approvalId === approvalId) {
        this.attemptSetups.delete(attemptId);
      }
    }
  }

  /**
   * True while a reviewer's external ceremony for this approval is live in
   * this process. Run-end cleanup pins such approvals: the QR in the
   * reviewer's hand stays valid, the abandoned call itself never executes
   * (its waiter is gone), and the approval's own expiry still bounds it.
   */
  hasActiveCeremonyForApproval(approvalId: string): boolean {
    for (const live of this.liveAttempts.values()) {
      if (live.approvalId === approvalId) {
        return true;
      }
    }
    return false;
  }

  private resolveVerifier(pluginId: string): PluginExternalApprovalVerifierRegistration | null {
    return (this.params.resolveVerifier ?? getPluginExternalApprovalVerifier)(pluginId);
  }

  private getVerifierOwnerId(owner: object): string {
    const existing = this.verifierOwnerIds.get(owner);
    if (existing) {
      return existing;
    }
    const id = randomUUID();
    this.verifierOwnerIds.set(owner, id);
    return id;
  }

  private revokeRetiredVerifierAttempts(): void {
    for (const [attemptId, live] of this.liveAttempts) {
      let verifier: PluginExternalApprovalVerifierRegistration | null = null;
      try {
        verifier = this.resolveVerifier(live.pluginId);
      } catch {
        // Registry transitions must revoke the capability even if composition is unavailable.
      }
      if (verifier?.owner === live.verifierOwner) {
        continue;
      }
      cancelRetiredExternalVerificationAttempt({
        attemptId,
        pluginId: live.pluginId,
        databaseOptions: this.params.databaseOptions,
      });
      live.controller.abort(new Error("external verification cancelled: verifier-retired"));
      this.liveAttempts.delete(attemptId);
    }
    for (const [generation, action] of this.nativeActionsByGeneration) {
      let currentOwner: object | undefined;
      try {
        currentOwner = this.resolveVerifier(action.pluginId)?.owner;
      } catch {
        // A failed registry composition cannot preserve an issued capability.
      }
      if (currentOwner === action.verifierOwner) {
        continue;
      }
      this.nativeActionsByGeneration.delete(generation);
      this.nativeActionsByToken.delete(action.token);
    }
  }

  async start(params: {
    approvalId: string;
    decision: "allow-once" | "allow-always";
    interactionId: string;
    reviewerDeviceId?: string;
    present: PresentExternalVerification;
  }): Promise<PluginExternalVerificationAttemptSnapshot> {
    return (
      await this.startDetailed({
        ...params,
      })
    ).attempt;
  }

  private async startDetailed(params: {
    approvalId: string;
    decision: "allow-once" | "allow-always";
    interactionId: string;
    reviewerDeviceId?: string;
    nativeAction?: {
      intent: "start" | "retry";
      expectedAttemptId: string | null;
    };
    present: PresentExternalVerification;
  }): Promise<{
    outcome: "started" | "replay" | "stale-action";
    attempt: PluginExternalVerificationAttemptSnapshot;
  }> {
    const storeParams = {
      approvalId: params.approvalId,
      decision: params.decision,
      interactionId: params.interactionId,
      reviewerDeviceId: params.reviewerDeviceId,
      nativeAction: params.nativeAction,
      runtimeEpoch: this.params.runtimeEpoch,
      databaseOptions: this.params.databaseOptions,
    };
    let started = startExternalVerificationAttempt(storeParams);
    if (started.outcome === "approval-expired") {
      this.params.manager.expire(params.approvalId);
      started = startExternalVerificationAttempt(storeParams);
    }
    if (
      started.outcome !== "started" &&
      started.outcome !== "replay" &&
      started.outcome !== "stale-action"
    ) {
      throw new Error(`external verification unavailable: ${started.outcome}`);
    }
    if (!started.attempt) {
      throw new Error("external verification action is stale; prepare a fresh action");
    }
    const record = requireApprovalRecord(params.approvalId, this.params.databaseOptions);
    const attemptSnapshot = snapshotAttemptWithRecord(started.attempt, record);
    if (started.outcome === "replay" || started.outcome === "stale-action") {
      const setup = this.attemptSetups.get(attemptSnapshot.id);
      // Setup failure is already durable. Replay must return that terminal
      // attempt instead of rethrowing the first delivery's transient error.
      await setup?.promise.catch(() => undefined);
      const current = getExternalVerificationAttemptSnapshot({
        attemptId: attemptSnapshot.id,
        pluginId: attemptSnapshot.context.pluginId,
        databaseOptions: this.params.databaseOptions,
      });
      const replaySnapshot = current ? snapshotAttemptWithRecord(current, record) : attemptSnapshot;
      const live = this.liveAttempts.get(attemptSnapshot.id);
      const presentations =
        setup && setup.reviewerDeviceId === params.reviewerDeviceId
          ? setup.presentations
          : live && live.reviewerDeviceId === params.reviewerDeviceId
            ? live.presentations
            : [];
      if (!replaySnapshot.outcome) {
        for (const presentation of presentations) {
          await params.present(presentation);
        }
      }
      return {
        outcome: started.outcome,
        attempt: replaySnapshot,
      };
    }
    // The store has already cancelled an older attempt. Revoke its in-memory
    // presentation capability even when the replacement verifier is unavailable.
    this.clearApprovalAttemptSetups(attemptSnapshot.context.approvalId);
    this.abortApprovalAttempts(attemptSnapshot.context.approvalId, "reviewer-retry");
    let verifier: PluginExternalApprovalVerifierRegistration | null;
    try {
      verifier = this.resolveVerifier(attemptSnapshot.context.pluginId);
    } catch (error) {
      failExternalVerificationAttempt({
        attemptId: attemptSnapshot.id,
        pluginId: attemptSnapshot.context.pluginId,
        errorClass: classifyExternalVerificationError(error),
        databaseOptions: this.params.databaseOptions,
      });
      throw new Error(`external verifier lookup failed: ${formatErrorMessage(error)}`, {
        cause: error,
      });
    }
    if (!verifier) {
      failExternalVerificationAttempt({
        attemptId: attemptSnapshot.id,
        pluginId: attemptSnapshot.context.pluginId,
        errorClass: "verifier-unavailable",
        databaseOptions: this.params.databaseOptions,
      });
      throw new Error(
        `plugin '${attemptSnapshot.context.pluginId}' has no active external verifier`,
      );
    }
    const controller = new AbortController();
    let presentationCount = 0;
    const present = async ({ message }: { message: string }): Promise<void> => {
      if (controller.signal.aborted) {
        throw controller.signal.reason;
      }
      if (this.resolveVerifier(attemptSnapshot.context.pluginId)?.owner !== verifier.owner) {
        controller.abort(new Error("external verification cancelled: verifier-retired"));
        this.liveAttempts.delete(attemptSnapshot.id);
        throw controller.signal.reason;
      }
      const normalized = message.trim();
      if (!normalized || normalized.length > MAX_EXTERNAL_VERIFICATION_PRESENTATION_LENGTH) {
        throw new Error(
          `external verification presentation must be 1-${MAX_EXTERNAL_VERIFICATION_PRESENTATION_LENGTH} characters`,
        );
      }
      const live = this.liveAttempts.get(attemptSnapshot.id);
      if (!live) {
        throw new Error("external verifier was retired during presentation");
      }
      if (live.presentations.length >= MAX_EXTERNAL_VERIFICATION_PRESENTATIONS) {
        throw new Error(
          `external verification may present at most ${MAX_EXTERNAL_VERIFICATION_PRESENTATIONS} reviewer messages`,
        );
      }
      live.presentations.push(normalized);
      await params.present(normalized);
      presentationCount += 1;
      live.ready = true;
    };
    const attempt: PluginExternalVerificationAttempt = Object.freeze({
      ...attemptSnapshot,
      context: Object.freeze({ ...attemptSnapshot.context }),
      signal: controller.signal,
      present,
    });
    this.liveAttempts.set(attempt.id, {
      approvalId: attempt.context.approvalId,
      controller,
      presentations: [],
      pluginId: attempt.context.pluginId,
      ready: false,
      reviewerDeviceId: params.reviewerDeviceId,
      verifierOwner: verifier.owner,
    });
    const readPluginCompletion = (): PluginExternalVerificationAttemptSnapshot | null => {
      const completed = getExternalVerificationAttemptSnapshot({
        attemptId: attempt.id,
        pluginId: attempt.context.pluginId,
        databaseOptions: this.params.databaseOptions,
      });
      if (completed?.terminalSource !== "plugin-completion") {
        return null;
      }
      return snapshotAttemptWithRecord(
        completed,
        requireApprovalRecord(attempt.context.approvalId, this.params.databaseOptions),
      );
    };
    const setupPromise: AttemptSetup["promise"] = Promise.resolve().then(async () => {
      try {
        await verifier.handler(attempt);
        if (presentationCount === 0) {
          throw new Error("external verifier returned without presenting reviewer instructions");
        }
        const live = this.liveAttempts.get(attempt.id);
        if (!live) {
          const completed = readPluginCompletion();
          if (completed) {
            return { outcome: "started", attempt: completed };
          }
          throw new Error("external verifier was retired during setup");
        }
        return { outcome: "started", attempt: attemptSnapshot };
      } catch (error) {
        const completed = readPluginCompletion();
        if (completed) {
          return { outcome: "started", attempt: completed };
        }
        failExternalVerificationAttempt({
          attemptId: attempt.id,
          pluginId: attempt.context.pluginId,
          errorClass: classifyExternalVerificationError(error),
          databaseOptions: this.params.databaseOptions,
        });
        controller.abort(error);
        this.liveAttempts.delete(attempt.id);
        throw new Error(`external verifier failed: ${formatErrorMessage(error)}`, { cause: error });
      }
    });
    this.attemptSetups.set(attempt.id, {
      approvalId: attempt.context.approvalId,
      presentations: this.liveAttempts.get(attempt.id)?.presentations ?? [],
      reviewerDeviceId: params.reviewerDeviceId,
      promise: setupPromise,
    });
    return await setupPromise;
  }

  prepareNativeAction(params: {
    approvalId: string;
    decision: "allow-once" | "allow-always";
    reviewerDeviceId?: string;
  }): PreparedExternalVerificationNativeAction {
    const storeParams = {
      ...params,
      runtimeEpoch: this.params.runtimeEpoch,
      databaseOptions: this.params.databaseOptions,
    };
    let state = getExternalVerificationNativeActionState(storeParams);
    if (state.outcome === "approval-expired") {
      this.params.manager.expire(params.approvalId);
      state = getExternalVerificationNativeActionState(storeParams);
    }
    if (state.outcome !== "ready") {
      throw new Error(`external verification unavailable: ${state.outcome}`);
    }
    const record = requireApprovalRecord(params.approvalId, this.params.databaseOptions);
    const pluginId =
      record.presentation.kind === "plugin" ? record.presentation.pluginId?.trim() : "";
    const verifier = pluginId ? this.resolveVerifier(pluginId) : null;
    if (!pluginId || !verifier) {
      throw new Error("external verification verifier is not available");
    }
    const generation = JSON.stringify([
      params.approvalId,
      params.decision,
      state.action.intent,
      state.action.expectedAttemptId,
      this.getVerifierOwnerId(verifier.owner),
      params.reviewerDeviceId ?? null,
    ]);
    const existing = this.nativeActionsByGeneration.get(generation);
    if (existing) {
      return { intent: existing.intent, token: existing.token };
    }
    const token = `external-action:${randomUUID()}`;
    const action: NativeAction = {
      approvalId: params.approvalId,
      decision: params.decision,
      expectedAttemptId: state.action.expectedAttemptId,
      interactionId: createHash("sha256").update(token).digest("hex"),
      intent: state.action.intent,
      pluginId,
      reviewerDeviceId: params.reviewerDeviceId,
      token,
      verifierOwner: verifier.owner,
    };
    this.nativeActionsByGeneration.set(generation, action);
    this.nativeActionsByToken.set(token, action);
    return { intent: action.intent, token };
  }

  async dispatchNativeAction(params: {
    approvalId: string;
    decision: "allow-once" | "allow-always";
    reviewerDeviceId?: string;
    token: string;
  }): Promise<ExternalVerificationNativeDispatchResult> {
    const action = this.nativeActionsByToken.get(params.token);
    if (
      !action ||
      action.approvalId !== params.approvalId ||
      action.decision !== params.decision ||
      action.reviewerDeviceId !== params.reviewerDeviceId ||
      this.resolveVerifier(action.pluginId)?.owner !== action.verifierOwner
    ) {
      throw new Error("external verification action is invalid");
    }
    const presentations: string[] = [];
    const dispatched = await this.startDetailed({
      approvalId: action.approvalId,
      decision: action.decision,
      interactionId: action.interactionId,
      reviewerDeviceId: action.reviewerDeviceId,
      nativeAction: {
        intent: action.intent,
        expectedAttemptId: action.expectedAttemptId,
      },
      present: async (message) => {
        presentations.push(message);
      },
    });
    return {
      outcome: dispatched.outcome,
      attempt: dispatched.attempt,
      presentations,
    };
  }

  async complete(
    owner: object,
    pluginId: string,
    completion: { attemptId: string; outcome: "succeeded" | "failed" },
  ): Promise<PluginExternalVerificationCompletionResult> {
    const verifier = this.resolveVerifier(pluginId);
    if (!verifier || verifier.owner !== owner) {
      throw new Error("external verification attempt not found for this plugin instance");
    }
    const live = this.liveAttempts.get(completion.attemptId);
    if (live && !live.ready) {
      throw new Error(
        "external verification cannot complete before reviewer presentation finishes",
      );
    }
    if (
      !live &&
      !getExternalVerificationAttemptSnapshot({
        attemptId: completion.attemptId,
        pluginId,
        databaseOptions: this.params.databaseOptions,
      })?.outcome
    ) {
      throw new Error("external verification attempt is not active in this runtime");
    }
    const storeParams = {
      attemptId: completion.attemptId,
      pluginId,
      outcome: completion.outcome,
      runtimeEpoch: this.params.runtimeEpoch,
      databaseOptions: this.params.databaseOptions,
    };
    let stored = completeExternalVerificationAttempt(storeParams);
    if (stored.outcome === "approval-expired") {
      this.params.manager.expire(stored.approvalId);
      stored = completeExternalVerificationAttempt(storeParams);
    }
    if (stored.outcome === "approval-expired") {
      throw new Error("external verification approval expiry could not be reconciled");
    }
    if (stored.outcome === "attempt-not-found") {
      throw new Error("external verification attempt not found for this plugin");
    }
    const record = requireApprovalRecord(stored.approvalId, this.params.databaseOptions);
    const controlUiBasePath = normalizeControlUiBasePath(
      this.context?.getRuntimeConfig().gateway?.controlUi?.basePath,
    );
    const approval = buildApprovalSnapshot(record, controlUiBasePath);
    if (!approval) {
      throw new Error("external verification approval projection is unavailable");
    }
    if (stored.applied) {
      const liveRecord = this.params.manager.getLiveSnapshot(record.id) ?? undefined;
      this.params.manager.reconcileDurableTerminal(record);
      if (liveRecord && this.context) {
        try {
          await (this.params.publishResolution ?? publishAppliedApprovalResolution)({
            record,
            liveRecord,
            context: this.context,
            forwarder: this.params.forwarder,
            pluginIosPushDelivery: this.params.iosPushDelivery,
          });
        } catch (error) {
          this.context.logGateway?.error?.(
            `plugin approvals: external verification publication failed after durable completion: ${formatErrorMessage(error)}`,
          );
        }
      }
    }
    const completedLiveAttempt = this.liveAttempts.get(stored.attempt.id);
    if (completedLiveAttempt) {
      completedLiveAttempt.controller.abort(
        new Error(
          `external verification ${completion.outcome === "succeeded" ? "completed" : "failed"}`,
        ),
      );
      this.liveAttempts.delete(stored.attempt.id);
    }
    if (stored.applied && stored.grantAuthorization) {
      await this.applySessionGrantCoverage(stored.attempt.context, stored.grantAuthorization.id);
    }
    return {
      applied: stored.applied,
      approval,
      attempt: snapshotAttemptWithRecord(stored.attempt, record),
      ...(stored.grantAuthorization ? { grantAuthorization: stored.grantAuthorization } : {}),
    };
  }

  /**
   * An allow-always ceremony declares trust for matching actions in this
   * session; approvals already pending when it completed (including calls
   * racing the reviewer's scan) are covered by the grant instead of each
   * demanding a ceremony. The store records a synthetic succeeded attempt per
   * covered approval so the ledger explains the ceremonyless authorization.
   */
  private async applySessionGrantCoverage(
    context: PluginExternalVerificationContext,
    grantAuthorizationId: string,
  ): Promise<void> {
    const sessionKey = context.sessionKey?.trim();
    const sessionId = context.sessionId?.trim();
    if (!sessionKey || !sessionId) {
      return;
    }
    const covered = resolveApprovalsCoveredBySessionGrant({
      grantAuthorizationId,
      grantedApprovalId: context.approvalId,
      pluginId: context.pluginId,
      toolName: context.toolName,
      sessionKey,
      sessionId,
      runtimeEpoch: this.params.runtimeEpoch,
      databaseOptions: this.params.databaseOptions,
    });
    for (const { approvalId } of covered) {
      const coveredRecord = requireApprovalRecord(approvalId, this.params.databaseOptions);
      const liveRecord = this.params.manager.getLiveSnapshot(approvalId) ?? undefined;
      this.params.manager.reconcileDurableTerminal(coveredRecord);
      if (liveRecord && this.context) {
        try {
          await (this.params.publishResolution ?? publishAppliedApprovalResolution)({
            record: coveredRecord,
            liveRecord,
            context: this.context,
            forwarder: this.params.forwarder,
            pluginIosPushDelivery: this.params.iosPushDelivery,
          });
        } catch (error) {
          this.context.logGateway?.error?.(
            `plugin approvals: grant coverage publication failed after durable resolution: ${formatErrorMessage(error)}`,
          );
        }
      }
    }
    if (covered.length > 0) {
      this.context?.logGateway?.info?.(
        `plugin approvals: session grant covered ${covered.length} pending external verification approval(s)`,
      );
    }
  }

  shutdown(): void {
    if (getRuntimeState().active === this) {
      getRuntimeState().active = null;
    }
    this.stopRegistryLifecycleListener();
    const approvalIds = new Set([...this.liveAttempts.values()].map((live) => live.approvalId));
    for (const approvalId of approvalIds) {
      this.params.manager.forceDenyDetailed(
        approvalId,
        "gateway-restart",
        { kind: "system", id: null },
        "cancelled",
        null,
      );
    }
    // Terminal state must commit before plugin abort listeners run; otherwise
    // a synchronous listener could allow the action during shutdown.
    for (const live of this.liveAttempts.values()) {
      live.controller.abort(new Error("external verification cancelled: gateway-restart"));
    }
    clearExternalVerificationCompletionRuntime(this);
    this.liveAttempts.clear();
    this.attemptSetups.clear();
    this.nativeActionsByGeneration.clear();
    this.nativeActionsByToken.clear();
  }
}

export async function startExternalVerificationForReviewer(params: {
  approvalId: string;
  decision: "allow-once" | "allow-always";
  interactionId: string;
  reviewerDeviceId?: string;
  present: PresentExternalVerification;
}): Promise<PluginExternalVerificationAttemptSnapshot> {
  const runtime = getRuntimeState().active;
  if (!runtime) {
    throw new Error("external verification approval runtime is not available");
  }
  return await runtime.start(params);
}
