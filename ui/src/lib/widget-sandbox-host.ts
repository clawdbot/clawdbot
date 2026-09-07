import { toStringifiedError } from "@openclaw/normalization-core";
import { generateUUID } from "./uuid.ts";

export const WIDGET_LOAD_TIMEOUT_MS = 10_000;
export class WidgetRenderTimeoutError extends Error {}

type WidgetSandboxHostOptions = {
  frame: HTMLIFrameElement;
  sandboxOrigin: string;
  sandboxUrl: string;
  documentKey: string;
  loadDocument: (signal: AbortSignal) => Promise<string>;
  onLoaded: () => void;
  onRendered?: () => void;
  onError: (error: unknown) => void;
  onReadyTimeout: () => void;
};

/** Fetches widget bytes alongside the isolated proxy, then joins their readiness. */
export class WidgetSandboxHost {
  private active = true;
  private proxyReady = false;
  private readyTimer: number | null = null;
  private loadedDocumentKey: string | null = null;
  private renderId: string | null = null;
  private pendingDocument: { key: string; html: string } | null = null;
  private activeLoad: { key: string; controller: AbortController; timeout: number } | null = null;

  constructor(private options: WidgetSandboxHostOptions) {
    // Owners finish installing their bridge before an immediate load can report back.
    queueMicrotask(() => this.start());
  }

  get frame(): HTMLIFrameElement {
    return this.options.frame;
  }

  get ready(): boolean {
    return this.proxyReady;
  }

  get loaded(): boolean {
    return this.loadedDocumentKey === this.options.documentKey;
  }

  update(options: WidgetSandboxHostOptions): void {
    const sandboxChanged =
      this.options.frame !== options.frame || this.options.sandboxUrl !== options.sandboxUrl;
    const documentChanged = this.options.documentKey !== options.documentKey;
    this.options = options;
    if (sandboxChanged || documentChanged) {
      this.reset();
    }
    if (sandboxChanged) {
      // Bytes may arrive early, but only the new proxy can enforce the new CSP.
      this.proxyReady = false;
      this.clearReadyTimeout();
    }
    this.start();
  }

  setActive(active: boolean): void {
    if (active === this.active) {
      return;
    }
    this.active = active;
    if (!active) {
      this.clearReadyTimeout();
      this.cancelLoad();
      return;
    }
    this.start();
  }

  reset(): void {
    this.cancelLoad();
    this.clearReadyTimeout();
    this.renderId = null;
    this.loadedDocumentKey = null;
    this.pendingDocument = null;
  }

  dispose(): void {
    this.active = false;
    this.clearReadyTimeout();
    this.reset();
    this.proxyReady = false;
  }

  handleMessage(event: MessageEvent): void {
    if (event.source !== this.frame.contentWindow || event.origin !== this.options.sandboxOrigin) {
      return;
    }
    if (event.data?.method === "ui/notifications/sandbox-resource-loaded") {
      if (this.renderId && event.data?.params?.renderId === this.renderId) {
        this.clearReadyTimeout();
        this.renderId = null;
        this.options.onRendered?.();
      }
      return;
    }
    if (
      event.data?.method !== "ui/notifications/sandbox-proxy-ready" ||
      event.data?.params?.sandboxUrl !== this.options.sandboxUrl
    ) {
      return;
    }
    // Readiness is one-shot, so retain it even while a mounted widget is hidden.
    this.proxyReady = true;
    this.clearReadyTimeout();
    this.start();
  }

  handleFrameError(): void {
    if (!this.active || this.proxyReady || !this.frame.isConnected) {
      return;
    }
    this.clearReadyTimeout();
    this.retrySandboxFrame();
  }

  private start(): void {
    if (!this.active || !this.frame.isConnected) {
      return;
    }
    this.scheduleReadyTimeout();
    this.deliverDocument();
    void this.loadDocument();
  }

  private clearReadyTimeout(): void {
    if (this.readyTimer !== null) {
      window.clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  private scheduleReadyTimeout(): void {
    if (
      (this.proxyReady && (!this.renderId || !this.options.onRendered)) ||
      this.readyTimer !== null
    ) {
      return;
    }
    this.readyTimer = window.setTimeout(() => {
      this.readyTimer = null;
      if (this.active && !this.proxyReady && this.frame.isConnected) {
        this.retrySandboxFrame();
      } else if (this.active && this.renderId && this.frame.isConnected) {
        this.options.onError(
          new WidgetRenderTimeoutError(
            "Widget content did not finish loading. Reload the dashboard to try again.",
          ),
        );
      }
    }, WIDGET_LOAD_TIMEOUT_MS);
  }

  private retrySandboxFrame(): void {
    this.proxyReady = false;
    this.reset();
    // A new ticket cannot recover an outer frame that never reached its script.
    this.frame.src = this.options.sandboxUrl;
    this.options.onReadyTimeout();
    this.start();
  }

  private cancelLoad(): void {
    const load = this.activeLoad;
    // Retire ownership before aborting: a stale rejection must not spend retries.
    this.activeLoad = null;
    if (load) {
      window.clearTimeout(load.timeout);
      load.controller.abort();
    }
  }

  private async loadDocument(): Promise<void> {
    const { documentKey, loadDocument } = this.options;
    if (
      this.loaded ||
      this.pendingDocument?.key === documentKey ||
      this.activeLoad?.key === documentKey ||
      !this.frame.contentWindow
    ) {
      return;
    }
    this.cancelLoad();
    const controller = new AbortController();
    const load = {
      key: documentKey,
      controller,
      timeout: window.setTimeout(
        () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
        WIDGET_LOAD_TIMEOUT_MS,
      ),
    };
    this.activeLoad = load;
    let rejectAborted!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () => reject(toStringifiedError(controller.signal.reason));
      controller.signal.addEventListener("abort", rejectAborted, { once: true });
    });
    try {
      const html = await Promise.race([loadDocument(controller.signal), aborted]);
      if (!this.active || this.activeLoad !== load || !this.frame.isConnected) {
        return;
      }
      this.pendingDocument = { key: documentKey, html };
      this.deliverDocument();
    } catch (error) {
      if (this.activeLoad === load && this.active && this.frame.isConnected) {
        this.options.onError(error);
      }
    } finally {
      window.clearTimeout(load.timeout);
      controller.signal.removeEventListener("abort", rejectAborted);
      if (this.activeLoad === load) {
        this.activeLoad = null;
      }
    }
  }

  private deliverDocument(): void {
    const document = this.pendingDocument;
    if (!this.active || !this.proxyReady || !document || !this.frame.isConnected) {
      return;
    }
    this.renderId = generateUUID();
    this.scheduleReadyTimeout();
    this.frame.contentWindow?.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/sandbox-resource-ready",
        params: { html: document.html, renderId: this.renderId },
      },
      this.options.sandboxOrigin,
    );
    this.pendingDocument = null;
    this.loadedDocumentKey = document.key;
    this.options.onLoaded();
  }
}
