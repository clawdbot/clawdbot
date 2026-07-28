import type { ReactiveControllerHost } from "lit";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  isBrowserEvaluateDisabledError,
  readBrowserPageMetrics,
  type BrowserPageMetrics,
} from "./browser-client.ts";

export interface BrowserPanelControllerHost extends ReactiveControllerHost {
  readonly client: GatewayBrowserClient | null;
  readonly available: boolean;
  readonly basePath: string;
  readonly authToken: string | null;
  readonly isConnected: boolean;
  readonly renderRoot: HTMLElement | DocumentFragment;
  readonly updateComplete: Promise<boolean>;
  browserPanelIsOpen(): boolean;
}

type BrowserPanelInvocation = {
  epoch: number;
  readonly id: number;
  readonly mutationId: number;
  isCurrent(): boolean;
};

type BrowserNavigationCommit = {
  committed: number;
  reconciled: number;
};

export type BrowserPanelSnapshotOutcome = "accepted" | "rejected" | "failed";

/** Owns the panel lifecycle, tab snapshots, captures, and pointer operations. */
export class BrowserPanelOperationOwnership {
  private lifecycleEpoch = 0;
  private requestedMutation = 0;
  private requestedSnapshot = 0;
  private acceptedSnapshot = 0;
  private requestedCapture = 0;
  private requestedInspection = 0;
  private capturePending = false;
  private readonly navigationQueues = new WeakMap<
    GatewayBrowserClient,
    Map<string, Promise<unknown>>
  >();
  private readonly navigationCommits = new WeakMap<
    GatewayBrowserClient,
    Map<string, BrowserNavigationCommit>
  >();

  constructor(private readonly host: BrowserPanelControllerHost) {}

  get epoch(): number {
    return this.lifecycleEpoch;
  }

  get hasPendingCapture(): boolean {
    return this.capturePending;
  }

  captureClient(): GatewayBrowserClient | null {
    return this.host.available && this.host.client ? this.host.client : null;
  }

  isLive(epoch: number, client?: GatewayBrowserClient): boolean {
    return (
      this.host.isConnected &&
      this.host.browserPanelIsOpen() &&
      this.lifecycleEpoch === epoch &&
      (client === undefined || this.host.client === client)
    );
  }

  invalidate(): void {
    this.lifecycleEpoch += 1;
    this.capturePending = false;
    this.invalidateInspection();
  }

  invalidateInspection(): void {
    this.requestedInspection += 1;
  }

  beginMutation(client: GatewayBrowserClient): BrowserPanelInvocation {
    // A mutation owns loading before its remote tab or new document exists.
    // Invalidate the previous capture without discarding its visible screenshot.
    this.requestedCapture += 1;
    this.capturePending = false;
    const invocation: BrowserPanelInvocation = {
      epoch: this.lifecycleEpoch,
      id: ++this.requestedMutation,
      mutationId: this.requestedMutation,
      isCurrent: () =>
        this.isLive(invocation.epoch, client) && invocation.id === this.requestedMutation,
    };
    return invocation;
  }

  /** A queued predecessor can commit even if the newest navigation later fails. */
  hasQueuedNavigation(client: GatewayBrowserClient, targetId: string): boolean {
    return this.navigationQueues.get(client)?.has(targetId) ?? false;
  }

  /** A committed document still needs its first owner-authoritative screenshot. */
  hasUnreconciledNavigation(client: GatewayBrowserClient, targetId: string): boolean {
    const state = this.navigationCommits.get(client)?.get(targetId);
    return state !== undefined && state.committed !== state.reconciled;
  }

  markNavigationCommitted(client: GatewayBrowserClient, targetId: string): void {
    let commits = this.navigationCommits.get(client);
    if (!commits) {
      commits = new Map();
      this.navigationCommits.set(client, commits);
    }
    const state = commits.get(targetId) ?? { committed: 0, reconciled: 0 };
    state.committed += 1;
    commits.set(targetId, state);
  }

  markNavigationReconciled(client: GatewayBrowserClient, targetId: string): void {
    const state = this.navigationCommits.get(client)?.get(targetId);
    if (state) {
      state.reconciled = state.committed;
    }
  }

  /** Remote navigations for one gateway tab must commit in user-intent order. */
  async queueNavigation<T>(
    client: GatewayBrowserClient,
    targetId: string,
    navigate: () => Promise<T>,
  ): Promise<T> {
    let queues = this.navigationQueues.get(client);
    if (!queues) {
      queues = new Map();
      this.navigationQueues.set(client, queues);
    }
    const previous = queues.get(targetId);
    const current = previous ? previous.then(navigate, navigate) : navigate();
    queues.set(targetId, current);
    try {
      return await current;
    } finally {
      if (queues.get(targetId) === current) {
        queues.delete(targetId);
        if (queues.size === 0) {
          this.navigationQueues.delete(client);
        }
      }
    }
  }

  /** Passive refreshes never revoke ownership of an in-flight navigation. */
  beginSnapshot(client: GatewayBrowserClient): BrowserPanelInvocation {
    const mutationId = this.requestedMutation;
    const invocation: BrowserPanelInvocation = {
      epoch: this.lifecycleEpoch,
      id: ++this.requestedSnapshot,
      mutationId,
      isCurrent: () =>
        this.isLive(invocation.epoch, client) &&
        invocation.id === this.requestedSnapshot &&
        mutationId === this.requestedMutation,
    };
    return invocation;
  }

  acceptSnapshot(
    invocation: BrowserPanelInvocation,
    currentTargetId: string | null,
    snapshotTargetId: string | null,
  ): boolean {
    if (
      !this.isLive(invocation.epoch) ||
      invocation.id < this.acceptedSnapshot ||
      (!invocation.isCurrent() && snapshotTargetId !== currentTargetId)
    ) {
      return false;
    }
    this.acceptedSnapshot = invocation.id;
    return true;
  }

  /** Older snapshots may capture the same tab unless a user mutation owns it. */
  canCaptureSnapshot(invocation: BrowserPanelInvocation): boolean {
    return this.isLive(invocation.epoch) && invocation.mutationId === this.requestedMutation;
  }

  /** A superseded open may reconcile its created tab, but never own the selected view. */
  survivingInvocation(
    superseded: BrowserPanelInvocation,
    client: GatewayBrowserClient,
  ): () => boolean {
    const epoch = this.lifecycleEpoch;
    const invocationId = this.requestedMutation;
    return () =>
      this.isLive(epoch, client) &&
      invocationId === this.requestedMutation &&
      (invocationId !== superseded.id || epoch !== superseded.epoch);
  }

  beginCapture(
    client: GatewayBrowserClient,
    targetId: string,
    getActiveTargetId: () => string | null,
    epoch = this.lifecycleEpoch,
  ): (() => boolean) | null {
    if (!this.isLive(epoch, client) || getActiveTargetId() !== targetId) {
      return null;
    }
    const captureId = ++this.requestedCapture;
    this.capturePending = true;
    return () =>
      this.isLive(epoch, client) &&
      getActiveTargetId() === targetId &&
      captureId === this.requestedCapture;
  }

  completeCapture(): void {
    this.capturePending = false;
  }

  beginInspection(client: GatewayBrowserClient, isTargetCurrent: () => boolean): () => boolean {
    const epoch = this.lifecycleEpoch;
    const inspectionId = ++this.requestedInspection;
    return () =>
      this.isLive(epoch, client) && inspectionId === this.requestedInspection && isTargetCurrent();
  }
}

/** A stale gateway must not disable evaluation on the replacement browser. */
export async function readBrowserPanelOwnedMetrics(
  client: GatewayBrowserClient,
  targetId: string,
  evaluateUnavailable: boolean,
  current: () => boolean,
  markEvaluateUnavailable: () => void,
): Promise<BrowserPageMetrics | null> {
  if (evaluateUnavailable) {
    return null;
  }
  try {
    return await readBrowserPageMetrics(client, targetId);
  } catch (error) {
    if (current() && isBrowserEvaluateDisabledError(error)) {
      markEvaluateUnavailable();
    }
    return null;
  }
}
