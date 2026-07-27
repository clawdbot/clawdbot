import { html, type TemplateResult } from "lit";
import type { ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import type { BoardViewWidget, BoardWidgetFrameUrl } from "../../lib/board/view-types.ts";
import { BoardWidgetSandboxHost } from "../../lib/board/widget-sandbox-host.ts";
import { remainingBoardWidgetTicketTtlMs } from "../../lib/board/widget-ticket-lifetime.ts";
import { resolveGatewayHttpOrigin, resolveSandboxHostUrl } from "../sandbox-host.ts";

// Keep in sync with the identical literal in chat widget-card.ts: a shared
// module is not worth its startup-bundle cost for one string.
const WIDGET_SIZE_MESSAGE_TYPE = "openclaw:widget-size";
const MAX_FRAME_REFRESH_ATTEMPTS = 3;
const TICKET_REFRESH_LEAD_MS = 15_000;
const TICKET_REFRESH_MIN_DELAY_MS = 1_000;
const TICKET_REFRESH_RETRY_MS = 1_000;
const TICKET_REFRESH_MAX_RETRY_MS = 30_000;

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

// Without mcp.apps.sandboxOrigin the sandbox URL is the gateway origin with the
// sandbox port substituted. On a non-loopback host that derived port often sits
// behind a reverse proxy or tunnel that does not route it, and the browser
// cannot distinguish that from a real authorization failure — so the terminal
// message keeps the authorization fact but adds the deployment hint operators
// otherwise never find.
function resolveBoardFrameFailureMessage(
  widget: Pick<BoardViewWidget, "sandboxOrigin">,
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
  connected: () => boolean;
  context: () => ApplicationContext | undefined;
  refreshFrame: () => FrameRefresh | undefined;
  requestUpdate: () => void;
  reportContentHeight: (name: string, height: number) => void;
  resolveFrameUrl: () => BoardWidgetFrameUrl | undefined;
  root: () => ParentNode;
  widget: () => BoardViewWidget | undefined;
};

class BoardWidgetTicketRefresh {
  private timer: number | null = null;
  private attempts = 0;
  private scheduledTicket = "";

  constructor(private readonly currentTicket: () => string | undefined) {}

  clear(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  schedule(widget: BoardViewWidget | undefined, refresh: FrameRefresh | undefined): void {
    const ticket = widget?.viewTicket;
    const remainingTtlMs = widget ? remainingBoardWidgetTicketTtlMs(widget) : undefined;
    if (!widget || !refresh || !ticket || remainingTtlMs === undefined) {
      this.clear();
      this.attempts = 0;
      this.scheduledTicket = "";
      return;
    }
    if (this.scheduledTicket === ticket) {
      return;
    }
    this.clear();
    this.attempts = 0;
    this.scheduledTicket = ticket;
    const delayMs = Math.max(TICKET_REFRESH_MIN_DELAY_MS, remainingTtlMs - TICKET_REFRESH_LEAD_MS);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.refresh(widget.name, ticket, refresh);
    }, delayMs);
  }

  private refresh(name: string, ticket: string, refresh: FrameRefresh): void {
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
      this.clear();
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
  private lastFrameUrl = "";
  private listening = false;
  private sandboxOrigin = "";
  private sandboxHost: BoardWidgetSandboxHost | null = null;
  private readonly ticketRefresh = new BoardWidgetTicketRefresh(
    () => this.host.widget()?.viewTicket,
  );

  constructor(private readonly host: BoardWidgetFrameLifecycleHost) {}

  connect(): void {
    if (this.listening) {
      return;
    }
    window.addEventListener("message", this.handleWindowMessage);
    this.listening = true;
  }

  disconnect(): void {
    if (this.listening) {
      window.removeEventListener("message", this.handleWindowMessage);
      this.listening = false;
    }
    this.ticketRefresh.clear();
    this.sandboxHost?.dispose();
    this.sandboxHost = null;
  }

  widgetChanged(previous: BoardViewWidget, current: BoardViewWidget | undefined): void {
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
    this.ticketRefresh.schedule(this.host.widget(), this.host.refreshFrame());
    this.updateSandboxHost();
  }

  render(widget: BoardViewWidget): TemplateResult {
    const resolveFrameUrl = this.host.resolveFrameUrl();
    if (!resolveFrameUrl) {
      throw new Error(t("board.widget.frameResolverMissing"));
    }
    const src = resolveFrameUrl(widget.name, widget.revision);
    this.lastFrameUrl = src;
    const sandboxSrc = this.resolveSandboxFrameUrl(widget);
    if (sandboxSrc) {
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
        @load=${(event: Event) => this.verifyAuthorization(event, widget)}
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

  private refreshFailedFrame(widget: BoardViewWidget): void {
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
      this.setError(error instanceof Error ? error.message : String(error));
    });
    if (this.frameRefreshAttempts >= MAX_FRAME_REFRESH_ATTEMPTS) {
      this.setError(resolveBoardFrameFailureMessage(widget, this.sandboxOrigin));
    }
  }

  private verifyAuthorization(event: Event, widget: BoardViewWidget): void {
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

  private resolveSandboxFrameUrl(widget: BoardViewWidget): string | undefined {
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
    widget: BoardViewWidget,
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
        this.setError(error instanceof Error ? error.message : String(error));
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

  private handleWindowMessage = (event: MessageEvent): void => {
    if (!this.host.connected()) {
      return;
    }
    const frame = this.host.root().querySelector<HTMLIFrameElement>(".board-widget__frame");
    const widget = this.host.widget();
    const data = event.data as { type?: unknown; height?: unknown } | null;
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
  };
}
