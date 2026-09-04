import { consume } from "@lit/context";
import type { CanvasDocumentViewResult } from "@openclaw/gateway-protocol";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { t } from "../i18n/index.ts";
import { getCanvasWidgetFrameConnectionGeneration } from "../lib/chat/canvas-widget-frame-generation.ts";
import { formatUiError } from "../lib/format-error.ts";
import { WidgetSandboxHost, WIDGET_LOAD_TIMEOUT_MS } from "../lib/widget-sandbox-host.ts";
import { registerWidgetThemeFrame, postWidgetTheme } from "../lib/widget-theme.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import { dispatchWidgetPrompt } from "./mcp-app-security.ts";
import { resolveSandboxHostUrl } from "./sandbox-host.ts";

type WidgetClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;
type ViewBinding = { client: WidgetClient; generation: number; docId: string };
const pendingViews = new WeakMap<
  WidgetClient,
  {
    generation: number;
    requests: Map<string, Promise<CanvasDocumentViewResult>>;
  }
>();

function loadCanvasView(binding: ViewBinding): Promise<CanvasDocumentViewResult> {
  let pending = pendingViews.get(binding.client);
  if (!pending || pending.generation !== binding.generation) {
    pending = { generation: binding.generation, requests: new Map() };
    pendingViews.set(binding.client, pending);
  }
  const existing = pending.requests.get(binding.docId);
  if (existing) {
    return existing;
  }
  const request = binding.client.request<CanvasDocumentViewResult>(
    "canvas.document.view",
    { docId: binding.docId },
    { timeoutMs: WIDGET_LOAD_TIMEOUT_MS },
  );
  // Canvas also supports replacing a named document. Share concurrent reads,
  // but only the mounted view retains bytes; a remount revalidates the source.
  if (pending.requests.size < 32) {
    const requests = pending.requests;
    requests.set(binding.docId, request);
    void request.finally(() => requests.delete(binding.docId)).catch(() => {});
  }
  return request;
}

export class OpenClawCanvasWidgetView extends OpenClawLightDomContentsElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property() docId = "";
  @property() sessionKey = "";
  @property() override title = "";
  @property({ type: Number }) preferredHeight?: number;
  @property({ type: Number }) connectionGeneration = 0;
  @state() private view?: CanvasDocumentViewResult;
  @state() private error = "";
  @state() private contentHeight?: number;
  private binding?: ViewBinding;
  private sandboxHost?: WidgetSandboxHost;
  private promptPort?: MessagePort;
  private sandboxOrigin = "";
  private releaseTheme?: () => void;

  get documentHtml(): string | undefined {
    return this.isCurrent(this.binding) ? this.view?.html : undefined;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("message", this.handleMessage);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("message", this.handleMessage);
    this.clearView();
    super.disconnectedCallback();
  }

  private clearView(): void {
    this.binding = undefined;
    this.view = undefined;
    this.sandboxHost?.dispose();
    this.sandboxHost = undefined;
    this.promptPort?.close();
    this.promptPort = undefined;
    this.releaseTheme?.();
    this.releaseTheme = undefined;
    this.contentHeight = undefined;
  }

  private isCurrent(binding: ViewBinding | undefined): binding is ViewBinding {
    return Boolean(
      binding &&
      this.isConnected &&
      this.binding === binding &&
      binding.client === this.context?.gateway.snapshot.client &&
      binding.docId === this.docId &&
      binding.generation === getCanvasWidgetFrameConnectionGeneration(),
    );
  }

  override willUpdate(): void {
    const client = this.context?.gateway.snapshot.client;
    if (!client || !this.docId) {
      this.clearView();
      return;
    }
    if (
      this.binding?.client === client &&
      this.binding.docId === this.docId &&
      this.binding.generation === this.connectionGeneration
    ) {
      return;
    }
    this.clearView();
    this.error = "";
    const binding = { client, docId: this.docId, generation: this.connectionGeneration };
    this.binding = binding;
    void loadCanvasView(binding)
      .then((view) => {
        if (this.isCurrent(binding)) {
          this.view = view;
        }
      })
      .catch((error: unknown) => {
        if (this.isCurrent(binding)) {
          this.error = formatUiError(error);
        }
      });
  }

  override updated(): void {
    const frame = this.querySelector<HTMLIFrameElement>("iframe");
    const view = this.view;
    const binding = this.binding;
    if (!frame || !view || !this.isCurrent(binding) || this.sandboxHost) {
      return;
    }
    this.releaseTheme = registerWidgetThemeFrame(frame, this.sandboxOrigin);
    this.sandboxHost = new WidgetSandboxHost({
      frame,
      sandboxOrigin: this.sandboxOrigin,
      sandboxUrl: frame.src,
      documentKey: `${binding.docId}\0${binding.generation}`,
      loadDocument: async () => view.html,
      onLoaded: () => this.postHostState(),
      onError: (error) => this.fail(error),
      onReadyTimeout: () => this.fail(new Error(t("board.widget.sandboxUnavailable"))),
    });
  }

  private fail(error: unknown): void {
    this.sandboxHost?.dispose();
    this.promptPort?.close();
    this.promptPort = undefined;
    this.releaseTheme?.();
    this.releaseTheme = undefined;
    this.error = formatUiError(error);
  }

  private postHostState(): void {
    const frame = this.sandboxHost?.frame;
    if (!frame) {
      return;
    }
    postWidgetTheme(frame, this.sandboxOrigin);
    frame.contentWindow?.postMessage({ type: "openclaw:widget-chat-host" }, this.sandboxOrigin);
  }

  private readonly handleMessage = (event: MessageEvent): void => {
    const host = this.sandboxHost;
    const binding = this.binding;
    if (
      !host ||
      !this.isCurrent(binding) ||
      event.source !== host.frame.contentWindow ||
      event.origin !== this.sandboxOrigin
    ) {
      return;
    }
    host.handleMessage(event);
    const data = asOptionalRecord(event.data);
    if (
      data?.type === "openclaw:widget-size" &&
      typeof data.height === "number" &&
      Number.isFinite(data.height) &&
      data.height > 0
    ) {
      this.contentHeight = Math.min(8000, Math.max(48, Math.trunc(data.height)));
    }
    if (data?.type === "openclaw:widget-bridge-ready") {
      this.postHostState();
    }
    if (data?.type !== "openclaw:widget-prompt-offer") {
      if (data?.type === "openclaw:widget-bridge-port-offer") {
        event.ports[0]?.close();
      }
      return;
    }
    const port = event.ports[0];
    if (!port || this.promptPort || !host.loaded) {
      port?.close();
      return;
    }
    // The isolated proxy forwards only the wrapper's first offer. Inline views
    // adopt its prompt channel only; pinning never lends them dashboard grants.
    this.promptPort = port;
    port.addEventListener("message", (message: MessageEvent) => {
      if (
        this.isCurrent(binding) &&
        this.promptPort === port &&
        message.data?.type === "openclaw:widget-prompt"
      ) {
        dispatchWidgetPrompt(
          host.frame,
          message.data.prompt,
          `${this.sessionKey}\0${binding.docId}\0${binding.generation}`,
        );
      }
    });
    port.start();
    port.postMessage({ type: "openclaw:widget-prompt-host-ready" });
  };

  override render() {
    if (this.error) {
      return html`<div class="board-widget__error" role="alert">
        ${this.error}
        <button
          class="btn btn--small"
          @click=${() => {
            this.clearView();
            this.requestUpdate();
          }}
        >
          ${t("common.retry")}
        </button>
      </div>`;
    }
    if (!this.view || !this.context) {
      return html`<div role="status" style=${`min-height:${this.preferredHeight ?? 420}px`}>
        ${t("common.loading")}
      </div>`;
    }
    let src: string;
    try {
      src = resolveSandboxHostUrl(
        this.view.sandboxUrl,
        this.view.sandboxPort,
        this.view.sandboxOrigin,
        this.context.gateway.connection.gatewayUrl,
        window.location.origin,
      );
      this.sandboxOrigin = new URL(src).origin;
    } catch (error) {
      return html`<div role="alert">${formatUiError(error)}</div>`;
    }
    const height = this.contentHeight ?? this.preferredHeight;
    return html`<iframe
      class="chat-tool-card__preview-frame"
      title=${this.title}
      src=${src}
      sandbox="allow-scripts allow-same-origin allow-forms"
      referrerpolicy="origin"
      style=${height ? `height:${height}px;min-height:${height}px` : nothing}
      @error=${() => this.sandboxHost?.handleFrameError()}
    ></iframe>`;
  }
}

if (!customElements.get("openclaw-canvas-widget-view")) {
  customElements.define("openclaw-canvas-widget-view", OpenClawCanvasWidgetView);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-canvas-widget-view": OpenClawCanvasWidgetView;
  }
}
