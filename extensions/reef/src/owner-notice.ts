import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { InboxEntry, ReefDeliveryRejection, ReefRejectionNoticeState } from "./types.js";

type ResolveAgentRouteParams = Parameters<
  PluginRuntime["channel"]["routing"]["resolveAgentRoute"]
>[0];

interface ReefOwnerNotice {
  text: string;
  contextKey: string;
  peer?: string;
  wakeAgent?: boolean;
}

interface ReefRejectionNotice {
  text: string;
  peer: string;
  messageId: string;
  recipient: ReefDeliveryRejection["recipient"];
  originalTextHash?: string;
  allowResend: boolean;
}

const MAX_REJECTION_TRACKED = 1_024;
const REJECTION_RESEND_COOLDOWN_MS = 15 * 60 * 1_000;
const REJECTION_NOTICE_RETRY_BASE_MS = 1_000;
const REJECTION_NOTICE_RETRY_MAX_MS = 60_000;

interface ReefReceiptNotifierOptions {
  now?: () => number;
  schedule?: (task: () => Promise<void>, delayMs: number) => void;
  onError?: (error: unknown, receiptId: string) => void;
  signal?: AbortSignal;
}

interface ReefRejectionNoticeStore {
  loadState(peer: string): ReefRejectionNoticeState | undefined;
  reserve(
    rejection: ReefDeliveryRejection,
    state: ReefRejectionNoticeState,
  ): { kind: "reserved" } | { kind: "existing"; state: ReefRejectionNoticeState };
  complete(rejection: ReefDeliveryRejection, state: ReefRejectionNoticeState): void;
}

interface ReefPeerNoticeState {
  lastRejectionAt?: number;
  lastResendAt?: number;
  resendBlocked?: boolean;
}

interface ReefNoticePlan {
  notice: ReefRejectionNotice;
  state: ReefRejectionNoticeState;
}

function scheduleNoticeRetry(task: () => Promise<void>, delayMs: number): void {
  setTimeout(() => void task(), delayMs).unref();
}

function rejectionNoticeRetryDelay(retryAttempt: number): number {
  return Math.min(
    REJECTION_NOTICE_RETRY_BASE_MS * 2 ** Math.min(retryAttempt, 6),
    REJECTION_NOTICE_RETRY_MAX_MS,
  );
}

export class ReefReceiptNotifier {
  private readonly completed = new Set<string>();
  private readonly inFlight = new Set<string>();
  private readonly peerStates = new Map<string, ReefPeerNoticeState>();
  private readonly peerQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly notify: (notice: ReefRejectionNotice) => Promise<void>,
    private readonly store: ReefRejectionNoticeStore,
    private readonly options: ReefReceiptNotifierOptions = {},
  ) {}

  async notifyRejections(rejections: readonly ReefDeliveryRejection[]): Promise<void> {
    this.seedRecoveredStates(rejections);
    for (const rejection of rejections) {
      await this.runForPeer(rejection.peer, () => this.notifyRejection(rejection, 0));
    }
  }

  private seedRecoveredStates(rejections: readonly ReefDeliveryRejection[]): void {
    const recoveredByPeer = new Map<string, ReefDeliveryRejection[]>();
    for (const rejection of rejections) {
      if (!rejection.reservedNotice) {
        continue;
      }
      const recovered = recoveredByPeer.get(rejection.peer) ?? [];
      recovered.push(rejection);
      recoveredByPeer.set(rejection.peer, recovered);
    }
    for (const [peer, recovered] of recoveredByPeer) {
      let state: ReefPeerNoticeState;
      try {
        state = this.touchPeerState(peer);
      } catch (error) {
        this.reportError(error, recovered[0]!.id);
        // Unknown durable state may contain a newer rejection. Keep this
        // notifier stop-only for the peer until cache eviction or restart.
        state = { resendBlocked: true };
      }
      for (const rejection of recovered) {
        this.applyState(
          state,
          this.mergeStates(this.snapshotState(state), rejection.reservedNotice!),
        );
      }
      this.rememberPeerState(peer, state);
    }
  }

  private async notifyRejection(
    rejection: ReefDeliveryRejection,
    retryAttempt: number,
  ): Promise<void> {
    const key = this.rejectionKey(rejection);
    if (this.completed.has(key) || this.inFlight.has(key)) {
      return;
    }
    this.inFlight.add(key);

    let peerState: ReefPeerNoticeState;
    try {
      peerState = this.touchPeerState(rejection.peer);
    } catch (error) {
      this.reportError(error, rejection.id);
      this.scheduleNotificationRetry(rejection, retryAttempt);
      return;
    }

    const previousState = this.snapshotState(peerState);
    let plan = this.planNotice(
      rejection,
      previousState,
      rejection.reservedNotice,
      peerState.resendBlocked === true,
    );
    try {
      const reservation = this.store.reserve(rejection, plan.state);
      if (reservation.kind === "existing") {
        plan = this.planNotice(
          rejection,
          previousState,
          reservation.state,
          peerState.resendBlocked === true,
        );
      }
    } catch (error) {
      this.reportError(error, rejection.id);
      this.scheduleNotificationRetry(rejection, retryAttempt);
      return;
    }

    if (!(await this.notifyOnce(plan.notice, rejection.id))) {
      // Dispatch may have recorded or consumed the turn before failing. Keep the
      // reservation so every retry is conservative stop-only guidance.
      this.applyState(peerState, plan.state);
      this.scheduleNotificationRetry(rejection, retryAttempt);
      return;
    }

    this.applyState(peerState, plan.state);
    this.completeNotice(rejection, plan.state, 0);
  }

  private planNotice(
    rejection: ReefDeliveryRejection,
    previous: ReefRejectionNoticeState | undefined,
    reserved: ReefRejectionNoticeState | undefined,
    resendBlocked: boolean,
  ): ReefNoticePlan {
    if (reserved) {
      const state = this.mergeStates(previous, reserved);
      return {
        notice: this.buildNotice(rejection, false),
        state,
      };
    }
    const now = this.now();
    const rejectionCooldownActive =
      previous !== undefined && now - previous.lastRejectionAt < REJECTION_RESEND_COOLDOWN_MS;
    const resendCooldownActive =
      previous?.lastResendAt !== undefined &&
      now - previous.lastResendAt < REJECTION_RESEND_COOLDOWN_MS;
    const allowResend =
      !resendBlocked &&
      rejection.category === "guard_deny" &&
      rejection.textHash !== undefined &&
      !rejectionCooldownActive &&
      !resendCooldownActive;
    return {
      notice: this.buildNotice(rejection, allowResend),
      state: {
        lastRejectionAt: Math.max(previous?.lastRejectionAt ?? 0, now),
        ...(allowResend
          ? { lastResendAt: now }
          : previous?.lastResendAt !== undefined
            ? { lastResendAt: previous.lastResendAt }
            : {}),
      },
    };
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private touchPeerState(peer: string): ReefPeerNoticeState {
    let state = this.peerStates.get(peer);
    if (!state) {
      const persisted = this.store.loadState(peer);
      state = persisted ? { ...persisted } : {};
    }
    this.rememberPeerState(peer, state);
    return state;
  }

  private rememberPeerState(peer: string, state: ReefPeerNoticeState): void {
    this.peerStates.delete(peer);
    this.peerStates.set(peer, state);
    if (this.peerStates.size > MAX_REJECTION_TRACKED) {
      const oldest = this.peerStates.keys().next().value;
      if (oldest !== undefined) {
        this.peerStates.delete(oldest);
      }
    }
  }

  private runForPeer(peer: string, task: () => Promise<void>): Promise<void> {
    const previous = this.peerQueues.get(peer) ?? Promise.resolve();
    const current = previous.then(task, task);
    this.peerQueues.set(peer, current);
    return current.finally(() => {
      if (this.peerQueues.get(peer) === current) {
        this.peerQueues.delete(peer);
      }
    });
  }

  private async notifyOnce(notice: ReefRejectionNotice, receiptId: string): Promise<boolean> {
    try {
      await this.notify(notice);
      return true;
    } catch (error) {
      this.reportError(error, receiptId);
      return false;
    }
  }

  private completeNotice(
    rejection: ReefDeliveryRejection,
    state: ReefRejectionNoticeState,
    retryAttempt: number,
  ): void {
    try {
      this.store.complete(rejection, state);
      this.markCompleted(rejection);
    } catch (error) {
      this.reportError(error, rejection.id);
      this.scheduleRetry(rejection, retryAttempt, () =>
        this.completeNotice(rejection, state, retryAttempt + 1),
      );
    }
  }

  private scheduleNotificationRetry(rejection: ReefDeliveryRejection, retryAttempt: number): void {
    this.scheduleRetry(rejection, retryAttempt, async () => {
      this.inFlight.delete(this.rejectionKey(rejection));
      await this.notifyRejection(rejection, retryAttempt + 1);
    });
  }

  private scheduleRetry(
    rejection: ReefDeliveryRejection,
    retryAttempt: number,
    task: () => Promise<void> | void,
  ): void {
    if (this.options.signal?.aborted) {
      this.inFlight.delete(this.rejectionKey(rejection));
      return;
    }
    const schedule = this.options.schedule ?? scheduleNoticeRetry;
    try {
      schedule(
        () =>
          this.runForPeer(rejection.peer, async () => {
            if (this.options.signal?.aborted) {
              this.inFlight.delete(this.rejectionKey(rejection));
              return;
            }
            await task();
          }),
        rejectionNoticeRetryDelay(retryAttempt),
      );
    } catch (error) {
      this.inFlight.delete(this.rejectionKey(rejection));
      this.reportError(error, rejection.id);
    }
  }

  private markCompleted(rejection: ReefDeliveryRejection): void {
    const key = this.rejectionKey(rejection);
    this.inFlight.delete(key);
    this.completed.delete(key);
    this.completed.add(key);
    if (this.completed.size > MAX_REJECTION_TRACKED) {
      const oldest = this.completed.values().next().value;
      if (oldest !== undefined) {
        this.completed.delete(oldest);
      }
    }
  }

  private snapshotState(state: ReefPeerNoticeState): ReefRejectionNoticeState | undefined {
    if (state.lastRejectionAt === undefined) {
      return undefined;
    }
    return {
      lastRejectionAt: state.lastRejectionAt,
      ...(state.lastResendAt !== undefined ? { lastResendAt: state.lastResendAt } : {}),
    };
  }

  private applyState(target: ReefPeerNoticeState, state: ReefRejectionNoticeState): void {
    target.lastRejectionAt = state.lastRejectionAt;
    if (state.lastResendAt === undefined) {
      delete target.lastResendAt;
    } else {
      target.lastResendAt = state.lastResendAt;
    }
  }

  private mergeStates(
    current: ReefRejectionNoticeState | undefined,
    persisted: ReefRejectionNoticeState,
  ): ReefRejectionNoticeState {
    const hasResendAt = current?.lastResendAt !== undefined || persisted.lastResendAt !== undefined;
    return {
      lastRejectionAt: Math.max(current?.lastRejectionAt ?? 0, persisted.lastRejectionAt),
      ...(hasResendAt
        ? {
            lastResendAt: Math.max(current?.lastResendAt ?? 0, persisted.lastResendAt ?? 0),
          }
        : {}),
    };
  }

  private buildNotice(rejection: ReefDeliveryRejection, allowResend: boolean): ReefRejectionNotice {
    const guardRejected = rejection.category === "guard_deny";
    return {
      text: guardRejected
        ? allowResend
          ? `Your Reef message to @${rejection.peer} was rejected by the peer's inbound guard (message ${rejection.id}). Rephrase it at most once and resend if still appropriate; do not retry unchanged text. If that retry is also rejected, stop and wait for owner guidance.`
          : `Another Reef message to @${rejection.peer} was rejected by the peer's inbound guard (message ${rejection.id}). Stop automatic retries and wait for owner guidance.`
        : `Your Reef message to @${rejection.peer} was rejected before delivery (message ${rejection.id}). Stop automatic retries and wait for owner guidance.`,
      peer: rejection.peer,
      messageId: rejection.id,
      recipient: rejection.recipient,
      ...(rejection.textHash ? { originalTextHash: rejection.textHash } : {}),
      allowResend,
    };
  }

  private rejectionKey(rejection: ReefDeliveryRejection): string {
    return `${rejection.peer}\n${rejection.id}`;
  }

  private reportError(error: unknown, receiptId: string): void {
    try {
      this.options.onError?.(error, receiptId);
    } catch {
      // Owner-notice failures never block the relay inbox cursor.
    }
  }
}

export async function processReefInboxEntriesInOrder(params: {
  entries: readonly InboxEntry[];
  processEntries: (entries: InboxEntry[]) => Promise<ReefDeliveryRejection[]>;
  notifyRejections: (rejections: readonly ReefDeliveryRejection[]) => Promise<void>;
  onNoticeError?: (error: unknown) => void;
}): Promise<void> {
  for (const entry of params.entries) {
    const rejections = await params.processEntries([entry]);
    try {
      await params.notifyRejections(rejections);
    } catch (error) {
      try {
        params.onNoticeError?.(error);
      } catch {
        // Notification diagnostics cannot hold the durable inbox cursor open.
      }
    }
  }
}

// Long enough to ride out transport reconnects and peer gateway restarts;
// short enough that a human waiting on a cross-claw errand hears about a dead
// peer in minutes instead of never.
const REEF_DELIVERY_OVERDUE_NOTICE_MS = 10 * 60 * 1_000;

interface ReefOverdueDeliveryStore {
  overdueOutboundDeliveries(
    olderThanMs: number,
    now?: number,
  ): Array<{ peer: string; id: string; sentAt: number }>;
  markOutboundDeliveryOverdueNotified(peer: string, id: string): boolean;
}

/**
 * Follow-up for sends that produced no receipt at all (peer offline, peer
 * inbox dead). Every other outcome already reports back: replies and
 * rejection receipts dispatch turns, and local send failures reject the
 * message tool call. Without this sweep an unacknowledged send is silent
 * until its record ages out.
 */
export async function notifyOverdueReefDeliveries(params: {
  trust: ReefOverdueDeliveryStore;
  ownerNotice: (notice: ReefOwnerNotice) => Promise<void>;
  thresholdMs?: number;
  now?: number;
}): Promise<void> {
  const thresholdMs = params.thresholdMs ?? REEF_DELIVERY_OVERDUE_NOTICE_MS;
  for (const overdue of params.trust.overdueOutboundDeliveries(thresholdMs, params.now)) {
    const elapsedMs = (params.now ?? Date.now()) - overdue.sentAt;
    const minutes = Math.max(1, Math.round(elapsedMs / 60_000));
    // Dispatch before marking: a crash in between re-sends one deduped notice
    // on the next tick, whereas marking first could silence it permanently —
    // the exact failure this sweep exists to report. The context key keeps
    // redispatch idempotent while the event is still queued, and a receipt
    // only sees overdueNotifiedAt after the notice really went out.
    await params.ownerNotice({
      text: `Reef message ${overdue.id} to @${overdue.peer} has not been confirmed delivered after ${minutes} minute${minutes === 1 ? "" : "s"}; the peer's claw looks offline or unreachable. The relay keeps it queued and you will get a follow-up if it is delivered or rejected. If your owner was waiting on this, let them know now.`,
      peer: overdue.peer,
      contextKey: `reef:delivery-overdue:${overdue.peer}:${overdue.id}`,
      wakeAgent: true,
    });
    // A failed mark means the record vanished mid-dispatch (receipt consumed
    // it, keys changed, or it aged out). None of that is positive delivery
    // evidence, so claim nothing here: only the accepted-receipt path may say
    // "delivered after all", and a reply that races this notice corrects it
    // naturally. Accepted tradeoff: in that sliver the delay notice stands
    // uncorrected rather than risking a false delivery claim.
    params.trust.markOutboundDeliveryOverdueNotified(overdue.peer, overdue.id);
  }
}

export function createReefOwnerNoticeHandler(params: {
  runtime: PluginRuntime;
  cfg: ResolveAgentRouteParams["cfg"];
  accountId: string;
  handle: string;
}): (notice: ReefOwnerNotice) => Promise<void> {
  return async (notice) => {
    const route = params.runtime.channel.routing.resolveAgentRoute({
      cfg: params.cfg,
      channel: "reef",
      accountId: params.accountId,
      peer: { kind: "direct", id: notice.peer ?? params.handle },
    });
    const queued = params.runtime.system.enqueueSystemEvent(notice.text, {
      sessionKey: route.sessionKey,
      contextKey: notice.contextKey,
    });
    if (!queued || !notice.wakeAgent) {
      return;
    }
    params.runtime.system.requestHeartbeat({
      source: "other",
      intent: "immediate",
      reason: "reef:delivery-rejected",
      agentId: route.agentId,
      sessionKey: route.sessionKey,
    });
  };
}
