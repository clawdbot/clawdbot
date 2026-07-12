// Gateway exec approval manager.
// Tracks pending operator decisions and short-lived resolved approval records.
import { randomUUID } from "node:crypto";
import { resolveExpiresAtMsFromDurationMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { buildApprovalPresentation } from "../infra/approval-presentation.js";
import { buildApprovalResolutionRef } from "../infra/approval-resolution-ref.js";
import type {
  ExecApprovalDecision,
  ExecApprovalRequestPayload as InfraExecApprovalRequestPayload,
} from "../infra/exec-approvals.js";
import { resolveTimerTimeoutMs } from "../shared/number-coercion.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
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
  type OperatorApprovalStatus,
  type OperatorApprovalTerminalReason,
  type ResolveOperatorApprovalResult,
} from "./operator-approval-store.js";

// Grace period to keep resolved entries for late awaitDecision calls.
// Exported because system.run timeout replay bounds its ask-fallback window
// to the same anchor; drifting values would widen or starve that window.
export const EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS = 15_000;

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const unref = (timer as { unref?: () => void }).unref;
  if (typeof unref === "function") {
    unref.call(timer);
  }
}

function scheduleResolvedEntryCleanup(cleanup: () => void): ReturnType<typeof setTimeout> {
  // Resolved approvals stay visible briefly so node.invoke sanitizers can
  // consume a just-approved id after the UI decision races the command retry.
  const timer = setTimeout(cleanup, EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS);
  unrefTimer(timer);
  return timer;
}

function resolveApprovalTimeoutMs(timeoutMs: number): number {
  return resolveTimerTimeoutMs(timeoutMs, 1);
}

type ExecApprovalRequestPayload = InfraExecApprovalRequestPayload;

// Distinguishes operator decisions from trusted auto-review resolutions.
// system.run replay validation is stricter for auto-review approvals, so this
// runtime fact must survive on the process-local record (bindings never persist).
export type ExecApprovalResolutionSource = "operator" | "auto-review";

export type ExecApprovalRecord<TPayload = ExecApprovalRequestPayload> = {
  id: string;
  request: TPayload;
  createdAtMs: number;
  expiresAtMs: number;
  // Caller metadata (best-effort). Used to prevent other clients from replaying an approval id.
  requestedByConnId?: string | null;
  requestedByDeviceId?: string | null;
  requestedByClientId?: string | null;
  requestedByDeviceTokenAuth?: boolean;
  approvalReviewerDeviceIds?: string[];
  resolvedAtMs?: number;
  decision?: ExecApprovalDecision;
  consumedDecision?: ExecApprovalDecision;
  resolutionSource?: ExecApprovalResolutionSource;
  askFallbackConsumed?: boolean;
  resolvedBy?: string | null;
  status?: OperatorApprovalStatus;
  terminalReason?: OperatorApprovalTerminalReason | null;
  runtimeEpoch?: string;
  resolverKind?: OperatorApprovalResolver["kind"] | null;
  consumedAtMs?: number | null;
  consumedBy?: string | null;
};

export type OperatorApprovalPersistenceRuntime = {
  runtimeEpoch: string;
  databaseOptions?: OpenClawStateDatabaseOptions;
};

export type ExecApprovalManagerOptions<TPayload> = {
  approvalKind?: OperatorApprovalKind;
  persistence?: OperatorApprovalPersistenceRuntime;
  resolveAllowedDecisions?: (request: TPayload) => readonly ExecApprovalDecision[];
  resolveAudienceSessionKeys?: (sourceSessionKey: string) => string[];
  onError?: (
    error: Error,
    context: { approvalId: string; approvalKind: OperatorApprovalKind; operation: "expire" },
  ) => void;
};

type WithLiveRecord<TResult, TPayload> = TResult extends { record: OperatorApprovalRecord }
  ? TResult & { liveRecord?: ExecApprovalRecord<TPayload> }
  : TResult;

export type ExecApprovalResolveResult<TPayload = ExecApprovalRequestPayload> = WithLiveRecord<
  ResolveOperatorApprovalResult,
  TPayload
>;

export type ExecApprovalForceDenyResult<TPayload = ExecApprovalRequestPayload> = WithLiveRecord<
  ForceDenyOperatorApprovalResult,
  TPayload
>;

export type ExecApprovalDurableLookup =
  | { outcome: "found"; record: OperatorApprovalRecord }
  | { outcome: "missing" | "corrupt"; id: string };

type PendingEntry<TPayload = ExecApprovalRequestPayload> = {
  record: ExecApprovalRecord<TPayload>;
  resolve: (decision: ExecApprovalDecision | null) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  handoffRetainCount: number;
  handoffReleasedAtMs: number | null;
  retainForManagerLifetime: boolean;
  promise: Promise<ExecApprovalDecision | null>;
};

export type ExecApprovalIdLookupResult =
  | { kind: "exact" | "prefix"; id: string }
  | { kind: "ambiguous"; ids: string[] }
  | { kind: "none" };

function readRequestString(request: unknown, key: string): string | null {
  if (typeof request !== "object" || request === null) {
    return null;
  }
  const value = (request as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function resolveApprovalSource(request: unknown): OperatorApprovalSource {
  return {
    agentId: readRequestString(request, "agentId"),
    sessionKey: readRequestString(request, "sessionKey"),
    sessionId: readRequestString(request, "sessionId"),
    runId: readRequestString(request, "runId"),
    toolCallId: readRequestString(request, "toolCallId"),
    toolName: readRequestString(request, "toolName"),
  };
}

function normalizeAllowedDecisions(
  decisions: readonly ExecApprovalDecision[] | undefined,
): ExecApprovalDecision[] {
  const normalized: ExecApprovalDecision[] = [];
  for (const decision of decisions ?? ["allow-once", "allow-always", "deny"]) {
    if (
      (decision === "allow-once" || decision === "allow-always" || decision === "deny") &&
      !normalized.includes(decision)
    ) {
      normalized.push(decision);
    }
  }
  // Denial is always a valid fail-closed verdict, including for malformed input.
  if (!normalized.includes("deny")) {
    normalized.push("deny");
  }
  return normalized;
}

function attachLiveRecord<TPayload, TResult extends { outcome: string }>(
  result: TResult,
  liveRecord: ExecApprovalRecord<TPayload> | undefined,
): WithLiveRecord<TResult, TPayload> {
  if (!("record" in result) || !liveRecord) {
    return result as WithLiveRecord<TResult, TPayload>;
  }
  return {
    ...result,
    liveRecord,
  } as WithLiveRecord<TResult, TPayload>;
}

// Without `persistence` the manager runs process-local-only. Gateway
// production always injects persistence (server-aux-handlers); local mode
// exists for unit tests and is slated for removal once the embedded broker
// migrates onto the durable store — do not grow it new behavior.
export class ExecApprovalManager<TPayload = ExecApprovalRequestPayload> {
  private pending = new Map<string, PendingEntry<TPayload>>();

  constructor(private readonly options: ExecApprovalManagerOptions<TPayload> = {}) {}

  get approvalKind(): OperatorApprovalKind {
    return this.options.approvalKind ?? "exec";
  }

  get runtimeEpoch(): string | null {
    return this.options.persistence?.runtimeEpoch ?? null;
  }

  create(request: TPayload, timeoutMs: number, id?: string | null): ExecApprovalRecord<TPayload> {
    const now = Date.now();
    const resolvedTimeoutMs = resolveApprovalTimeoutMs(timeoutMs);
    const expiresAtMs = resolveExpiresAtMsFromDurationMs(resolvedTimeoutMs, { nowMs: now });
    if (expiresAtMs === undefined) {
      throw new Error("approval expiry is unavailable");
    }
    const resolvedId = id === null || id === undefined || id.length === 0 ? randomUUID() : id;
    const record: ExecApprovalRecord<TPayload> = {
      id: resolvedId,
      request,
      createdAtMs: now,
      expiresAtMs,
    };
    return record;
  }

  /**
   * Register an approval record and return a promise that resolves when the decision is made.
   * This separates registration (synchronous) from waiting (async), allowing callers to
   * confirm registration before the decision is made.
   */
  register(
    record: ExecApprovalRecord<TPayload>,
    _timeoutMs: number,
  ): Promise<ExecApprovalDecision | null> {
    const persistence = this.options.persistence;
    const allowedDecisions = persistence
      ? normalizeAllowedDecisions(this.options.resolveAllowedDecisions?.(record.request))
      : null;
    const presentation = persistence
      ? buildApprovalPresentation({
          kind: this.approvalKind,
          request: record.request,
          allowedDecisions: allowedDecisions ?? [],
        })
      : null;
    if (persistence && !presentation) {
      // No durable row or live waiter may exist without a safe prompt that every
      // reviewer surface can render; otherwise an approval could be unreviewable.
      throw new Error("approval cannot be persisted without a valid reviewer presentation");
    }

    const existing = this.pending.get(record.id);
    if (existing) {
      // Idempotent: return existing promise if still pending
      if (existing.record.resolvedAtMs === undefined) {
        return existing.promise;
      }
      // Already resolved - don't allow re-registration
      throw new Error(`approval id '${record.id}' already resolved`);
    }

    if (persistence) {
      const source = resolveApprovalSource(record.request);
      let audienceSessionKeys: string[] = [];
      if (source.sessionKey) {
        audienceSessionKeys = [source.sessionKey];
        if (this.options.resolveAudienceSessionKeys) {
          try {
            audienceSessionKeys = this.options.resolveAudienceSessionKeys(source.sessionKey);
          } catch {
            // Lineage is routing metadata, not an approval safety prerequisite.
            // Preserve at least the source audience when session stores are unavailable.
          }
        }
      }
      const inserted = insertOperatorApproval({
        approval: {
          id: record.id,
          kind: this.approvalKind,
          presentation: presentation!,
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
        },
        databaseOptions: persistence.databaseOptions,
      });
      if (inserted.outcome === "conflict") {
        throw new Error(`approval id '${record.id}' conflicts with persisted state`);
      }
    }

    let resolvePromise: (decision: ExecApprovalDecision | null) => void;
    let rejectPromise: (err: Error) => void;
    const promise = new Promise<ExecApprovalDecision | null>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    // Create entry first so we can capture it in the closure (not re-fetch from map)
    const entry: PendingEntry<TPayload> = {
      record,
      resolve: resolvePromise!,
      reject: rejectPromise!,
      timer: null as unknown as ReturnType<typeof setTimeout>,
      cleanupTimer: null,
      handoffRetainCount: 0,
      handoffReleasedAtMs: null,
      retainForManagerLifetime: false,
      promise,
    };
    this.pending.set(record.id, entry);
    this.scheduleExpiryTimer(entry);
    return promise;
  }

  private projectLocalRecord(record: ExecApprovalRecord<TPayload>): OperatorApprovalRecord | null {
    const presentation = buildApprovalPresentation({
      kind: this.approvalKind,
      request: record.request,
      allowedDecisions: normalizeAllowedDecisions(
        this.options.resolveAllowedDecisions?.(record.request),
      ),
    });
    if (!presentation) {
      return null;
    }
    const status = record.status ?? (record.resolvedAtMs === undefined ? "pending" : "denied");
    const source = resolveApprovalSource(record.request);
    return {
      id: record.id,
      resolutionRef: buildApprovalResolutionRef({
        approvalId: record.id,
        approvalKind: this.approvalKind,
      }),
      kind: this.approvalKind,
      status,
      presentation,
      requester: {
        deviceId: record.requestedByDeviceId ?? null,
        clientId: record.requestedByClientId ?? null,
        deviceTokenAuth: record.requestedByDeviceTokenAuth === true,
      },
      reviewerDeviceIds: record.approvalReviewerDeviceIds ?? [],
      source,
      audienceSessionKeys: source.sessionKey ? [source.sessionKey] : [],
      runtimeEpoch: this.runtimeEpoch ?? "process-local",
      createdAtMs: record.createdAtMs,
      expiresAtMs: record.expiresAtMs,
      updatedAtMs: record.resolvedAtMs ?? record.createdAtMs,
      decision: status === "pending" ? null : (record.decision ?? "deny"),
      terminalReason: status === "pending" ? null : (record.terminalReason ?? "user"),
      resolvedAtMs: record.resolvedAtMs ?? null,
      resolver:
        record.resolvedAtMs === undefined
          ? null
          : { kind: record.resolverKind ?? "runtime", id: record.resolvedBy ?? null },
      consumedAtMs: record.consumedAtMs ?? null,
      consumedBy: record.consumedBy ?? null,
    };
  }

  /** Persist the first verdict, then release the process-local waiter. */
  resolveDetailed(
    recordId: string,
    decision: ExecApprovalDecision,
    resolver: OperatorApprovalResolver,
    localResolvedBy: string | null = null,
    localResolutionSource: ExecApprovalResolutionSource = "operator",
  ): ExecApprovalResolveResult<TPayload> {
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
        return attachLiveRecord(
          { outcome: "resolved", record: repaired.record } as const,
          repaired.liveRecord,
        );
      }
      return {
        outcome: "already-resolved",
        retry: repaired.record.decision === decision ? "same" : "conflict",
        record: repaired.record,
        ...(repaired.liveRecord ? { liveRecord: repaired.liveRecord } : {}),
      };
    }
    if (!persistence) {
      if (!localEntry) {
        return { outcome: "not-found" };
      }
      const previousDecision = localEntry.record.decision ?? localEntry.record.consumedDecision;
      if (localEntry.record.resolvedAtMs !== undefined) {
        const record = this.projectLocalRecord(localEntry.record);
        return record
          ? {
              outcome: "already-resolved",
              retry: previousDecision === decision ? "same" : "conflict",
              record,
              liveRecord: localEntry.record,
            }
          : { outcome: "corrupt" };
      }
      const allowedDecisions = normalizeAllowedDecisions(
        this.options.resolveAllowedDecisions?.(localEntry.record.request),
      );
      if (!allowedDecisions.includes(decision)) {
        const record = this.projectLocalRecord(localEntry.record);
        return record
          ? { outcome: "decision-not-allowed", record, liveRecord: localEntry.record }
          : { outcome: "corrupt" };
      }
      this.resolveLocal(recordId, decision, localResolvedBy);
      const record = this.projectLocalRecord(localEntry.record);
      return record
        ? { outcome: "resolved", record, liveRecord: localEntry.record }
        : { outcome: "corrupt" };
    }
    if (decision !== "deny" && !localEntry) {
      return { outcome: "not-found" };
    }

    let result: ResolveOperatorApprovalResult;
    try {
      result = resolveOperatorApproval({
        id: recordId,
        decision,
        resolver,
        expectedKind: this.approvalKind,
        runtimeEpoch: persistence.runtimeEpoch,
        databaseOptions: persistence.databaseOptions,
      });
    } catch (error) {
      this.settleLocalStorageFailure(recordId);
      throw error;
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
    return attachLiveRecord(result, localEntry?.record) as ExecApprovalResolveResult<TPayload>;
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
    const persistence = this.options.persistence;
    const localRecord = this.pending.get(recordId)?.record;
    if (localRecord?.terminalReason === "storage-corrupt") {
      return this.persistStorageCorruptDeny(recordId);
    }
    if (!persistence) {
      const entry = this.pending.get(recordId);
      if (!entry) {
        return { outcome: "not-found" };
      }
      if (entry.record.resolvedAtMs !== undefined) {
        const record = this.projectLocalRecord(entry.record);
        return record
          ? { outcome: "already-terminal", record, liveRecord: entry.record }
          : { outcome: "corrupt" };
      }
      this.settleLocalEntry({
        recordId,
        decision:
          localDecision === undefined ? (status === "denied" ? "deny" : null) : localDecision,
        resolvedAtMs: Date.now(),
        resolvedBy: localResolvedBy,
        resolverKind: resolver.kind,
        status,
        terminalReason: reason,
      });
      const record = this.projectLocalRecord(entry.record);
      return record
        ? { outcome: "denied", record, liveRecord: entry.record }
        : { outcome: "corrupt" };
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
    return attachLiveRecord(result, localRecord) as ExecApprovalForceDenyResult<TPayload>;
  }

  private settleLocalFromStore(
    record: OperatorApprovalRecord,
    localDecision?: ExecApprovalDecision | null,
    localResolvedBy: string | null = null,
    localResolutionSource: ExecApprovalResolutionSource = "operator",
  ): void {
    const persistence = this.options.persistence;
    if (
      record.kind !== this.approvalKind ||
      (persistence && record.runtimeEpoch !== persistence.runtimeEpoch) ||
      record.status === "pending" ||
      record.resolvedAtMs === null
    ) {
      return;
    }
    const decision =
      localDecision === undefined
        ? record.status === "allowed" || record.status === "denied"
          ? record.decision
          : null
        : localDecision;
    this.settleLocalEntry({
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
  }

  /** Reconciles durable truth with an existing waiter without rehydrating its request. */
  reconcileDurableLookup(
    lookup: ExecApprovalDurableLookup,
    localResolvedBy: string | null = null,
  ): OperatorApprovalRecord | null {
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
      !persistence ||
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
    if (!persistence) {
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
    return attachLiveRecord(result, localEntry.record) as ExecApprovalForceDenyResult<TPayload>;
  }

  private settleLocalEntry(params: {
    recordId: string;
    decision: ExecApprovalDecision | null;
    resolvedAtMs: number;
    resolvedBy: string | null;
    resolverKind: OperatorApprovalResolver["kind"] | null;
    status: OperatorApprovalStatus;
    terminalReason: OperatorApprovalTerminalReason | null;
    consumedAtMs?: number | null;
    consumedBy?: string | null;
    resolutionSource?: ExecApprovalResolutionSource;
    retainForManagerLifetime?: boolean;
  }): boolean {
    const pending = this.pending.get(params.recordId);
    if (!pending || pending.record.resolvedAtMs !== undefined) {
      return false;
    }
    clearTimeout(pending.timer);
    pending.record.resolvedAtMs = params.resolvedAtMs;
    if (params.decision === null) {
      delete pending.record.decision;
    } else {
      pending.record.decision = params.decision;
      // Only explicit decisions carry a source; timeouts/cancellations stay
      // source-less so system.run ask-fallback replay can identify them.
      pending.record.resolutionSource = params.resolutionSource ?? "operator";
    }
    pending.record.resolvedBy = params.resolvedBy;
    pending.record.resolverKind = params.resolverKind;
    pending.record.status = params.status;
    pending.record.terminalReason = params.terminalReason;
    pending.record.runtimeEpoch = this.runtimeEpoch ?? undefined;
    pending.record.consumedAtMs = params.consumedAtMs ?? null;
    pending.record.consumedBy = params.consumedBy ?? null;
    pending.retainForManagerLifetime ||= params.retainForManagerLifetime === true;
    // Keep resolved entries briefly so late waitDecision and system.run replay
    // validation see the same durable verdict that released this waiter.
    pending.resolve(params.decision);
    if (!pending.retainForManagerLifetime && pending.handoffRetainCount === 0) {
      this.scheduleResolvedCleanup(pending);
    }
    return true;
  }

  private scheduleResolvedCleanup(entry: PendingEntry<TPayload>): void {
    if (
      entry.cleanupTimer ||
      entry.record.resolvedAtMs === undefined ||
      entry.retainForManagerLifetime ||
      entry.handoffRetainCount > 0
    ) {
      return;
    }
    const cleanupTimer = scheduleResolvedEntryCleanup(() => {
      if (entry.cleanupTimer !== cleanupTimer) {
        return;
      }
      entry.cleanupTimer = null;
      if (
        this.pending.get(entry.record.id) === entry &&
        entry.handoffRetainCount === 0 &&
        !entry.retainForManagerLifetime
      ) {
        this.pending.delete(entry.record.id);
      }
    });
    entry.cleanupTimer = cleanupTimer;
  }

  private resolvedGraceAnchorMs(entry: PendingEntry<TPayload>, nowMs: number): number | null {
    if (entry.record.resolvedAtMs === undefined) {
      return null;
    }
    if (entry.handoffRetainCount > 0) {
      return nowMs;
    }
    return entry.handoffReleasedAtMs ?? entry.record.resolvedAtMs;
  }

  /** Retains an existing local binding across async delivery; final release starts a fresh grace. */
  retainForHandoff(recordId: string): (() => void) | null {
    const entry = this.pending.get(recordId);
    if (!entry) {
      return null;
    }
    const nowMs = Date.now();
    const graceAnchorMs = this.resolvedGraceAnchorMs(entry, nowMs);
    if (
      !entry.retainForManagerLifetime &&
      graceAnchorMs !== null &&
      entry.handoffRetainCount === 0 &&
      nowMs - graceAnchorMs >= EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS
    ) {
      this.pending.delete(recordId);
      return null;
    }
    if (entry.cleanupTimer) {
      clearTimeout(entry.cleanupTimer);
      entry.cleanupTimer = null;
    }
    entry.handoffRetainCount += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      if (this.pending.get(recordId) !== entry) {
        return;
      }
      entry.handoffRetainCount = Math.max(0, entry.handoffRetainCount - 1);
      if (entry.handoffRetainCount > 0 || entry.record.resolvedAtMs === undefined) {
        return;
      }
      entry.handoffReleasedAtMs = Date.now();
      this.scheduleResolvedCleanup(entry);
    };
  }

  private reportError(error: unknown, context: { approvalId: string; operation: "expire" }): void {
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

  private scheduleExpiryTimer(entry: PendingEntry<TPayload>): void {
    const timerDelayMs = resolveApprovalTimeoutMs(entry.record.expiresAtMs - Date.now());
    entry.timer = setTimeout(() => {
      try {
        this.expireDue(entry.record.id);
      } catch (error) {
        this.reportError(error, { approvalId: entry.record.id, operation: "expire" });
      }
    }, timerDelayMs);
  }

  private expireDue(recordId: string): boolean {
    const entry = this.pending.get(recordId);
    if (!entry || entry.record.resolvedAtMs !== undefined) {
      return false;
    }
    if (!this.options.persistence) {
      if (entry.record.expiresAtMs > Date.now()) {
        this.scheduleExpiryTimer(entry);
        return false;
      }
      return this.expireLocal(recordId, null);
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

  private resolveLocal(
    recordId: string,
    decision: ExecApprovalDecision,
    resolvedBy: string | null,
    resolutionSource: ExecApprovalResolutionSource = "operator",
  ): boolean {
    const entry = this.pending.get(recordId);
    if (!entry || entry.record.resolvedAtMs !== undefined) {
      return false;
    }
    const allowedDecisions = normalizeAllowedDecisions(
      this.options.resolveAllowedDecisions?.(entry.record.request),
    );
    if (!allowedDecisions.includes(decision)) {
      return false;
    }
    return this.settleLocalEntry({
      recordId,
      decision,
      resolvedAtMs: Date.now(),
      resolvedBy,
      resolverKind: "runtime",
      status: decision === "deny" ? "denied" : "allowed",
      terminalReason: "user",
      resolutionSource,
    });
  }

  private expireLocal(recordId: string, resolvedBy: string | null): boolean {
    const entry = this.pending.get(recordId);
    if (!entry || entry.record.resolvedAtMs !== undefined) {
      return false;
    }
    const noRoute = resolvedBy === "no-approval-route";
    return this.settleLocalEntry({
      recordId,
      decision: null,
      resolvedAtMs: Date.now(),
      resolvedBy,
      resolverKind: "system",
      status: noRoute ? "denied" : "expired",
      terminalReason: noRoute ? "no-route" : "timeout",
    });
  }

  resolve(recordId: string, decision: ExecApprovalDecision, resolvedBy?: string | null): boolean {
    if (!this.options.persistence) {
      return this.resolveLocal(recordId, decision, resolvedBy ?? null);
    }
    return (
      this.resolveDetailed(
        recordId,
        decision,
        {
          kind: "runtime",
          id: resolvedBy ?? null,
        },
        resolvedBy ?? null,
      ).outcome === "resolved"
    );
  }

  /**
   * Trusted auto-review resolution (identity-matched approval runtime).
   * Always allow-once; system.run replay validation treats the resulting
   * record more strictly than an operator decision (see #103515).
   */
  resolveAutoReview(recordId: string, resolvedBy?: string | null): boolean {
    if (!this.options.persistence) {
      return this.resolveLocal(recordId, "allow-once", resolvedBy ?? null, "auto-review");
    }
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
   * `expired` and no execution authority is minted here. The strict exec
   * timeout cutover is deferred (docs/refactor/operator-approvals.md); until
   * then system.run replay uses this flag to keep re-admission single-use.
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
      record.askFallbackConsumed === true
    ) {
      return false;
    }
    record.askFallbackConsumed = true;
    return true;
  }

  expire(recordId: string, resolvedBy?: string | null): boolean {
    if (!this.options.persistence) {
      return this.expireLocal(recordId, resolvedBy ?? null);
    }
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

  getSnapshot(recordId: string): ExecApprovalRecord<TPayload> | null {
    const entry = this.pending.get(recordId);
    if (!entry) {
      return null;
    }
    const nowMs = Date.now();
    const graceAnchorMs = this.resolvedGraceAnchorMs(entry, nowMs);
    if (
      entry.record.terminalReason !== "storage-corrupt" &&
      graceAnchorMs !== null &&
      nowMs - graceAnchorMs >= EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS
    ) {
      this.pending.delete(recordId);
      return null;
    }
    if (entry.record.resolvedAtMs === undefined && entry.record.expiresAtMs <= nowMs) {
      this.expireDue(recordId);
    }
    return entry.record;
  }

  /** Returns an exact live request snapshot without reading durable state or mutating expiry. */
  getLiveSnapshot(recordId: string): ExecApprovalRecord<TPayload> | null {
    const entry = this.pending.get(recordId);
    if (!entry) {
      return null;
    }
    const nowMs = Date.now();
    if (entry.record.resolvedAtMs === undefined) {
      return entry.record.expiresAtMs > nowMs ? entry.record : null;
    }
    const graceAnchorMs = this.resolvedGraceAnchorMs(entry, nowMs);
    if (graceAnchorMs === null || nowMs - graceAnchorMs >= EXEC_APPROVAL_RESOLVED_ENTRY_GRACE_MS) {
      return null;
    }
    return entry.record;
  }

  listPendingRecords(): ExecApprovalRecord<TPayload>[] {
    const nowMs = Date.now();
    for (const entry of this.pending.values()) {
      if (entry.record.resolvedAtMs === undefined && entry.record.expiresAtMs <= nowMs) {
        this.expireDue(entry.record.id);
      }
    }
    return Array.from(this.pending.values())
      .map((entry) => entry.record)
      .filter((record) => record.resolvedAtMs === undefined);
  }

  consumeAllowOnce(recordId: string, consumerId = recordId): boolean {
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
    if (persistence) {
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
    entry.record.consumedDecision = "allow-once";
    return true;
  }

  /**
   * Wait for decision on an already-registered approval.
   * Returns the decision promise if the ID is pending, null otherwise.
   */
  awaitDecision(recordId: string): Promise<ExecApprovalDecision | null> | null {
    if (!this.getSnapshot(recordId)) {
      return null;
    }
    const entry = this.pending.get(recordId);
    return entry?.promise ?? null;
  }

  lookupApprovalId(
    input: string,
    opts: {
      includeResolved?: boolean;
      filter?: (record: ExecApprovalRecord<TPayload>) => boolean;
    } = {},
  ): ExecApprovalIdLookupResult {
    const rawExact = this.getSnapshot(input);
    if (rawExact) {
      return (opts.includeResolved || rawExact.resolvedAtMs === undefined) &&
        (opts.filter?.(rawExact) ?? true)
        ? { kind: "exact", id: input }
        : { kind: "none" };
    }

    const normalized = input.trim();
    if (!normalized) {
      return { kind: "none" };
    }

    const exact = this.getSnapshot(normalized);
    if (exact) {
      return (opts.includeResolved || exact.resolvedAtMs === undefined) &&
        (opts.filter?.(exact) ?? true)
        ? { kind: "exact", id: normalized }
        : { kind: "none" };
    }

    const lowerPrefix = normalizeLowercaseStringOrEmpty(normalized);
    const matches: string[] = [];
    const candidates = new Map<string, ExecApprovalRecord<TPayload>>();
    for (const entry of this.pending.values()) {
      candidates.set(entry.record.id, entry.record);
    }
    for (const record of this.listPendingRecords()) {
      candidates.set(record.id, record);
    }
    for (const [id, record] of candidates) {
      if (!opts.includeResolved && record.resolvedAtMs !== undefined) {
        continue;
      }
      if (opts.filter && !opts.filter(record)) {
        continue;
      }
      if (normalizeLowercaseStringOrEmpty(id).startsWith(lowerPrefix)) {
        matches.push(id);
      }
    }

    if (matches.length === 1) {
      return { kind: "prefix", id: matches[0] };
    }
    if (matches.length > 1) {
      return { kind: "ambiguous", ids: matches };
    }
    return { kind: "none" };
  }

  lookupPendingId(input: string): ExecApprovalIdLookupResult {
    return this.lookupApprovalId(input);
  }
}
