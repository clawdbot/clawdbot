export const CURRENT_DM_RECOVERY_PROGRESS_TEXT =
  "Still working on your request. Progress is being tracked safely; no action is needed.";

export type CurrentDmRecoveryMilestone = "status" | "checkpoint" | "recovery";
export type CurrentDmRecoveryMilestoneState =
  | "unclaimed"
  | "intent"
  | "sent"
  | "superseded"
  | "unknown";
export type CurrentDmRecoveryLifecycle =
  | "active"
  | "final-accepted"
  | "cancelled"
  | "error"
  | "stale"
  | "ambiguous";

export interface CurrentDmRecoveryIdentity {
  agentId: string;
  provider: "telegram";
  accountId: string;
  chatId: string;
  senderId: string;
  threadId?: string;
  inboundMessageId: number;
  inboundUpdateId: number;
  ingressGeneration: number;
  featureGateGeneration: number;
  sessionKey: string;
  sessionId: string;
  runId: string;
  turnId: string;
}

export interface CurrentDmRecoveryPersistedState {
  version: 1;
  identity: CurrentDmRecoveryIdentity;
  lifecycle: CurrentDmRecoveryLifecycle;
  activityAt: number;
  activityRevision: number;
  milestones: Record<CurrentDmRecoveryMilestone, CurrentDmRecoveryMilestoneState>;
  updatedAt: number;
}

export interface CurrentDmRecoveryStore {
  load(identity: CurrentDmRecoveryIdentity): Promise<CurrentDmRecoveryPersistedState | undefined>;
  save(state: CurrentDmRecoveryPersistedState): Promise<void>;
}

export interface CurrentDmRecoveryScheduler {
  now(): number;
  scheduleAt(at: number, callback: () => void | Promise<void>): unknown;
  cancel(handle: unknown): void;
}

export interface CurrentDmRecoveryFreshness {
  isCurrent: boolean;
  featureGateGeneration: number;
}

export interface CurrentDmRecoveryProgress {
  identity: CurrentDmRecoveryIdentity;
  milestone: CurrentDmRecoveryMilestone;
  text: typeof CURRENT_DM_RECOVERY_PROGRESS_TEXT;
}

export interface CurrentDmRecoveryDependencies {
  enabled?: boolean;
  identity: CurrentDmRecoveryIdentity;
  store: CurrentDmRecoveryStore;
  scheduler: CurrentDmRecoveryScheduler;
  checkFreshness(
    identity: CurrentDmRecoveryIdentity,
  ): CurrentDmRecoveryFreshness | Promise<CurrentDmRecoveryFreshness>;
  sendProgress(progress: CurrentDmRecoveryProgress): void | Promise<void>;
}

export interface CurrentDmRecoveryCoordinator {
  noteActivity(at?: number): Promise<void>;
  markFinalAccepted(): Promise<void>;
  cancel(): Promise<void>;
  markError(): Promise<void>;
}

const MILESTONES: ReadonlyArray<{
  name: CurrentDmRecoveryMilestone;
  delayMs: number;
}> = [
  { name: "status", delayMs: 120_000 },
  { name: "checkpoint", delayMs: 180_000 },
  { name: "recovery", delayMs: 300_000 },
];

const EXPECTED_DM_ID = "5397261498";

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isEligible(identity: CurrentDmRecoveryIdentity): boolean {
  return (
    identity.agentId === "main" &&
    identity.provider === "telegram" &&
    identity.accountId === "default" &&
    identity.chatId === EXPECTED_DM_ID &&
    identity.senderId === EXPECTED_DM_ID &&
    identity.threadId === undefined &&
    identity.sessionKey === "agent:main:telegram:direct:5397261498" &&
    identity.sessionId.length > 0 &&
    identity.runId.length > 0 &&
    identity.turnId.length > 0 &&
    isPositiveInteger(identity.inboundMessageId) &&
    isPositiveInteger(identity.inboundUpdateId) &&
    isPositiveInteger(identity.ingressGeneration) &&
    isPositiveInteger(identity.featureGateGeneration)
  );
}

function sameIdentity(a: CurrentDmRecoveryIdentity, b: CurrentDmRecoveryIdentity): boolean {
  return (
    a.agentId === b.agentId &&
    a.provider === b.provider &&
    a.accountId === b.accountId &&
    a.chatId === b.chatId &&
    a.senderId === b.senderId &&
    a.threadId === b.threadId &&
    a.inboundMessageId === b.inboundMessageId &&
    a.inboundUpdateId === b.inboundUpdateId &&
    a.ingressGeneration === b.ingressGeneration &&
    a.featureGateGeneration === b.featureGateGeneration &&
    a.sessionKey === b.sessionKey &&
    a.sessionId === b.sessionId &&
    a.runId === b.runId &&
    a.turnId === b.turnId
  );
}

function cloneIdentity(identity: CurrentDmRecoveryIdentity): CurrentDmRecoveryIdentity {
  return { ...identity };
}

class Coordinator implements CurrentDmRecoveryCoordinator {
  private timer: unknown;
  private stopped = false;

  constructor(
    private readonly dependencies: CurrentDmRecoveryDependencies,
    private state: CurrentDmRecoveryPersistedState,
  ) {}

  scheduleNext(): void {
    if (this.stopped || this.state.lifecycle !== "active") {
      return;
    }
    const next = MILESTONES.find(({ name }) => this.state.milestones[name] === "unclaimed");
    if (!next) {
      return;
    }
    const revision = this.state.activityRevision;
    this.timer = this.dependencies.scheduler.scheduleAt(this.state.activityAt + next.delayMs, () =>
      this.onTimer(revision),
    );
  }

  async noteActivity(at = this.dependencies.scheduler.now()): Promise<void> {
    if (this.stopped || this.state.lifecycle !== "active" || at <= this.state.activityAt) {
      return;
    }
    this.clearTimer();
    this.state.activityAt = at;
    this.state.activityRevision += 1;
    this.state.updatedAt = this.dependencies.scheduler.now();
    try {
      await this.dependencies.store.save(this.state);
    } catch {
      this.stopLocally();
      return;
    }
    this.scheduleNext();
  }

  markFinalAccepted(): Promise<void> {
    return this.finish("final-accepted");
  }

  cancel(): Promise<void> {
    return this.finish("cancelled");
  }

  markError(): Promise<void> {
    return this.finish("error");
  }

  private async finish(lifecycle: "final-accepted" | "cancelled" | "error"): Promise<void> {
    if (this.stopped || this.state.lifecycle !== "active") {
      return;
    }
    this.clearTimer();
    this.state.lifecycle = lifecycle;
    this.state.updatedAt = this.dependencies.scheduler.now();
    try {
      await this.dependencies.store.save(this.state);
    } finally {
      this.stopLocally();
    }
  }

  private async onTimer(revision: number): Promise<void> {
    this.timer = undefined;
    if (
      this.stopped ||
      this.state.lifecycle !== "active" ||
      revision !== this.state.activityRevision
    ) {
      return;
    }

    const now = this.dependencies.scheduler.now();
    const due = MILESTONES.findLast(
      ({ name, delayMs }) =>
        this.state.milestones[name] === "unclaimed" && this.state.activityAt + delayMs <= now,
    );
    if (!due) {
      this.scheduleNext();
      return;
    }

    let freshness: CurrentDmRecoveryFreshness;
    try {
      freshness = await this.dependencies.checkFreshness(cloneIdentity(this.state.identity));
    } catch {
      await this.tombstone();
      return;
    }
    if (!this.isCurrentCallback(revision)) {
      return;
    }
    if (
      !freshness.isCurrent ||
      freshness.featureGateGeneration !== this.state.identity.featureGateGeneration
    ) {
      await this.tombstone();
      return;
    }

    // A delayed callback claims the highest due milestone and permanently subsumes
    // lower due milestones, preventing a burst of stale progress messages.
    for (const milestone of MILESTONES) {
      if (
        milestone.delayMs <= due.delayMs &&
        this.state.milestones[milestone.name] === "unclaimed"
      ) {
        this.state.milestones[milestone.name] =
          milestone.name === due.name ? "intent" : "superseded";
      }
    }
    this.state.updatedAt = now;
    try {
      // The durable intent is the commit point authorizing the visible callback.
      await this.dependencies.store.save(this.state);
    } catch {
      this.stopLocally();
      return;
    }
    if (!this.isCurrentCallback(revision)) {
      await this.markAmbiguous();
      return;
    }

    // Persistence may yield. Recheck immediately before the externally visible callback.
    try {
      freshness = await this.dependencies.checkFreshness(cloneIdentity(this.state.identity));
    } catch {
      await this.tombstone();
      return;
    }
    if (!this.isCurrentCallback(revision)) {
      await this.markAmbiguous();
      return;
    }
    if (
      !freshness.isCurrent ||
      freshness.featureGateGeneration !== this.state.identity.featureGateGeneration
    ) {
      await this.tombstone();
      return;
    }

    try {
      await this.dependencies.sendProgress({
        identity: cloneIdentity(this.state.identity),
        milestone: due.name,
        text: CURRENT_DM_RECOVERY_PROGRESS_TEXT,
      });
    } catch {
      this.state.milestones[due.name] = "unknown";
      this.state.lifecycle = "ambiguous";
      this.state.updatedAt = this.dependencies.scheduler.now();
      try {
        await this.dependencies.store.save(this.state);
      } catch {
        // The callback began, so failure to persist the ambiguity cannot authorize retry.
      } finally {
        this.stopLocally();
      }
      return;
    }

    this.state.milestones[due.name] = "sent";
    this.state.updatedAt = this.dependencies.scheduler.now();
    try {
      await this.dependencies.store.save(this.state);
    } catch {
      // A visible callback occurred but its acknowledgement was not durable. Never retry.
      this.stopLocally();
      return;
    }
    this.scheduleNext();
  }

  private isCurrentCallback(revision: number): boolean {
    return (
      !this.stopped && this.state.lifecycle === "active" && this.state.activityRevision === revision
    );
  }

  private async markAmbiguous(): Promise<void> {
    if (this.state.lifecycle === "active") {
      this.state.lifecycle = "ambiguous";
      this.state.updatedAt = this.dependencies.scheduler.now();
      try {
        await this.dependencies.store.save(this.state);
      } catch {
        // Intent is already durable; local shutdown still prevents replay in this process.
      }
    }
    this.stopLocally();
  }

  private async tombstone(): Promise<void> {
    this.clearTimer();
    this.state.lifecycle = "stale";
    this.state.updatedAt = this.dependencies.scheduler.now();
    try {
      await this.dependencies.store.save(this.state);
    } catch {
      // Freshness failed closed; local shutdown remains mandatory.
    } finally {
      this.stopLocally();
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      this.dependencies.scheduler.cancel(this.timer);
      this.timer = undefined;
    }
  }

  private stopLocally(): void {
    this.clearTimer();
    this.stopped = true;
  }
}

export async function startCurrentDmRecoveryCoordinator(
  dependencies: CurrentDmRecoveryDependencies,
): Promise<CurrentDmRecoveryCoordinator | undefined> {
  if (dependencies.enabled !== true || !isEligible(dependencies.identity)) {
    return undefined;
  }

  const now = dependencies.scheduler.now();
  const persisted = await dependencies.store.load(dependencies.identity);
  const state: CurrentDmRecoveryPersistedState =
    persisted && sameIdentity(persisted.identity, dependencies.identity)
      ? persisted
      : {
          version: 1,
          identity: cloneIdentity(dependencies.identity),
          lifecycle: "active",
          activityAt: now,
          activityRevision: 1,
          milestones: { status: "unclaimed", checkpoint: "unclaimed", recovery: "unclaimed" },
          updatedAt: now,
        };

  // An adopted intent means a prior process crossed the durable send boundary;
  // whether its callback began is unknowable, so fail closed rather than replay.
  if (
    state.lifecycle === "active" &&
    Object.values(state.milestones).some((value) => value === "intent" || value === "unknown")
  ) {
    state.lifecycle = "ambiguous";
    state.updatedAt = now;
  }

  // Persist the complete exact identity before any timer can exist.
  await dependencies.store.save(state);
  const coordinator = new Coordinator(dependencies, state);
  coordinator.scheduleNext();
  return coordinator;
}
