import type { BoardViewWidget, BoardWidgetFrameUrl } from "./view-types.ts";
import {
  BoardWidgetBridgeController,
  type BoardWidgetBridgeGatewayClient,
  isBoardWidgetBridgeRequest,
} from "./widget-bridge.ts";

const SANDBOX_READY_TIMEOUT_MS = 10_000;

type BoardWidgetSandboxHostOptions = {
  frame: HTMLIFrameElement;
  widget: BoardViewWidget;
  sandboxOrigin: string;
  sandboxUrl: string;
  sourceOrigin: string;
  client?: BoardWidgetBridgeGatewayClient;
  resolveFrameUrl: BoardWidgetFrameUrl;
  confirmPrompt: (text: string) => boolean;
  onFrameUrl: (url: string) => void;
  onLoadFailed: (widget: BoardViewWidget) => void;
  onUnauthorized: (widget: BoardViewWidget) => void;
  onReadyTimeout: () => void;
  onLoaded: () => void;
  onError: (error: unknown) => void;
};

/** Owns one trusted outer sandbox frame and its ticket-bound inner widget bridge. */
export class BoardWidgetSandboxHost {
  private options: BoardWidgetSandboxHostOptions;
  private bridgeController: BoardWidgetBridgeController | null = null;
  private bridgeClient: BoardWidgetBridgeGatewayClient | undefined;
  private bridgePort: MessagePort | null = null;
  private adoptedTicket = "";
  private offeredTicket = "";
  private ready = false;
  private readyTimer: number | null = null;
  private loadedDocumentKey = "";
  private loadGeneration = 0;
  private requestGeneration = 0;
  private readonly pendingRequests = new Map<string, number>();

  constructor(options: BoardWidgetSandboxHostOptions) {
    this.options = options;
    this.scheduleReadyTimeout();
  }

  get frame(): HTMLIFrameElement {
    return this.options.frame;
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
    if (sandboxChanged) {
      // A CSP change navigates the outer proxy. Wait for that exact navigation
      // before sending bytes so they can never run under the prior policy.
      this.ready = false;
      this.scheduleReadyTimeout();
    }
    if (previousClient !== options.client) {
      // A reconnect can swap authenticated Gateway identity without changing
      // the widget document. Settle the wrapper promises without allowing a
      // result from the prior authenticated client to cross the new boundary.
      this.cancelPendingRequests("Gateway connection changed");
      this.requestGeneration += 1;
      this.bridgeController = null;
      this.bridgeClient = undefined;
    }
    if (options.widget.viewTicket && !documentChanged) {
      if (this.adoptedTicket) {
        this.bridgeController?.updateIdentity(options.frame, this.adoptedTicket);
      }
      this.postHostInit();
    }
    if (this.ready && this.documentKey() !== this.loadedDocumentKey) {
      void this.loadDocument();
    }
  }

  reset(): void {
    this.loadGeneration += 1;
    this.requestGeneration += 1;
    this.pendingRequests.clear();
    this.loadedDocumentKey = "";
    this.bridgePort?.close();
    this.bridgePort = null;
    this.adoptedTicket = "";
    this.offeredTicket = "";
  }

  dispose(): void {
    this.clearReadyTimeout();
    this.reset();
    this.ready = false;
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
    if (this.ready || !this.options.frame.isConnected) {
      return;
    }
    this.clearReadyTimeout();
    this.retrySandboxFrame();
  }

  handleMessage(event: MessageEvent): void {
    if (!this.accepts(event)) {
      return;
    }
    if (
      event.data?.method === "ui/notifications/sandbox-proxy-ready" &&
      event.data?.params?.sandboxUrl === this.options.sandboxUrl
    ) {
      this.ready = true;
      this.clearReadyTimeout();
      void this.loadDocument();
      return;
    }
    if (!this.ready) {
      return;
    }
    if (event.data?.type === "openclaw:widget-bridge-port-offer") {
      const port = event.ports[0];
      if (!port || this.bridgePort) {
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
    this.handleBridgeRequest(data);
  }

  private handleBridgeRequest(data: unknown): void {
    if (!this.ready || !isBoardWidgetBridgeRequest(data)) {
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
        this.completeRequest(
          data.id,
          generation,
          false,
          undefined,
          error instanceof Error ? error.message : String(error),
        );
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

  private clearReadyTimeout(): void {
    if (this.readyTimer !== null) {
      window.clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  private scheduleReadyTimeout(): void {
    if (this.ready || this.readyTimer !== null) {
      return;
    }
    this.readyTimer = window.setTimeout(() => {
      this.readyTimer = null;
      if (this.ready || !this.options.frame.isConnected) {
        return;
      }
      // Browsers do not expose iframe HTTP failures through `error`. Bound the
      // proxy handshake so an unavailable adjacent listener cannot stay blank.
      this.retrySandboxFrame();
    }, SANDBOX_READY_TIMEOUT_MS);
  }

  private retrySandboxFrame(): void {
    const { frame, sandboxUrl } = this.options;
    if (!frame.isConnected) {
      return;
    }
    this.ready = false;
    this.reset();
    // Assigning the current URL again starts a real navigation. Refreshing only
    // the ticket cannot recover an outer proxy load that never reached ready.
    frame.src = sandboxUrl;
    this.options.onReadyTimeout();
    this.scheduleReadyTimeout();
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
    return `${sourceIdentity}\0${this.options.widget.revision}\0${generation}`;
  }

  private postHostInit(): void {
    const ticket = this.options.widget.viewTicket;
    if (
      !this.ready ||
      !this.bridgePort ||
      !ticket ||
      this.loadedDocumentKey !== this.documentKey() ||
      ticket === this.adoptedTicket ||
      this.offeredTicket !== ""
    ) {
      return;
    }
    this.offeredTicket = ticket;
    this.bridgePort.postMessage({ type: "openclaw:widget-host-init", ticket }, []);
  }

  private async loadDocument(): Promise<void> {
    const { frame, widget, resolveFrameUrl } = this.options;
    if (!frame.contentWindow) {
      return;
    }
    const unresolvedSourceUrl = resolveFrameUrl(widget.name, widget.revision);
    let sourceUrl: URL;
    try {
      sourceUrl = new URL(unresolvedSourceUrl, this.options.sourceOrigin);
    } catch (error) {
      this.options.onError(error);
      return;
    }
    if (sourceUrl.origin !== this.options.sourceOrigin) {
      this.options.onError(new Error("widget content URL is outside the active Gateway"));
      return;
    }
    const sourceHref = sourceUrl.href;
    this.options.onFrameUrl(sourceHref);
    const generation = ++this.loadGeneration;
    try {
      const response = await fetch(sourceHref, { cache: "no-store" });
      if (generation !== this.loadGeneration || !frame.isConnected) {
        return;
      }
      if (response.status === 401) {
        this.options.onUnauthorized(widget);
        return;
      }
      if (!response.ok) {
        throw new Error(`widget content request failed (${response.status})`);
      }
      const documentHtml = await response.text();
      if (generation !== this.loadGeneration || !frame.isConnected) {
        return;
      }
      frame.contentWindow?.postMessage(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/sandbox-resource-ready",
          params: { html: documentHtml },
        },
        this.options.sandboxOrigin,
      );
      this.loadedDocumentKey = this.documentKey();
      this.options.onLoaded();
      // The wrapper may offer its private port while the source fetch is still
      // pending. Complete the handshake once these exact bytes become current.
      this.postHostInit();
    } catch {
      if (generation === this.loadGeneration) {
        this.options.onLoadFailed(widget);
      }
    }
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
