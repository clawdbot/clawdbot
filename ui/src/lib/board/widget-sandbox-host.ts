import { formatUiError } from "../format-error.ts";
import { WidgetRenderTimeoutError, WidgetSandboxHost } from "../widget-sandbox-host.ts";
import type { BoardWidget } from "./types.ts";
import type { BoardWidgetFrameUrl } from "./view-types.ts";
import {
  BoardWidgetBridgeController,
  type BoardWidgetBridgeGatewayClient,
  isBoardWidgetBridgeRequest,
} from "./widget-bridge.ts";

type BoardWidgetSandboxHostOptions = {
  frame: HTMLIFrameElement;
  widget: BoardWidget;
  bridgeEnabled?: boolean;
  sandboxOrigin: string;
  sandboxUrl: string;
  sourceOrigin: string;
  controlUiBaseUrl?: string;
  client?: BoardWidgetBridgeGatewayClient;
  resolveFrameUrl: BoardWidgetFrameUrl;
  confirmPrompt: (text: string) => boolean;
  onFrameUrl: (url: string) => void;
  onLoadFailed: (widget: BoardWidget) => void;
  onUnauthorized: (widget: BoardWidget) => void;
  onReadyTimeout: () => void;
  onLoaded: () => void;
  onRendered?: () => void;
  onError: (error: unknown) => void;
};

class WidgetDocumentError extends Error {
  constructor(
    readonly kind: "unauthorized" | "invalid-url",
    message: string,
  ) {
    super(message);
  }
}

/** Owns one trusted outer sandbox frame and its ticket-bound inner widget bridge. */
export class BoardWidgetSandboxHost {
  private options: BoardWidgetSandboxHostOptions;
  private active = true;
  private bridgeController: BoardWidgetBridgeController | null = null;
  private bridgeClient: BoardWidgetBridgeGatewayClient | undefined;
  private bridgePort: MessagePort | null = null;
  private adoptedTicket = "";
  private offeredTicket = "";
  private readonly documentHost: WidgetSandboxHost;
  private requestGeneration = 0;
  private readonly pendingRequests = new Map<string, number>();

  constructor(options: BoardWidgetSandboxHostOptions) {
    this.options = options;
    this.documentHost = new WidgetSandboxHost(this.documentOptions());
  }

  get frame(): HTMLIFrameElement {
    return this.options.frame;
  }

  setActive(active: boolean): void {
    if (active === this.active) {
      return;
    }
    this.active = active;
    this.documentHost.setActive(active);
    if (!active) {
      this.cancelPendingRequests("Widget inactive");
      this.requestGeneration += 1;
      return;
    }
    this.postHostInit();
  }

  update(options: BoardWidgetSandboxHostOptions): void {
    const previousClient = this.options.client;
    const previousDocumentKey = this.documentKey();
    const previousSandboxUrl = this.options.sandboxUrl;
    this.options = options;
    const documentChanged = previousDocumentKey !== this.documentKey();
    const sandboxChanged = previousSandboxUrl !== options.sandboxUrl;
    if (documentChanged || sandboxChanged) {
      // A document revision is also an authorization revision. Invalidate both
      // its pending responses and per-document bridge state before loading it.
      this.reset();
      this.bridgeController = null;
      this.bridgeClient = undefined;
    }
    if (previousClient !== options.client) {
      // A reconnect can swap authenticated Gateway identity without changing
      // the widget document. Settle the wrapper promises without allowing a
      // result from the prior authenticated client to cross the new boundary.
      this.cancelPendingRequests("Gateway connection changed");
      this.requestGeneration += 1;
      this.bridgeController = null;
      this.bridgeClient = undefined;
      // A pending HTTP response also belongs to its initiating connection.
      // Retain an already rendered document, but refetch unfinished work.
      if (!this.documentHost.loaded) {
        this.documentHost.reset();
      }
    }
    this.documentHost.update(this.documentOptions());
    if (options.widget.viewTicket && !documentChanged) {
      if (this.adoptedTicket) {
        this.bridgeController?.updateIdentity(options.frame, this.adoptedTicket);
      }
      this.postHostInit();
    }
  }

  reset(): void {
    this.documentHost.reset();
    this.requestGeneration += 1;
    this.pendingRequests.clear();
    this.bridgePort?.close();
    this.bridgePort = null;
    this.adoptedTicket = "";
    this.offeredTicket = "";
  }

  dispose(): void {
    this.active = false;
    this.reset();
    this.documentHost.dispose();
    this.bridgeController = null;
    this.bridgeClient = undefined;
  }

  accepts(event: MessageEvent): boolean {
    return (
      event.source === this.options.frame.contentWindow &&
      event.origin === this.options.sandboxOrigin
    );
  }

  handleFrameError(): void {
    this.documentHost.handleFrameError();
  }

  handleMessage(event: MessageEvent): void {
    if (!this.accepts(event)) {
      return;
    }
    this.documentHost.handleMessage(event);
    if (event.data?.method === "ui/notifications/sandbox-proxy-ready") {
      return;
    }
    if (!this.documentHost.ready) {
      return;
    }
    if (event.data?.type === "openclaw:widget-prompt-offer") {
      event.ports[0]?.close();
      return;
    }
    if (event.data?.type === "openclaw:widget-bridge-port-offer") {
      const port = event.ports[0];
      if (this.options.bridgeEnabled === false || !port || this.bridgePort) {
        port?.close();
        return;
      }
      this.bridgePort = port;
      port.addEventListener("message", (bridgeEvent) => {
        this.handleBridgeMessage(bridgeEvent.data);
      });
      port.start();
      this.postHostInit();
      return;
    }
    if (event.data?.type === "openclaw:widget-bridge-ready") {
      this.postHostInit();
    }
    // Requests on the forgeable window channel never carry authority. The
    // trusted outer proxy adopts only the wrapper's first private MessagePort.
  }

  private handleBridgeMessage(data: unknown): void {
    if (this.options.bridgeEnabled === false) {
      return;
    }
    if (
      data &&
      typeof data === "object" &&
      Reflect.get(data, "type") === "openclaw:widget-host-init-ack" &&
      typeof Reflect.get(data, "ticket") === "string"
    ) {
      const ticket = Reflect.get(data, "ticket") as string;
      if (ticket !== this.offeredTicket) {
        return;
      }
      // The wrapper posts this acknowledgment before any request that uses the
      // new ticket. MessagePort ordering therefore closes the renewal gap while
      // allowing earlier requests to finish on the still-valid prior ticket.
      this.offeredTicket = "";
      this.adoptedTicket = ticket;
      this.bridgeController?.updateIdentity(this.options.frame, ticket);
      this.postHostInit();
      return;
    }
    if (!this.active) {
      if (isBoardWidgetBridgeRequest(data)) {
        this.postResponse(data.id, false, undefined, "Widget inactive");
      }
      return;
    }
    this.handleBridgeRequest(data);
  }

  private handleBridgeRequest(data: unknown): void {
    if (!this.documentHost.ready || !isBoardWidgetBridgeRequest(data)) {
      return;
    }
    const client = this.options.client;
    const ticket = this.adoptedTicket;
    if (!client || !ticket) {
      this.postResponse(data.id, false, undefined, "Gateway unavailable");
      return;
    }
    if (!this.bridgeController || this.bridgeClient !== client) {
      this.bridgeClient = client;
      this.bridgeController = new BoardWidgetBridgeController({
        frame: this.options.frame,
        ticket,
        client,
        // The source path scopes equal-name widgets to their board session;
        // view generation keeps delete/recreate isolated without splitting
        // routine ticket renewals into fresh prompt budgets.
        rateKey: this.documentKey(),
        confirmPrompt: this.options.confirmPrompt,
      });
    } else {
      this.bridgeController.updateIdentity(this.options.frame, ticket);
    }
    const generation = this.requestGeneration;
    const frame = this.options.frame;
    this.pendingRequests.set(data.id, generation);
    void this.bridgeController
      .handle(data, {
        // Only the injected wrapper owns this port, and it posts prompt
        // requests only while its inner-frame user activation is live.
        promptUserActivated: data.method === "prompt.send",
        isCurrent: () => generation === this.requestGeneration && frame === this.options.frame,
      })
      .then((result) => {
        this.completeRequest(data.id, generation, true, result);
      })
      .catch((error: unknown) => {
        this.completeRequest(data.id, generation, false, undefined, formatUiError(error));
      });
  }

  private completeRequest(
    id: string,
    generation: number,
    ok: boolean,
    result?: unknown,
    error?: string,
  ): void {
    if (generation !== this.requestGeneration || this.pendingRequests.get(id) !== generation) {
      return;
    }
    this.pendingRequests.delete(id);
    this.postResponse(id, ok, result, error);
  }

  private cancelPendingRequests(error: string): void {
    for (const [id, generation] of this.pendingRequests) {
      if (generation === this.requestGeneration) {
        this.postResponse(id, false, undefined, error);
      }
    }
    this.pendingRequests.clear();
  }

  private documentKey(): string {
    const sourceUrl = this.options.resolveFrameUrl(
      this.options.widget.name,
      this.options.widget.revision,
    );
    const sourceIdentity = sourceUrl.split(/[?#]/u, 1)[0];
    // Ticket renewal keeps the same generation, while delete/recreate gets a
    // new one even if the name, source path, bytes, and revision are reused.
    const generation = this.options.widget.viewGeneration ?? this.options.widget.viewTicket ?? "";
    // Switching between an interactive board and a passive preview must replace
    // the wrapper document so no previously adopted bridge port crosses modes.
    const bridgeMode = this.options.bridgeEnabled === false ? "passive" : "interactive";
    return `${sourceIdentity}\0${this.options.widget.revision}\0${generation}\0${bridgeMode}`;
  }

  private postHostInit(): void {
    const ticket = this.options.widget.viewTicket;
    if (
      this.options.bridgeEnabled === false ||
      !this.documentHost.ready ||
      !this.active ||
      !this.bridgePort ||
      !ticket ||
      !this.documentHost.loaded ||
      ticket === this.adoptedTicket ||
      this.offeredTicket !== ""
    ) {
      return;
    }
    this.offeredTicket = ticket;
    const controlUiBaseUrl = this.options.controlUiBaseUrl?.trim();
    this.bridgePort.postMessage(
      {
        type: "openclaw:widget-host-init",
        ticket,
        ...(controlUiBaseUrl ? { controlUiBaseUrl } : {}),
      },
      [],
    );
  }

  private documentOptions(): ConstructorParameters<typeof WidgetSandboxHost>[0] {
    const options = this.options;
    return {
      frame: options.frame,
      sandboxOrigin: options.sandboxOrigin,
      sandboxUrl: options.sandboxUrl,
      documentKey: this.documentKey(),
      loadDocument: (signal) => this.fetchDocument(options, signal),
      onLoaded: () => {
        this.options.onLoaded();
        this.postHostInit();
      },
      onRendered: options.onRendered ? () => this.options.onRendered?.() : undefined,
      onError: (error) => {
        if (error instanceof WidgetRenderTimeoutError) {
          this.options.onError(error);
          return;
        }
        if (error instanceof WidgetDocumentError) {
          if (error.kind === "unauthorized") {
            this.options.onUnauthorized(this.options.widget);
          } else {
            this.options.onError(error);
          }
          return;
        }
        this.options.onLoadFailed(this.options.widget);
      },
      onReadyTimeout: () => {
        this.reset();
        this.options.onReadyTimeout();
      },
    };
  }

  private async fetchDocument(
    options: BoardWidgetSandboxHostOptions,
    signal: AbortSignal,
  ): Promise<string> {
    const { widget, resolveFrameUrl, sourceOrigin } = options;
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(resolveFrameUrl(widget.name, widget.revision), sourceOrigin);
    } catch (error) {
      throw new WidgetDocumentError("invalid-url", formatUiError(error));
    }
    if (sourceUrl.origin !== sourceOrigin) {
      throw new WidgetDocumentError(
        "invalid-url",
        "widget content URL is outside the active Gateway",
      );
    }
    options.onFrameUrl(sourceUrl.href);
    const response = await fetch(sourceUrl.href, { cache: "no-store", signal });
    if (response.status === 401) {
      throw new WidgetDocumentError("unauthorized", "widget content request failed (401)");
    }
    if (!response.ok) {
      throw new Error(`widget content request failed (${response.status})`);
    }
    return await response.text();
  }

  private postResponse(id: string, ok: boolean, result?: unknown, error?: string): void {
    this.bridgePort?.postMessage({
      type: "openclaw:widget-bridge-response",
      id,
      ok,
      ...(ok ? { result } : { error: error ?? "widget host request failed" }),
    });
  }
}
