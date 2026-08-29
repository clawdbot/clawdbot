import { html, type TemplateResult } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import type { BoardWidget } from "../../lib/board/types.ts";
import type { BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";
import { BoardWidgetSandboxHost } from "../../lib/board/widget-sandbox-host.ts";
import { remainingBoardWidgetTicketTtlMs } from "../../lib/board/widget-ticket-lifetime.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isLoopbackHostname } from "../../lib/gateway-locality.ts";
import { generateUUID } from "../../lib/uuid.ts";
import { installWidgetThemeObserver, postWidgetTheme } from "../../lib/widget-theme.ts";
import { resolveGatewayHttpOrigin, resolveSandboxHostUrl } from "../sandbox-host.ts";

// Keep in sync with the identical literal in chat widget-card.ts: a shared
// module is not worth its startup-bundle cost for one string.
const WIDGET_SIZE_MESSAGE_TYPE = "openclaw:widget-size";
const WIDGET_BOARD_HOST_MESSAGE_TYPE = "openclaw:widget-board-host";
const WIDGET_SCROLL_MESSAGE_TYPE = "openclaw:widget-scroll";
const MAX_FRAME_REFRESH_ATTEMPTS = 3;
const TICKET_REFRESH_LEAD_MS = 15_000;
const TICKET_REFRESH_MIN_DELAY_MS = 1_000;
const TICKET_REFRESH_RETRY_MS = 1_000;
const TICKET_REFRESH_MAX_RETRY_MS = 30_000;

function documentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

// Without mcp.apps.sandboxOrigin the sandbox URL is the gateway origin with the
// sandbox port substituted. On a non-loopback host that derived port often sits
// behind a reverse proxy or tunnel that does not route it, and the browser
// cannot distinguish that from a real authorization failure — so the terminal
// message keeps the authorization fact but adds the deployment hint operators
// otherwise never find.
function resolveBoardFrameFailureMessage(
  widget: Pick<BoardWidget, "sandboxOrigin">,
  resolvedSandboxOrigin: string,
): string {
  if (!widget.sandboxOrigin && resolvedSandboxOrigin) {
    try {
      if (!isLoopbackHostname(new URL(resolvedSandboxOrigin).hostname)) {
        return t("board.widget.sandboxOriginRequired");
      }
    } catch {
      // Fall through to the generic message for unparseable origins.
    }
  }
  return t("board.widget.frameAuthorizationFailed");
}

type FrameRefresh = (name: string) => Promise<void>;

type BoardWidgetFrameLifecycleHost = {
  active: () => boolean;
  connected: () => boolean;
  context: () => ApplicationContext | undefined;
  refreshFrame: () => FrameRefresh | undefined;
  requestUpdate: () => void;
  reportContentHeight: (name: string, height: number) => void;
  scrollBy: (deltaY: number) => void;
  resolveFrameUrl: () => BoardWidgetFrameUrl | undefined;
  root: () => ParentNode;
  widget: () => BoardWidget | undefined;
};

class BoardWidgetTicketRefresh {
  private timer: number | null = null;
  private attempts = 0;
  private scheduledTicket = "";

  constructor(
    private readonly currentTicket: () => string | undefined,
    private readonly canRefresh: () => boolean,
  ) {}

  private clearTimer(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  reset(): void {
    this.clearTimer();
    this.attempts = 0;
    this.scheduledTicket = "";
  }

  schedule(widget: BoardWidget | undefined, refresh: FrameRefresh | undefined): void {
    const ticket = widget?.viewTicket;
    const remainingTtlMs = widget ? remainingBoardWidgetTicketTtlMs(widget) : undefined;
    if (!this.canRefresh() || !widget || !refresh || !ticket || remainingTtlMs === undefined) {
      this.reset();
      return;
    }
    if (this.scheduledTicket === ticket) {
      return;
    }
    this.clearTimer();
    this.attempts = 0;
    this.scheduledTicket = ticket;
    const delayMs = Math.max(TICKET_REFRESH_MIN_DELAY_MS, remainingTtlMs - TICKET_REFRESH_LEAD_MS);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.refresh(widget.name, ticket, refresh);
    }, delayMs);
  }

  private refresh(name: string, ticket: string, refresh: FrameRefresh): void {
    if (!this.canRefresh()) {
      this.reset();
      return;
    }
    if (this.currentTicket() !== ticket || this.scheduledTicket !== ticket) {
      return;
    }
    this.attempts += 1;
    const retryIfUnchanged = () => {
      if (this.currentTicket() !== ticket || this.scheduledTicket !== ticket) {
        return;
      }
      // A fulfilled refresh may be discarded by a superseding provider mutation.
      // Retry until this exact expiring ticket is actually replaced.
      this.clearTimer();
      this.timer = window.setTimeout(
        () => {
          this.timer = null;
          this.refresh(name, ticket, refresh);
        },
        Math.min(TICKET_REFRESH_RETRY_MS * this.attempts, TICKET_REFRESH_MAX_RETRY_MS),
      );
    };
    void refresh(name).then(retryIfUnchanged, retryIfUnchanged);
  }
}

export class BoardWidgetFrameLifecycle {
  error = "";

  private frameFailureKey = "";
  private frameRefreshAttempts = 0;
  private frameProbeGeneration = 0;
  private boardHostNonce = "";
  private lastFrameUrl = "";
  private messageListening = false;
  private visibilityListening = false;
  private sandboxOrigin = "";
  private sandboxHost: BoardWidgetSandboxHost | null = null;
  private readonly ticketRefresh = new BoardWidgetTicketRefresh(
    () => this.host.widget()?.viewTicket,
    () => this.host.active() && !documentHidden(),
  );

  constructor(private readonly host: BoardWidgetFrameLifecycleHost) {}

  connect(): void {
    if (!this.messageListening) {
      window.addEventListener("message", this.handleWindowMessage);
      this.messageListening = true;
    }
    if (this.host.active() && !this.visibilityListening) {
      document.addEventListener("visibilitychange", this.handleVisibilityChange);
      this.visibilityListening = true;
    }
    installWidgetThemeObserver();
  }

  disconnect(): void {
    this.stopWork();
    if (this.messageListening) {
      window.removeEventListener("message", this.handleWindowMessage);
      this.messageListening = false;
    }
    this.sandboxHost?.dispose();
    this.sandboxHost = null;
  }

  private suspend(): void {
    this.stopWork();
    this.sandboxHost?.setActive(false);
  }

  private stopWork(): void {
    if (this.visibilityListening) {
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
      this.visibilityListening = false;
    }
    this.ticketRefresh.reset();
  }

  activityChanged(): void {
    if (this.host.active()) {
      this.connect();
      this.sandboxHost?.setActive(true);
    } else {
      // Hidden dashboard cells retain their iframe and sandbox handshake;
      // terminal disconnect is the only lifecycle edge that disposes them.
      this.suspend();
    }
  }

  widgetChanged(previous: BoardWidget, current: BoardWidget | undefined): void {
    if (previous.name !== current?.name || previous.revision !== current?.revision) {
      this.resetFailures(false);
      return;
    }
    if (!current || !this.error) {
      return;
    }
    const nextFrameUrl = this.host.resolveFrameUrl()?.(current.name, current.revision) ?? "";
    if (nextFrameUrl && nextFrameUrl !== this.lastFrameUrl) {
      // A newly minted ticket gets one authorization probe, but keeps the
      // existing remint budget until that probe proves the frame healthy.
      this.setError("", false);
    }
  }

  update(): void {
    if (!this.host.active()) {
      this.suspend();
      return;
    }
    this.resume();
  }

  private resume(): void {
    this.connect();
    this.ticketRefresh.schedule(this.host.widget(), this.host.refreshFrame());
    this.updateSandboxHost();
    this.sandboxHost?.setActive(true);
  }

  render(widget: BoardWidget): TemplateResult {
    const resolveFrameUrl = this.host.resolveFrameUrl();
    if (!resolveFrameUrl) {
      throw new Error(t("board.widget.frameResolverMissing"));
    }
    const src = resolveFrameUrl(widget.name, widget.revision);
    this.lastFrameUrl = src;
    const sandboxSrc = this.resolveSandboxFrameUrl(widget);
    if (sandboxSrc) {
      // Never grant popups: host.open handles user-clicked links so ungranted
      // widgets cannot escape network containment through navigation.
      return html`
        <iframe
          class="board-widget__frame"
          sandbox="allow-scripts allow-same-origin allow-forms"
          referrerpolicy="origin"
          loading="eager"
          title=${widget.title || widget.name}
          src=${sandboxSrc}
          @error=${() => {
            if (this.sandboxHost) {
              this.sandboxHost.handleFrameError();
            } else {
              this.refreshFailedFrame(widget);
            }
          }}
          @load=${(event: Event) => this.notifyBoardHost(event)}
        ></iframe>
      `;
    }
    if (widget.sandboxUrl || widget.sandboxPort || widget.viewTicket) {
      throw new Error(t("board.widget.sandboxUnavailable"));
    }
    // Snapshots from hosts predating the shared-sandbox contract remain capless:
    // no bridge ticket or network CSP authority crosses this compatibility path.
    return html`
      <iframe
        class="board-widget__frame"
        sandbox="allow-scripts"
        referrerpolicy="no-referrer"
        loading="lazy"
        title=${widget.title || widget.name}
        src=${src}
        @error=${() => this.refreshFailedFrame(widget)}
        @load=${(event: Event) => {
          this.notifyBoardHost(event);
          this.verifyAuthorization(event, widget);
        }}
      ></iframe>
    `;
  }

  private setError(error: string, notify = true): void {
    if (this.error === error) {
      return;
    }
    this.error = error;
    if (notify) {
      this.host.requestUpdate();
    }
  }

  private resetFailures(notify = true): void {
    this.frameProbeGeneration += 1;
    this.frameFailureKey = "";
    this.frameRefreshAttempts = 0;
    this.setError("", notify);
    this.sandboxHost?.reset();
  }

  private refreshFailedFrame(widget: BoardWidget): void {
    if (!this.host.active()) {
      return;
    }
    this.frameProbeGeneration += 1;
    const failureKey = `${widget.name}:${widget.revision}`;
    if (this.frameFailureKey !== failureKey) {
      this.resetFailures(false);
      this.frameFailureKey = failureKey;
    }
    if (this.frameRefreshAttempts >= MAX_FRAME_REFRESH_ATTEMPTS) {
      this.setError(resolveBoardFrameFailureMessage(widget, this.sandboxOrigin));
      return;
    }
    const refreshFrame = this.host.refreshFrame();
    if (!refreshFrame) {
      this.setError(t("board.widget.frameResolverMissing"));
      return;
    }
    this.frameRefreshAttempts += 1;
    void refreshFrame(widget.name).catch((error: unknown) => {
      this.setError(formatUiError(error));
    });
    if (this.frameRefreshAttempts >= MAX_FRAME_REFRESH_ATTEMPTS) {
      this.setError(resolveBoardFrameFailureMessage(widget, this.sandboxOrigin));
    }
  }

  private verifyAuthorization(event: Event, widget: BoardWidget): void {
    const frame = event.currentTarget;
    const src = frame instanceof HTMLIFrameElement ? (frame.getAttribute("src") ?? "") : "";
    if (!src.startsWith("/__openclaw__/board/")) {
      return;
    }
    const probeGeneration = this.frameProbeGeneration + 1;
    this.frameProbeGeneration = probeGeneration;
    const isCurrentProbe = () =>
      frame instanceof HTMLIFrameElement &&
      frame.isConnected &&
      frame.getAttribute("src") === src &&
      this.frameProbeGeneration === probeGeneration &&
      this.host.active() &&
      this.host.widget()?.name === widget.name &&
      this.host.widget()?.revision === widget.revision;
    // View tickets are reusable HMAC bindings until expiry. Iframe load events
    // hide HTTP status, so a credentialed probe is the only 401 signal.
    void fetch(src, { cache: "no-store" })
      .then((response) => {
        if (!isCurrentProbe()) {
          return;
        }
        if (response.status === 401) {
          this.refreshFailedFrame(widget);
        } else if (response.ok) {
          this.resetFailures();
        }
      })
      .catch(() => {
        if (isCurrentProbe()) {
          this.refreshFailedFrame(widget);
        }
      });
  }

  private notifyBoardHost(event: Event): void {
    const frame = event.currentTarget;
    if (frame instanceof HTMLIFrameElement) {
      this.boardHostNonce = generateUUID();
      postWidgetTheme(frame, this.sandboxOrigin || "*");
      frame.contentWindow?.postMessage(
        { type: WIDGET_BOARD_HOST_MESSAGE_TYPE, nonce: this.boardHostNonce },
        this.sandboxOrigin || "*",
      );
    }
  }

  private resolveSandboxFrameUrl(widget: BoardWidget): string | undefined {
    const gatewayUrl = this.host.context()?.gateway.connection.gatewayUrl;
    if (
      !widget.sandboxUrl ||
      !widget.sandboxPort ||
      !widget.viewTicket ||
      gatewayUrl === undefined
    ) {
      return undefined;
    }
    const url = resolveSandboxHostUrl(
      widget.sandboxUrl,
      widget.sandboxPort,
      widget.sandboxOrigin,
      gatewayUrl,
      window.location.origin,
    );
    this.sandboxOrigin = new URL(url).origin;
    return url;
  }

  private sandboxHostOptions(
    frame: HTMLIFrameElement,
    widget: BoardWidget,
  ): ConstructorParameters<typeof BoardWidgetSandboxHost>[0] | undefined {
    const resolveFrameUrl = this.host.resolveFrameUrl();
    if (!resolveFrameUrl) {
      return undefined;
    }
    return {
      frame,
      widget,
      sandboxOrigin: this.sandboxOrigin,
      sandboxUrl: frame.src,
      sourceOrigin: resolveGatewayHttpOrigin(
        this.host.context()?.gateway.connection.gatewayUrl ?? "",
        window.location.origin,
      ),
      controlUiBaseUrl: `${window.location.origin}${this.host.context()?.basePath ?? ""}`,
      client: this.host.context()?.gateway.snapshot.client ?? undefined,
      resolveFrameUrl,
      confirmPrompt: (prompt) => window.confirm(`${t("common.confirm")}:\n\n${prompt}`),
      onFrameUrl: (url) => {
        this.lastFrameUrl = url;
      },
      onLoadFailed: (currentWidget) => this.refreshFailedFrame(currentWidget),
      onUnauthorized: (currentWidget) => this.refreshFailedFrame(currentWidget),
      onReadyTimeout: () => this.refreshFailedFrame(widget),
      onLoaded: () => {
        this.frameFailureKey = "";
        this.frameRefreshAttempts = 0;
        this.setError("");
      },
      onError: (error) => {
        this.setError(formatUiError(error));
      },
    };
  }

  private updateSandboxHost(): void {
    const frame = this.host.root().querySelector<HTMLIFrameElement>(".board-widget__frame");
    const widget = this.host.widget();
    if (
      !frame?.isConnected ||
      !widget ||
      !widget.sandboxUrl ||
      !widget.sandboxPort ||
      !widget.viewTicket
    ) {
      this.sandboxHost?.dispose();
      this.sandboxHost = null;
      return;
    }
    const options = this.sandboxHostOptions(frame, widget);
    if (!options) {
      return;
    }
    if (!this.sandboxHost || this.sandboxHost.frame !== frame) {
      this.sandboxHost?.dispose();
      this.sandboxHost = new BoardWidgetSandboxHost(options);
    } else {
      this.sandboxHost.update(options);
    }
  }

  private readonly handleVisibilityChange = (): void => {
    if (documentHidden()) {
      this.ticketRefresh.reset();
      return;
    }
    this.ticketRefresh.schedule(this.host.widget(), this.host.refreshFrame());
  };

  private handleWindowMessage = (event: MessageEvent): void => {
    if (!this.host.connected()) {
      return;
    }
    const frame = this.host.root().querySelector<HTMLIFrameElement>(".board-widget__frame");
    const widget = this.host.widget();
    if (!this.host.active()) {
      if (frame && event.source === frame.contentWindow && event.origin === this.sandboxOrigin) {
        this.sandboxHost?.handleMessage(event);
      }
      return;
    }
    const data = event.data as {
      type?: unknown;
      height?: unknown;
      deltaY?: unknown;
      nonce?: unknown;
    } | null;
    if (
      frame &&
      widget &&
      event.source === frame.contentWindow &&
      data?.type === WIDGET_SIZE_MESSAGE_TYPE &&
      typeof data.height === "number" &&
      Number.isFinite(data.height) &&
      data.height > 0
    ) {
      this.host.reportContentHeight(widget.name, data.height);
    }
    if (
      frame &&
      widget &&
      event.source === frame.contentWindow &&
      data?.type === WIDGET_SCROLL_MESSAGE_TYPE &&
      data.nonce === this.boardHostNonce &&
      typeof data.deltaY === "number" &&
      Number.isFinite(data.deltaY) &&
      data.deltaY !== 0
    ) {
      this.host.scrollBy(data.deltaY);
    }
    if (
      !frame ||
      !widget?.viewTicket ||
      event.source !== frame.contentWindow ||
      event.origin !== this.sandboxOrigin
    ) {
      return;
    }
    const options = this.sandboxHostOptions(frame, widget);
    if (!options) {
      return;
    }
    if (!this.sandboxHost || this.sandboxHost.frame !== frame) {
      this.sandboxHost?.dispose();
      this.sandboxHost = new BoardWidgetSandboxHost(options);
    } else {
      this.sandboxHost.update(options);
    }
    this.sandboxHost.handleMessage(event);
    if (event.data?.type === "openclaw:widget-bridge-ready") {
      postWidgetTheme(frame, this.sandboxOrigin);
    }
  };
}
