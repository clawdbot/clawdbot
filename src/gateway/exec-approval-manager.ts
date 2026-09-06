import { randomUUID } from "node:crypto";
import {
  resolveExpiresAtMsFromDurationMs,
  resolveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { buildApprovalPresentation } from "../infra/approval-presentation.js";
import type { ExecApprovalDecision, ExecApprovalRequestPayload } from "../infra/exec-approvals.js";
import {
  EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS,
  ExecApprovalLifecycle,
} from "./exec-approval-lifecycle.js";
import type {
  ExecApprovalDurableLookup,
  ExecApprovalForceDenyResult,
  ExecApprovalManagerOptions,
  ExecApprovalRecord,
  ExecApprovalResolutionSource,
  ExecApprovalResolveResult,
  OperatorApprovalLifecycleEvent,
} from "./exec-approval-manager.types.js";
import {
  consumeOperatorApprovalAllowOnce,
  forceDenyOperatorApproval,
  insertOperatorApproval,
  resolveOperatorApproval,
  type ForceDenyOperatorApprovalResult,
  type OperatorApprovalKind,
  type OperatorApprovalRecord,
  type OperatorApprovalResolver,
  type OperatorApprovalSource,
  type OperatorApprovalTerminalReason,
  type ResolveOperatorApprovalResult,
} from "./operator-approval-store.js";

export { EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS } from "./exec-approval-lifecycle.js";
export type {
  ExecApprovalIdLookupResult,
  ExecApprovalRecord,
  OperatorApprovalLifecycleEvent,
  OperatorStandingGrantMintSpec,
} from "./exec-approval-manager.types.js";

// These opaque ids cross terminal, UI, push, and channel surfaces unchanged.
const EXPLICIT_APPROVAL_ID_INVALID_CHAR_PATTERN = /[^A-Za-z0-9._:-]/;

/** Typed creation failure for an explicit approval id outside the shared safe format. */
export class InvalidApprovalIdError extends Error {
  readonly code = "EXEC_APPROVAL_ID_INVALID";
  readonly reason = "INVALID_APPROVAL_ID";

  constructor() {
    super(
      "approval id must be 1-128 characters using only letters, numbers, '.', '_', ':', or '-', and cannot be '.' or '..'",
    );
    this.name = "InvalidApprovalIdError";
  }
}

function readRequestString(request: unknown, key: string): string | null {
  const value = asOptionalObjectRecord(request)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Approval creation and persistence precede every local wait or delivery handoff. */
export class ExecApprovalManager<
  TPayload = ExecApprovalRequestPayload,
> extends ExecApprovalLifecycle<TPayload> {
  constructor(protected readonly options: ExecApprovalManagerOptions<TPayload>) {
    super();
  }

  get approvalKind(): OperatorApprovalKind {
    return this.options.approvalKind ?? "exec";
  }

  override get runtimeEpoch(): string {
    return this.options.persistence.runtimeEpoch;
  }

  private resolveApprovalSource(request: TPayload): OperatorApprovalSource {
    return {
      agentId: readRequestString(request, "agentId"),
      sessionKey: readRequestString(request, "sessionKey"),
      sessionId: readRequestString(request, "sessionId"),
      runId: readRequestString(request, "runId"),
      toolCallId: readRequestString(request, "toolCallId"),
      toolName: readRequestString(request, "toolName"),
    };
  }

  private allowedDecisionsForRequest(request: TPayload): ExecApprovalDecision[] {
    const decisions = this.options.resolveAllowedDecisions?.(request);
    const normalized: ExecApprovalDecision[] = [];
    for (const decision of decisions ?? ["allow-once", "allow-always", "deny"]) {
      if (
        (decision === "allow-once" || decision === "allow-always" || decision === "deny") &&
        !normalized.includes(decision)
      ) {
        normalized.push(decision);
      }
    }
    // Denial remains valid even when the request supplies malformed allowed decisions.
    if (!normalized.includes("deny")) {
      normalized.push("deny");
    }
    return normalized;
  }

  create(request: TPayload, timeoutMs: number, id?: string | null): ExecApprovalRecord<TPayload> {
    this.assertNotRetired();
    const now = Date.now();
    const resolvedTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 1);
    const expiresAtMs = resolveExpiresAtMsFromDurationMs(resolvedTimeoutMs, { nowMs: now });
    if (expiresAtMs === undefined) {
      throw new Error("approval expiry is unavailable");
    }
    // Empty remains the caller-facing sentinel for manager-generated ids.
    const hasExplicitId = id !== null && id !== undefined && id.length > 0;
    if (
      hasExplicitId &&
      (id.length > 128 ||
        id === "." ||
        id === ".." ||
        EXPLICIT_APPROVAL_ID_INVALID_CHAR_PATTERN.test(id))
    ) {
      throw new InvalidApprovalIdError();
    }
    return {
      id: hasExplicitId ? id : randomUUID(),
      request,
      createdAtMs: now,
      expiresAtMs,
    };
  }

  /** Synchronously persists/registers the request before returning its authority promise. */
  register(
    record: ExecApprovalRecord<TPayload>,
    _timeoutMs: number,
  ): Promise<ExecApprovalDecision | null> {
    this.assertNotRetired();
    if (
      record.agentRuntimeDelegatedAuthority &&
      this.options.validateAgentRuntimeDelegatedAuthority?.(
        record.agentRuntimeDelegatedAuthority,
      ) !== true
    ) {
      throw new Error("agent runtime approval authority is no longer active");
    }
    if (record.approvalAuthority && record.approvalAuthority() === false) {
      throw new Error("approval authority is no longer active");
    }
    const persistence = this.options.persistence;
    const presentation = buildApprovalPresentation({
      kind: this.approvalKind,
      request: record.request,
      allowedDecisions: this.allowedDecisionsForRequest(record.request),
    });
    if (!presentation) {
      throw new Error("approval cannot be persisted without a valid reviewer presentation");
    }
    const existing = this.pending.get(record.id);
    if (existing) {
      if (existing.record.resolvedAtMs === undefined) {
        return existing.promise;
      }
      throw new Error(`approval id '${record.id}' already resolved`);
    }

    const source = this.resolveApprovalSource(record.request);
    let audienceSessionKeys: string[] = [];
    if (source.sessionKey) {
      // Gateway owns lineage resolution; without it only the source is included.
      audienceSessionKeys = this.options.resolveAudienceSessionKeys?.(
        source.sessionKey,
        source.agentId,
      ) ?? [source.sessionKey];
    }
    const inserted = insertOperatorApproval({
      approval: {
        id: record.id,
        kind: this.approvalKind,
        presentation,
        requester: {
          deviceId: record.requestedByDeviceId,
          clientId: record.requestedByClientId,
          deviceTokenAuth: record.requestedByDeviceTokenAuth === true,
        },
        reviewerDeviceIds: record.approvalReviewerDeviceIds,
        source,
        audienceSessionKeys,
        runtimeEpoch: persistence.runtimeEpoch,
        createdAtMs: record.createdAtMs,
        expiresAtMs: record.expiresAtMs,
        ...(record.executionIdentityToken
          ? { executionIdentityToken: record.executionIdentityToken }
          : {}),
      },
      databaseOptions: persistence.databaseOptions,
    });
    if (inserted.outcome === "conflict") {
      throw new Error(`approval id '${record.id}' conflicts with persisted state`);
    }
    const promise = this.registerEntry(record);
    for (const signal of record.approvalSignals ?? []) {
      if (signal.aborted) {
        this.forceDenyIfRuntimeAuthorityClosed(record.id);
        continue;
      }
      signal.addEventListener(
        "abort",
        () => {
          const closed = this.forceDenyIfRuntimeAuthorityClosed(record.id);
          if (closed?.outcome === "denied" && closed.liveRecord) {
            this.options.onExpired?.(closed.record, closed.liveRecord);
          }
        },
        { once: true },
      );
    }
    if (inserted.outcome === "inserted") {
      this.emitLifecycle({ phase: "pending", record: inserted.record });
    }
    return promise;
  }

  private isRuntimeAuthorityActive(record: ExecApprovalRecord<TPayload>): boolean {
    const delegated = record.agentRuntimeDelegatedAuthority;
    if (delegated && this.options.validateAgentRuntimeDelegatedAuthority?.(delegated) !== true) {
      return false;
    }
    if (record.approvalSignals?.some((signal) => signal.aborted)) {
      return false;
    }
    try {
      return record.approvalAuthority?.() !== false;
    } catch {
      return false;
    }
  }

  private emitLifecycle(event: OperatorApprovalLifecycleEvent): void {
    try {
      this.options.onLifecycle?.(event);
    } catch {
      // Stream fanout is observational. It must never change approval truth or
      // prevent the durable first-answer transition from releasing its waiter.
    }
  }

  /** Persist the first verdict, then release the process-local waiter. */
  resolveDetailed(
    recordId: string,
    decision: ExecApprovalDecision,
    resolver: OperatorApprovalResolver,
    localResolvedBy: string | null = null,
    localResolutionSource: ExecApprovalResolutionSource = "operator",
    options: {
      /** Explicit grant expiry override; undefined defers to the configured default. */
      grantExpiresAtMs?: number | null;
    } = {},
  ): ExecApprovalResolveResult<TPayload> {
    if (this.retired) {
      return { outcome: "not-found" };
    }
    if (decision !== "deny") {
      const closed = this.forceDenyIfRuntimeAuthorityClosed(recordId);
      if (closed) {
        if (closed.outcome === "not-found" || closed.outcome === "corrupt") {
          return closed;
        }
        return {
          outcome: "already-resolved",
          retry: "conflict",
          record: closed.record,
          ...(closed.liveRecord ? { liveRecord: closed.liveRecord } : {}),
        };
      }
    }
    const persistence = this.options.persistence;
    const localEntry = this.pending.get(recordId);
    if (localEntry?.record.terminalReason === "storage-corrupt") {
      const repaired = this.persistStorageCorruptDeny(recordId);
      if (repaired.outcome === "expired") {
        return repaired;
      }
      if (repaired.outcome === "not-found" || repaired.outcome === "corrupt") {
        return repaired;
      }
      if (repaired.outcome === "denied" && decision === "deny") {
        return {
          outcome: "resolved",
          record: repaired.record,
          ...(repaired.liveRecord ? { liveRecord: repaired.liveRecord } : {}),
        };
      }
      return {
        outcome: "already-resolved",
        retry: repaired.record.decision === decision ? "same" : "conflict",
        record: repaired.record,
        ...(repaired.liveRecord ? { liveRecord: repaired.liveRecord } : {}),
      };
    }
    if (decision !== "deny" && !localEntry) {
      return { outcome: "not-found" };
    }

    let standingGrantSpec =
      decision === "allow-always" && localEntry
        ? (this.options.resolveStandingGrantMint?.(localEntry.record.request) ?? undefined)
        : undefined;
    if (
      standingGrantSpec?.kind === "mcp-tool" &&
      localEntry?.record.mcpToolApprovalActive?.() !== true
    ) {
      standingGrantSpec = undefined;
    }
    const standingGrant = standingGrantSpec
      ? {
          ...standingGrantSpec,
          expiresAtMs:
            options.grantExpiresAtMs !== undefined
              ? options.grantExpiresAtMs
              : (this.options.resolveStandingGrantExpiresAtMs?.(Date.now()) ?? null),
        }
      : undefined;
    let result: ResolveOperatorApprovalResult;
    try {
      result = resolveOperatorApproval({
        id: recordId,
        decision,
        resolver,
        expectedKind: this.approvalKind,
        runtimeEpoch: persistence.runtimeEpoch,
        databaseOptions: persistence.databaseOptions,
        ...(standingGrant?.kind === "cron" ? { standingGrant } : {}),
        ...(standingGrant?.kind === "mcp-tool" ? { mcpToolGrant: standingGrant } : {}),
      });
    } catch (error) {
      this.settleLocalStorageFailure(recordId);
      throw error;
    }

    if (result.outcome === "resolved" && standingGrant?.kind === "placement") {
      this.options.retainPlacementStandingGrant?.({
        ...standingGrant,
        approvalId: recordId,
        nowMs: result.record.resolvedAtMs ?? Date.now(),
      });
    }
    if (
      result.outcome === "resolved" ||
      result.outcome === "expired" ||
      result.outcome === "already-resolved"
    ) {
      // The caller's source only applies when its own CAS won; a lost race or
      // expiry settles with the durable winner, which is an operator decision.
      this.settleLocalFromStore(
        result.record,
        undefined,
        localResolvedBy,
        result.outcome === "resolved" ? localResolutionSource : "operator",
      );
    } else if (result.outcome === "not-found" || result.outcome === "corrupt") {
      this.settleLocalStorageFailure(recordId);
    }
    return "record" in result && localEntry ? { ...result, liveRecord: localEntry.record } : result;
  }

  /** Persist a fail-closed terminal state, then release the local waiter. */
  forceDenyDetailed(
    recordId: string,
    reason: OperatorApprovalTerminalReason,
    resolver: OperatorApprovalResolver,
    status: "denied" | "expired" | "cancelled" = "denied",
    localDecision?: ExecApprovalDecision | null,
    requireDue = false,
    localResolvedBy: string | null = null,
  ): ExecApprovalForceDenyResult<TPayload> {
    if (this.retired) {
      return { outcome: "not-found" };
    }
    const persistence = this.options.persistence;
    const localRecord = this.pending.get(recordId)?.record;
    if (localRecord?.terminalReason === "storage-corrupt") {
      return this.persistStorageCorruptDeny(recordId);
    }

    let result: ForceDenyOperatorApprovalResult;
    try {
      result = forceDenyOperatorApproval({
        id: recordId,
        status,
        requireDue,
        reason,
        resolver,
        expectedKind: this.approvalKind,
        runtimeEpoch: persistence.runtimeEpoch,
        databaseOptions: persistence.databaseOptions,
      });
    } catch (error) {
      this.settleLocalStorageFailure(recordId);
      throw error;
    }
    if (result.outcome === "denied") {
      this.settleLocalFromStore(result.record, localDecision, localResolvedBy);
    } else if (result.outcome === "expired" || result.outcome === "already-terminal") {
      this.settleLocalFromStore(result.record, undefined, localResolvedBy);
    } else if (result.outcome === "not-found" || result.outcome === "corrupt") {
      this.settleLocalStorageFailure(recordId);
    }
    return "record" in result && localRecord ? { ...result, liveRecord: localRecord } : result;
  }

  private settleLocalFromStore(
    record: OperatorApprovalRecord,
    localDecision?: ExecApprovalDecision | null,
    localResolvedBy: string | null = null,
    localResolutionSource: ExecApprovalResolutionSource = "operator",
  ): boolean {
    const persistence = this.options.persistence;
    const liveRecord = this.pending.get(record.id)?.record;
    if (
      record.kind !== this.approvalKind ||
      record.runtimeEpoch !== persistence.runtimeEpoch ||
      record.status === "pending" ||
      record.resolvedAtMs === null
    ) {
      return false;
    }
    const decision =
      localDecision === undefined
        ? record.status === "allowed" || record.status === "denied"
          ? record.decision
          : null
        : localDecision;
    const settled = this.settleLocalEntry({
      recordId: record.id,
      decision,
      resolvedAtMs: record.resolvedAtMs,
      resolvedBy: localResolvedBy,
      resolverKind: record.resolver?.kind ?? null,
      status: record.status,
      terminalReason: record.terminalReason,
      consumedAtMs: record.consumedAtMs,
      consumedBy: record.consumedBy,
      resolutionSource: localResolutionSource,
    });
    if (settled) {
      this.emitLifecycle({ phase: "terminal", record });
      if (record.status === "expired" && liveRecord) {
        try {
          this.options.onExpired?.(record, liveRecord);
        } catch (error) {
          this.reportError(error, { approvalId: record.id, operation: "expire" });
        }
      }
    }
    return settled;
  }

  /** Settle one durable terminal transition and report whether this manager published it. */
  reconcileDurableTerminal(record: OperatorApprovalRecord): boolean {
    return this.settleLocalFromStore(record);
  }

  /** Reconciles durable truth with an existing waiter without rehydrating its request. */
  reconcileDurableLookup(
    lookup: ExecApprovalDurableLookup,
    localResolvedBy: string | null = null,
  ): OperatorApprovalRecord | null {
    if (this.retired) {
      return null;
    }
    const recordId = lookup.outcome === "found" ? lookup.record.id : lookup.id;
    const entry = this.pending.get(recordId);
    if (lookup.outcome !== "found") {
      if (entry) {
        this.settleLocalStorageFailure(recordId);
      }
      return null;
    }
    const persistence = this.options.persistence;
    if (
      !entry ||
      lookup.record.kind !== this.approvalKind ||
      lookup.record.runtimeEpoch !== persistence.runtimeEpoch
    ) {
      return lookup.record;
    }
    if (lookup.record.status === "pending" && entry.record.terminalReason === "storage-corrupt") {
      const repaired = this.persistStorageCorruptDeny(recordId);
      return "record" in repaired ? repaired.record : null;
    }
    if (lookup.record.status !== "pending") {
      this.settleLocalFromStore(lookup.record, undefined, localResolvedBy);
    }
    return lookup.record;
  }

  private settleLocalStorageFailure(recordId: string): void {
    this.settleLocalEntry({
      recordId,
      decision: "deny",
      resolvedAtMs: Date.now(),
      resolvedBy: "storage-error",
      resolverKind: "system",
      status: "denied",
      terminalReason: "storage-corrupt",
      retainForManagerLifetime: true,
    });
  }

  private persistStorageCorruptDeny(recordId: string): ExecApprovalForceDenyResult<TPayload> {
    const localEntry = this.pending.get(recordId);
    const persistence = this.options.persistence;
    if (!localEntry) {
      return { outcome: "not-found" };
    }
    const result = forceDenyOperatorApproval({
      id: recordId,
      status: "denied",
      reason: "storage-corrupt",
      resolver: { kind: "system", id: "storage-error" },
      expectedKind: this.approvalKind,
      runtimeEpoch: persistence.runtimeEpoch,
      databaseOptions: persistence.databaseOptions,
    });
    if (result.outcome === "denied" || result.outcome === "expired") {
      this.emitLifecycle({ phase: "terminal", record: result.record });
    }
    return "record" in result ? { ...result, liveRecord: localEntry.record } : result;
  }

  protected override reportError(
    error: unknown,
    context: { approvalId: string; operation: "expire" },
  ): void {
    const onError = this.options.onError;
    if (!onError) {
      return;
    }
    try {
      onError(error instanceof Error ? error : new Error(String(error)), {
        ...context,
        approvalKind: this.approvalKind,
      });
    } catch {
      // Error reporting must not turn a fail-closed timeout into an uncaught timer exception.
    }
  }

  protected override expireDue(recordId: string): boolean {
    if (this.retired) {
      return false;
    }
    const entry = this.pending.get(recordId);
    if (!entry || entry.record.resolvedAtMs !== undefined) {
      return false;
    }
    const result = this.forceDenyDetailed(
      recordId,
      "timeout",
      { kind: "system", id: null },
      "expired",
      undefined,
      true,
    );
    if (result.outcome === "not-due") {
      this.scheduleExpiryTimer(entry);
      return false;
    }
    return result.outcome === "denied" || result.outcome === "expired";
  }

  resolve(
    recordId: string,
    decision: ExecApprovalDecision,
    resolvedBy?: string | null,
    options: { grantExpiresAtMs?: number | null } = {},
  ): boolean {
    return (
      this.resolveDetailed(
        recordId,
        decision,
        {
          kind: "runtime",
          id: resolvedBy ?? null,
        },
        resolvedBy ?? null,
        "operator",
        options,
      ).outcome === "resolved"
    );
  }

  /**
   * Trusted auto-review resolution (identity-matched approval runtime).
   * Always allow-once; system.run replay validation treats the resulting
   * record more strictly than an operator decision (see #103515).
   */
  resolveAutoReview(recordId: string, resolvedBy?: string | null): boolean {
    return (
      this.resolveDetailed(
        recordId,
        "allow-once",
        {
          kind: "runtime",
          id: resolvedBy ?? null,
        },
        resolvedBy ?? null,
        "auto-review",
      ).outcome === "resolved"
    );
  }

  /**
   * One-shot ask-fallback re-admission for a timed-out approval. This is
   * pre-gate policy on the process-local record only: the durable row stays
   * `expired` and no execution authority is minted here. The shipped askFallback
   * policy (docs/tools/exec-approvals.md) still applies; system.run replay
   * uses this flag to keep re-admission single-use.
   */
  consumeAskFallback(recordId: string): boolean {
    const entry = this.pending.get(recordId);
    if (!entry) {
      return false;
    }
    const record = entry.record;
    if (
      record.resolvedAtMs === undefined ||
      record.decision !== undefined ||
      record.consumedDecision !== undefined ||
      record.askFallbackConsumed === true ||
      // Only unanswered approvals (timeout or no delivery route) are
      // re-admissible. Cancelled/fenced records also end decision-less, but
      // their authority closed deliberately — never replay through them.
      (record.status !== "expired" && record.terminalReason !== "no-route")
    ) {
      return false;
    }
    record.askFallbackConsumed = true;
    return true;
  }

  expire(recordId: string, resolvedBy?: string | null): boolean {
    const noRoute = resolvedBy === "no-approval-route";
    return (
      this.forceDenyDetailed(
        recordId,
        noRoute ? "no-route" : "timeout",
        { kind: "system", id: resolvedBy ?? null },
        noRoute ? "denied" : "expired",
        noRoute ? null : undefined,
        false,
        resolvedBy ?? null,
      ).outcome === "denied"
    );
  }

  consumeAllowOnce(recordId: string, consumerId = recordId): boolean {
    // Retirement preserves consumption only inside an already-owned genuine handoff.
    if (!this.canUseRetainedBinding() || this.forceDenyIfRuntimeAuthorityClosed(recordId)) {
      return false;
    }
    const entry = this.pending.get(recordId);
    if (!entry) {
      return false;
    }
    const nowMs = Date.now();
    const resolvedAtMs = entry.record.resolvedAtMs;
    const graceAnchorMs = this.resolvedGraceAnchorMs(entry, nowMs);
    // Durable records are audit/control-plane truth, not executable capability
    // material. Redemption requires the live waiter entry and its requester binding.
    if (
      resolvedAtMs === undefined ||
      graceAnchorMs === null ||
      nowMs - graceAnchorMs >= EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS ||
      entry.record.decision !== "allow-once" ||
      entry.record.consumedDecision
    ) {
      return false;
    }
    const persistence = this.options.persistence;
    const result = consumeOperatorApprovalAllowOnce({
      id: recordId,
      consumerId,
      expectedKind: this.approvalKind,
      runtimeEpoch: persistence.runtimeEpoch,
      redemptionWindowMs:
        EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS + Math.max(0, graceAnchorMs - resolvedAtMs),
      databaseOptions: persistence.databaseOptions,
    });
    if (result.outcome !== "consumed") {
      return false;
    }
    // Keep the winning decision for audit/retry reporting; consumedDecision
    // is the process-local replay guard during the resolved grace window.
    entry.record.consumedDecision = "allow-once";
    entry.record.consumedAtMs = result.record.consumedAtMs;
    entry.record.consumedBy = result.record.consumedBy;
    return true;
  }

  /** Observes a registered decision; Gateway closure rejects the wait, not the approval. */
  awaitDecision(recordId: string): Promise<ExecApprovalDecision | null> | null {
    this.assertNotRetired();
    this.forceDenyIfRuntimeAuthorityClosed(recordId);
    if (!this.getSnapshot(recordId)) {
      return null;
    }
    const entry = this.pending.get(recordId);
    return entry ? this.observeEntry(entry, entry.promise) : null;
  }

  /** Projects an allowed decision only while its exact runtime authority is live. */
  projectDecisionIfActive(
    recordId: string,
    decision: ExecApprovalDecision | null,
  ): ExecApprovalDecision | null {
    if (decision !== "allow-once" && decision !== "allow-always") {
      return decision;
    }
    if (!this.canUseRetainedBinding()) {
      return null;
    }
    const record = this.pending.get(recordId)?.record;
    if (!record) {
      // Durable approval truth is not executable authority. Once the local
      // binding is gone, stale handoffs must fail closed even if they kept its verdict.
      return null;
    }
    if (this.isRuntimeAuthorityActive(record)) {
      return decision;
    }
    // Durable first-answer truth remains auditable even when closure races an
    // already-allowed row. Executable projection fails closed at this handoff.
    this.forceDenyIfRuntimeAuthorityClosed(recordId);
    return null;
  }

  /** Atomically closes a live approval whose exact runtime owner is gone. */
  forceDenyIfRuntimeAuthorityClosed(
    recordId: string,
  ): ExecApprovalForceDenyResult<TPayload> | null {
    const record = this.pending.get(recordId)?.record;
    if (!record || this.isRuntimeAuthorityActive(record)) {
      return null;
    }
    return this.forceDenyDetailed(
      recordId,
      "run-aborted",
      { kind: "system", id: null },
      "cancelled",
    );
  }
}
