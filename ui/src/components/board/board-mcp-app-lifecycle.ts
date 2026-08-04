import type { BoardWidgetAppViewState, BoardViewWidget } from "../../lib/board/view-types.ts";

const REFRESH_LEAD_MS = 5_000;
type AppViewMode = "cached" | "refresh" | "expired";

function appViewKey(sessionKey: string, widget: BoardViewWidget): string {
  return `${sessionKey}\0${widget.name}\0${widget.revision}\0${widget.instanceId ?? ""}\0${widget.grantState}`;
}

function clearTimer(timer: number | undefined): undefined {
  if (timer !== undefined) {
    window.clearTimeout(timer);
  }
  return undefined;
}

class NearViewportObserver {
  private observer?: IntersectionObserver;
  nearVisible = false;
  target?: Element;

  constructor(
    private readonly marginPx: number,
    private readonly visibilityChanged: () => void,
  ) {}

  observe(target: Element): void {
    if (target === this.target) {
      return;
    }
    this.disconnect();
    this.target = target;
    this.setNearVisible(this.isNearViewport(target));
    if (typeof IntersectionObserver === "undefined") {
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        const entry = entries.at(-1);
        if (!entry || entry.target !== this.target) {
          return;
        }
        this.setNearVisible(entry.isIntersecting || this.isNearViewport(entry.target));
      },
      { rootMargin: `${this.marginPx}px 0px` },
    );
    this.observer.observe(target);
  }

  disconnect(): void {
    this.observer?.disconnect();
    this.observer = undefined;
    this.target = undefined;
    this.setNearVisible(false);
  }

  private setNearVisible(nearVisible: boolean): void {
    if (nearVisible !== this.nearVisible) {
      this.nearVisible = nearVisible;
      this.visibilityChanged();
    }
  }

  private isNearViewport(target: Element): boolean {
    const bounds = target.getBoundingClientRect();
    return bounds.bottom >= -this.marginPx && bounds.top <= window.innerHeight + this.marginPx;
  }
}

type AppViewCallbacks = {
  widgetAppView: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
  refreshWidgetAppView: (name: string, revision: number) => Promise<BoardWidgetAppViewState>;
};

type LifecycleHost = {
  connected: () => boolean;
  requestUpdate: () => void;
  sessionKey: () => string;
  widget: () => BoardViewWidget | undefined;
};

export class BoardMcpAppLifecycle {
  state?: BoardWidgetAppViewState;
  loading = false;

  private callbacks?: AppViewCallbacks;
  private key = "";
  private generation = 0;
  private renewalTimer?: number;
  private expiryTimer?: number;
  private readonly visibility = new NearViewportObserver(600, () => this.visibilityChanged());

  constructor(private readonly host: LifecycleHost) {}

  get nearVisible(): boolean {
    return this.visibility.nearVisible;
  }

  update(widget: BoardViewWidget | undefined, callbacks: AppViewCallbacks | undefined): void {
    this.callbacks = callbacks;
    if (!widget || widget.contentKind !== "mcp-app" || !callbacks) {
      this.reset();
      return;
    }
    const key = appViewKey(this.host.sessionKey(), widget);
    if (key !== this.key) {
      this.clearTimers();
      this.generation += 1;
      this.loading = false;
      this.key = key;
      this.state = undefined;
    }
  }

  observe(target: Element | null, enabled: boolean): void {
    if (!target || !enabled) {
      this.visibility.disconnect();
      return;
    }
    this.visibility.observe(target);
  }

  sync(): void {
    const widget = this.host.widget();
    const callbacks = this.callbacks;
    if (!widget || widget.contentKind !== "mcp-app" || !callbacks) {
      this.renewalTimer = clearTimer(this.renewalTimer);
      return;
    }
    if (!this.nearVisible) {
      if (!this.loading) {
        this.renewalTimer = clearTimer(this.renewalTimer);
      }
      return;
    }
    if (!this.state && !this.loading) {
      void this.load(widget, callbacks, "cached");
    } else if (
      this.state?.status === "ready" &&
      !this.loading &&
      this.renewalTimer === undefined &&
      this.expiryTimer === undefined
    ) {
      this.scheduleRenewal(widget, callbacks, this.state, false);
    }
  }

  disconnect(): void {
    this.visibility.disconnect();
    this.reset();
    this.callbacks = undefined;
  }

  retry(): void {
    const widget = this.host.widget();
    if (widget && this.callbacks) {
      void this.load(widget, this.callbacks, "refresh");
    }
  }

  expire(): void {
    const widget = this.host.widget();
    const callbacks = this.callbacks;
    if (!widget || !callbacks) {
      return;
    }
    const wasLoading = this.loading;
    this.state = { status: "stale", error: "MCP App view expired" };
    this.loading = false;
    this.notify();
    if (!wasLoading) {
      void this.load(widget, callbacks, "expired");
    }
  }

  private reset(): void {
    this.clearTimers();
    this.generation += 1;
    this.key = "";
    this.state = undefined;
    this.loading = false;
  }

  private clearTimers(): void {
    this.renewalTimer = clearTimer(this.renewalTimer);
    this.expiryTimer = clearTimer(this.expiryTimer);
  }

  private visibilityChanged(): void {
    queueMicrotask(() => {
      if (this.host.connected()) {
        this.notify();
      }
    });
    if (!this.nearVisible && !this.loading) {
      this.renewalTimer = clearTimer(this.renewalTimer);
    }
  }

  private async load(
    widget: BoardViewWidget,
    callbacks: AppViewCallbacks,
    mode: AppViewMode,
  ): Promise<void> {
    if (this.loading || !this.nearVisible) {
      return;
    }
    const key = appViewKey(this.host.sessionKey(), widget);
    if (key !== this.key) {
      return;
    }
    const generation = ++this.generation;
    const isCurrent = () => {
      const current = this.host.widget();
      return (
        this.host.connected() &&
        generation === this.generation &&
        this.key === key &&
        current?.contentKind === "mcp-app" &&
        appViewKey(this.host.sessionKey(), current) === key
      );
    };
    this.clearTimers();
    this.loading = true;
    const previousLease = mode === "refresh" && this.state?.status === "ready" ? this.state : null;
    if (mode === "expired") {
      this.state = undefined;
    }
    this.notify();
    if (previousLease) {
      this.expiryTimer = window.setTimeout(
        () => {
          this.expiryTimer = undefined;
          if (isCurrent()) {
            this.state = { status: "stale", error: "MCP App lease expired while renewing" };
            this.loading = false;
            this.notify();
          }
        },
        Math.max(0, previousLease.expiresAtMs - Date.now()),
      );
    }
    try {
      const appView = await (mode === "cached"
        ? callbacks.widgetAppView(widget.name, widget.revision)
        : callbacks.refreshWidgetAppView(widget.name, widget.revision));
      if (!isCurrent()) {
        return;
      }
      if (appView.status === "stale" && previousLease && previousLease.expiresAtMs > Date.now()) {
        this.loading = false;
        this.notify();
        return;
      }
      this.clearTimers();
      this.state = appView;
      this.loading = false;
      this.scheduleRenewal(widget, callbacks, appView, mode !== "cached");
      this.notify();
    } catch (error) {
      if (!isCurrent()) {
        return;
      }
      if (previousLease && previousLease.expiresAtMs > Date.now()) {
        this.loading = false;
        this.notify();
        return;
      }
      this.clearTimers();
      this.state = {
        status: "stale",
        error: error instanceof Error ? error.message : String(error),
      };
      this.loading = false;
      this.notify();
    }
  }

  private scheduleExpiry(widget: BoardViewWidget, appView: BoardWidgetAppViewState): void {
    if (appView.status !== "ready") {
      return;
    }
    this.expiryTimer = clearTimer(this.expiryTimer);
    const key = this.key;
    this.expiryTimer = window.setTimeout(
      () => {
        this.expiryTimer = undefined;
        const current = this.host.widget();
        const state = this.state;
        if (
          this.host.connected() &&
          this.key === key &&
          current?.name === widget.name &&
          current.revision === widget.revision &&
          state?.status === "ready" &&
          state.viewId === appView.viewId &&
          state.expiresAtMs === appView.expiresAtMs
        ) {
          this.state = { status: "stale", error: "MCP App lease expired" };
          this.notify();
        }
      },
      Math.max(0, appView.expiresAtMs - Date.now()),
    );
  }

  private scheduleRenewal(
    widget: BoardViewWidget,
    callbacks: AppViewCallbacks,
    appView: BoardWidgetAppViewState,
    renewed: boolean,
  ): void {
    this.renewalTimer = clearTimer(this.renewalTimer);
    if (appView.status !== "ready") {
      return;
    }
    const key = this.key;
    const delayMs = appView.expiresAtMs - Date.now() - REFRESH_LEAD_MS;
    if (!this.nearVisible) {
      if (renewed && delayMs <= 0) {
        this.scheduleExpiry(widget, appView);
      }
      return;
    }
    if (delayMs <= 0) {
      if (renewed) {
        this.scheduleExpiry(widget, appView);
      } else {
        void this.load(widget, callbacks, "refresh");
      }
      return;
    }
    this.renewalTimer = window.setTimeout(() => {
      this.renewalTimer = undefined;
      const current = this.host.widget();
      if (
        this.host.connected() &&
        this.nearVisible &&
        this.key === key &&
        current?.name === widget.name &&
        current.revision === widget.revision
      ) {
        void this.load(current, callbacks, "refresh");
      }
    }, delayMs);
  }

  private notify(): void {
    this.host.requestUpdate();
  }
}
