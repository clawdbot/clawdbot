import type { RouteMatch, Router, RouterState } from "@openclaw/uirouter";

const DEFAULT_PENDING_DELAY_MS = 1_000;

type RouterOutletStateSlice<
  TRouteId extends string = string,
  TModule = unknown,
  TData = unknown,
> = {
  status: RouterState<TRouteId, TModule, TData>["status"];
  active: RouteMatch<TRouteId, TModule, TData> | undefined;
  pending: RouteMatch<TRouteId, TModule, TData> | undefined;
};

export type RouterOutletSnapshot<
  TRouteId extends string = string,
  TModule = unknown,
  TData = unknown,
> = RouterOutletStateSlice<TRouteId, TModule, TData> & {
  showPending: boolean;
};

type RouterOutletInputs<TRouteId extends string, TLoadContext, TModule, TData> = {
  router?: Router<TRouteId, TLoadContext, TModule, TData>;
  onNotFound?: () => void;
};

type RouterOutletControllerOptions = {
  pendingDelayMs?: number;
};

export function selectRenderedRouteMatch<TRouteId extends string, TModule, TData>(
  active: RouteMatch<TRouteId, TModule, TData> | undefined,
  pending: RouteMatch<TRouteId, TModule, TData> | undefined,
): RouteMatch<TRouteId, TModule, TData> | undefined {
  const coldPending =
    pending?.status === "pending" && pending.module === undefined && pending.error === undefined;
  return coldPending && active ? active : (pending ?? active);
}

function selectRouterOutletState<TRouteId extends string, TModule, TData>(
  state: RouterState<TRouteId, TModule, TData>,
): RouterOutletStateSlice<TRouteId, TModule, TData> {
  return {
    status: state.status,
    active: state.matches[0],
    pending: state.pendingMatches[0],
  };
}

function equalRouterOutletState(
  previous: RouterOutletStateSlice,
  next: RouterOutletStateSlice,
): boolean {
  return (
    previous.status === next.status &&
    previous.active === next.active &&
    previous.pending === next.pending
  );
}

function idleSnapshot<TRouteId extends string, TModule, TData>(): RouterOutletSnapshot<
  TRouteId,
  TModule,
  TData
> {
  return {
    status: "idle",
    active: undefined,
    pending: undefined,
    showPending: false,
  };
}

/**
 * Owns route-presentation timing and effects without depending on a renderer.
 * Render adapters provide invalidation and bind the controller to their own
 * connection lifecycle.
 */
export class RouterOutletController<
  TRouteId extends string = string,
  TLoadContext = unknown,
  TModule = unknown,
  TData = unknown,
> {
  private router?: Router<TRouteId, TLoadContext, TModule, TData>;
  private onNotFound?: () => void;
  private connected = false;
  private unsubscribe?: () => void;
  private selection: RouterOutletStateSlice<TRouteId, TModule, TData> = idleSnapshot();
  private snapshotValue: RouterOutletSnapshot<TRouteId, TModule, TData> = idleSnapshot();
  private pendingMatchId?: string;
  private pendingTimer?: ReturnType<typeof globalThis.setTimeout>;
  private showPending = false;
  private notFoundActive = false;
  private notFoundQueued = false;
  private notFoundGeneration = 0;
  private readonly pendingDelayMs: number;

  constructor(
    private readonly invalidate: () => void,
    options: RouterOutletControllerOptions = {},
  ) {
    this.pendingDelayMs = options.pendingDelayMs ?? DEFAULT_PENDING_DELAY_MS;
  }

  get snapshot(): RouterOutletSnapshot<TRouteId, TModule, TData> {
    return this.snapshotValue;
  }

  setInputs(inputs: RouterOutletInputs<TRouteId, TLoadContext, TModule, TData>): void {
    this.onNotFound = inputs.onNotFound;
    if (this.router === inputs.router) {
      return;
    }

    this.detachSource();
    this.router = inputs.router;
    if (this.connected) {
      this.attachSource();
      return;
    }
    const selection = inputs.router
      ? selectRouterOutletState(inputs.router.getState())
      : idleSnapshot<TRouteId, TModule, TData>();
    this.selection = selection;
    this.publish({ ...selection, showPending: false });
  }

  connect(): void {
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.attachSource(false);
    // A disconnected host may have retained DOM for an older snapshot. Always
    // reconcile once on reconnect, even when the router state stayed stable.
    this.invalidate();
  }

  disconnect(): void {
    if (!this.connected) {
      return;
    }
    this.connected = false;
    this.detachSource();
  }

  private attachSource(notify = true): void {
    const router = this.router;
    if (!router || this.unsubscribe) {
      return;
    }
    this.applySelection(selectRouterOutletState(router.getState()), notify);
    this.unsubscribe = router.subscribeSelector(
      selectRouterOutletState,
      (selection) => this.applySelection(selection),
      equalRouterOutletState,
    );
  }

  private detachSource(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.clearPendingTimer();
    this.pendingMatchId = undefined;
    this.showPending = false;
    this.cancelNotFoundEffect();
  }

  private applySelection(
    selection: RouterOutletStateSlice<TRouteId, TModule, TData>,
    notify = true,
  ): void {
    this.selection = selection;
    const pending = selection.pending;
    const coldPending =
      pending?.status === "pending" && pending.module === undefined && pending.error === undefined;
    const needsPendingFallback = coldPending && !selection.active;
    if (!needsPendingFallback) {
      this.clearPendingTimer();
      this.pendingMatchId = undefined;
      this.showPending = false;
    } else if (this.pendingMatchId !== pending.id) {
      this.clearPendingTimer();
      this.pendingMatchId = pending.id;
      this.showPending = false;
      this.schedulePendingFallback(pending.id);
    } else if (this.connected && !this.showPending && this.pendingTimer === undefined) {
      this.schedulePendingFallback(pending.id);
    }

    this.publish({ ...selection, showPending: this.showPending }, notify);
    this.updateNotFoundEffect(selection.status);
  }

  private schedulePendingFallback(matchId: string): void {
    if (!this.connected) {
      return;
    }
    this.pendingTimer = globalThis.setTimeout(() => {
      this.pendingTimer = undefined;
      const pending = this.selection.pending;
      const stillCold =
        pending?.id === matchId &&
        pending.status === "pending" &&
        pending.module === undefined &&
        pending.error === undefined &&
        !this.selection.active;
      if (!this.connected || this.pendingMatchId !== matchId || !stillCold) {
        return;
      }
      this.showPending = true;
      this.publish({ ...this.selection, showPending: true });
    }, this.pendingDelayMs);
  }

  private updateNotFoundEffect(status: RouterOutletStateSlice["status"]): void {
    if (status !== "notFound") {
      if (this.notFoundActive || this.notFoundQueued) {
        this.cancelNotFoundEffect();
      }
      return;
    }
    if (!this.connected || this.notFoundActive) {
      return;
    }

    this.notFoundActive = true;
    this.notFoundQueued = true;
    const generation = ++this.notFoundGeneration;
    queueMicrotask(() => {
      if (
        !this.connected ||
        generation !== this.notFoundGeneration ||
        this.selection.status !== "notFound"
      ) {
        return;
      }
      this.notFoundQueued = false;
      this.onNotFound?.();
    });
  }

  private cancelNotFoundEffect(): void {
    this.notFoundGeneration += 1;
    this.notFoundActive = false;
    this.notFoundQueued = false;
  }

  private publish(snapshot: RouterOutletSnapshot<TRouteId, TModule, TData>, notify = true): void {
    const previous = this.snapshotValue;
    if (
      previous.status === snapshot.status &&
      previous.active === snapshot.active &&
      previous.pending === snapshot.pending &&
      previous.showPending === snapshot.showPending
    ) {
      return;
    }
    this.snapshotValue = snapshot;
    if (notify && this.connected) {
      this.invalidate();
    }
  }

  private clearPendingTimer(): void {
    if (this.pendingTimer !== undefined) {
      globalThis.clearTimeout(this.pendingTimer);
      this.pendingTimer = undefined;
    }
  }
}
