import type { CDPSession, Frame, Page } from "playwright-core";
import type { WebSocket } from "ws";
import { getPwAiModule } from "../pw-ai-module.js";
import { clearBrowserScreencastTokens, type BrowserScreencastTokenParams } from "./tokens.js";
import { encodeBrowserScreencastFrame } from "./wire.js";

const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
const FRAME_INTERVAL_MS = 50;
const sessions = new Map<string, BrowserScreencastSession>();

type ScreencastFrame = Parameters<typeof encodeBrowserScreencastFrame>[1] & { sessionId: number };
type ViewerRequester = { signal?: AbortSignal; isCurrent?: () => boolean };

class BrowserScreencastSession {
  readonly viewers = new Map<WebSocket, ViewerRequester>();
  private readonly readyViewers = new Set<WebSocket>();
  private readonly acknowledgements = new Set<ReturnType<typeof setTimeout>>();
  private page?: Page;
  private cdp?: CDPSession;
  private frameListener?: (frame: ScreencastFrame) => void;
  private captureDrain: Promise<void> = Promise.resolve();
  closed = false;
  private navigationEpoch = 0;
  private checkedUrl?: string;
  private metadata?: { url: string; title: string };
  private stopPromise?: Promise<void>;

  constructor(
    readonly key: string,
    readonly params: BrowserScreencastTokenParams,
  ) {
    params.lifecycleSignal.addEventListener("abort", this.onTargetClosed, { once: true });
  }

  addViewer(ws: WebSocket, requester: ViewerRequester): void {
    const onRequesterGone = () => ws.close(4006, "authority_revoked");
    this.viewers.set(ws, requester);
    ws.once("close", () => {
      requester.signal?.removeEventListener("abort", onRequesterGone);
      this.viewers.delete(ws);
      this.readyViewers.delete(ws);
      if (this.viewers.size === 0) {
        void this.close();
      }
    });
    requester.signal?.addEventListener("abort", onRequesterGone, { once: true });
    if (!this.isViewerCurrent(ws)) {
      return;
    }
    this.sendReady();
  }

  private isViewerCurrent(ws: WebSocket): boolean {
    const requester = this.viewers.get(ws);
    if (!requester) {
      return false;
    }
    if (requester.signal?.aborted || requester.isCurrent?.() === false) {
      ws.close(4006, "authority_revoked");
      return false;
    }
    return true;
  }

  private isCurrent(): boolean {
    if (this.closed) {
      return false;
    }
    try {
      this.params.lifecycleSignal.throwIfAborted();
      this.params.assertCurrent();
      return true;
    } catch {
      this.onTargetClosed();
      return false;
    }
  }

  async start(): Promise<void> {
    try {
      if (!this.isCurrent()) {
        return;
      }
      const pw = await getPwAiModule();
      if (!this.isCurrent()) {
        return;
      }
      if (!pw) {
        await this.close(4005, "unsupported");
        return;
      }
      const page = await pw.getPageForTargetId({
        cdpUrl: this.params.cdpUrl,
        targetId: this.params.targetId,
        ssrfPolicy: this.params.ssrfPolicy,
      });
      if (!this.isCurrent() || page.isClosed()) {
        this.onTargetClosed();
        return;
      }
      this.page = page;
      page.on("close", this.onTargetClosed);
      page.on("framenavigated", this.onNavigation);
      page.on("load", this.onLoad);
      await this.checkNavigation(page.url());
    } catch {
      await this.close(4004, "target_closed");
    }
  }

  private readonly onTargetClosed = (): void => {
    void this.close(4004, "target_closed");
  };

  private readonly onCdpClosed = (cdp: CDPSession): void => {
    if (this.cdp === cdp) {
      this.onTargetClosed();
    }
  };

  private readonly onNavigation = (frame: Frame): void => {
    if (frame === this.page?.mainFrame()) {
      void this.checkNavigation(this.page.url());
    }
  };

  private readonly onLoad = (): void => {
    void this.updateMetadata(this.navigationEpoch);
  };

  private async checkNavigation(url: string): Promise<void> {
    const retired = this.retireCapture();
    const epoch = this.navigationEpoch;
    try {
      await this.params.checkNavigationAllowed(url);
    } catch {
      if (epoch === this.navigationEpoch) {
        void this.close(4003, "navigation_blocked");
      }
      return;
    }
    const page = this.page;
    const current = () => this.isCurrent() && epoch === this.navigationEpoch && page?.url() === url;
    if (!page || !current()) {
      return;
    }
    try {
      await retired;
      if (!current()) {
        return;
      }
      const cdp = await page.context().newCDPSession(page);
      if (!current()) {
        await cdp.detach().catch(() => {});
        return;
      }
      this.cdp = cdp;
      this.frameListener = (frame) => this.onFrame(cdp, frame);
      cdp.on("close", this.onCdpClosed);
      cdp.on("Page.screencastFrame", this.frameListener);
      this.checkedUrl = url;
      await this.updateMetadata(epoch);
      if (!current() || this.cdp !== cdp) {
        return;
      }
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: this.params.quality,
        maxWidth: this.params.maxWidth,
        maxHeight: this.params.maxHeight,
        everyNthFrame: 1,
      });
    } catch {
      if (current()) {
        this.onTargetClosed();
      }
    }
  }

  private async updateMetadata(epoch: number): Promise<void> {
    const page = this.page;
    const url = this.checkedUrl;
    if (!page || url === undefined || page.url() !== url) {
      return;
    }
    const title = await page.title().catch(() => "");
    if (!this.isCurrent() || epoch !== this.navigationEpoch || this.checkedUrl !== page.url()) {
      return;
    }
    this.metadata = { url, title };
    for (const ws of this.readyViewers) {
      this.send(ws, JSON.stringify({ type: "meta", ...this.metadata }));
    }
    this.sendReady();
  }

  private sendReady(): void {
    if (
      !this.isCurrent() ||
      !this.metadata ||
      this.metadata.url !== this.checkedUrl ||
      this.page?.url() !== this.checkedUrl
    ) {
      return;
    }
    for (const ws of this.viewers.keys()) {
      if (
        !this.readyViewers.has(ws) &&
        this.send(
          ws,
          JSON.stringify({ type: "ready", targetId: this.params.targetId, ...this.metadata }),
        )
      ) {
        this.readyViewers.add(ws);
      }
    }
  }

  private send(ws: WebSocket, data: string | Buffer): boolean {
    if (!this.isViewerCurrent(ws) || ws.readyState !== 1) {
      return false;
    }
    if (typeof data !== "string" && ws.bufferedAmount >= MAX_BUFFERED_BYTES) {
      return false;
    }
    try {
      ws.send(data, (error) => {
        if (error) {
          ws.terminate();
        }
      });
      return true;
    } catch {
      ws.terminate();
      return false;
    }
  }

  private onFrame(cdp: CDPSession, frame: ScreencastFrame): void {
    const page = this.page;
    if (this.cdp !== cdp || !page || !this.isCurrent()) {
      return;
    }
    const url = this.checkedUrl;
    const pageUrl = page.url();
    if (pageUrl !== url) {
      void this.checkNavigation(pageUrl);
      return;
    }
    if (url === undefined) {
      return;
    }
    // Chrome retains one unacked frame; delayed acks bound work without a frame queue.
    const timer = setTimeout(() => {
      this.acknowledgements.delete(timer);
      if (this.cdp !== cdp || !this.isCurrent()) {
        return;
      }
      void cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {
        if (this.cdp === cdp) {
          this.onTargetClosed();
        }
      });
    }, FRAME_INTERVAL_MS);
    timer.unref();
    this.acknowledgements.add(timer);
    const wire = encodeBrowserScreencastFrame(url, frame);
    for (const ws of this.readyViewers) {
      this.send(ws, wire);
    }
  }

  close(code?: number, reason?: string): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.closed = true;
    this.params.lifecycleSignal.removeEventListener("abort", this.onTargetClosed);
    this.page?.off("close", this.onTargetClosed);
    this.page?.off("framenavigated", this.onNavigation);
    this.page?.off("load", this.onLoad);
    const viewers = [...this.viewers.keys()];
    this.viewers.clear();
    this.readyViewers.clear();
    // Publish the drain before closing sockets; their close callbacks may reenter.
    this.stopPromise = this.retireCapture().finally(() => {
      if (sessions.get(this.key) === this) {
        sessions.delete(this.key);
      }
    });
    for (const ws of viewers) {
      ws.close(code, reason);
    }
    return this.stopPromise;
  }

  private retireCapture(): Promise<void> {
    // Encoded frames belong to a CDP session, so revoke it before navigation checks yield.
    this.checkedUrl = undefined;
    this.navigationEpoch += 1;
    const cdp = this.cdp;
    this.cdp = undefined;
    for (const timer of this.acknowledgements) {
      clearTimeout(timer);
    }
    this.acknowledgements.clear();
    if (cdp) {
      cdp.off("close", this.onCdpClosed);
      if (this.frameListener) {
        cdp.off("Page.screencastFrame", this.frameListener);
      }
      this.captureDrain = Promise.all([this.captureDrain, cdp.detach().catch(() => {})]).then(
        () => {},
      );
    }
    this.frameListener = undefined;
    return this.captureDrain;
  }
}

export function attachBrowserScreencastViewer(
  params: BrowserScreencastTokenParams,
  ws: WebSocket,
): void {
  if (params.requesterSignal?.aborted || params.isRequesterCurrent?.() === false) {
    ws.close(4006, "authority_revoked");
    return;
  }
  try {
    params.lifecycleSignal.throwIfAborted();
    params.assertCurrent();
  } catch {
    ws.close(4004, "target_closed");
    return;
  }
  const key = `${params.profileName}:${params.targetId}`;
  const requester = { signal: params.requesterSignal, isCurrent: params.isRequesterCurrent };
  let session = sessions.get(key);
  let previousDrain: Promise<void> | undefined;
  if (
    session &&
    (session.closed || session.params.lifecycleGeneration !== params.lifecycleGeneration)
  ) {
    previousDrain = session.close(4004, "target_closed");
    session = undefined;
  }
  if (session) {
    session.addViewer(ws, requester);
    return;
  }
  session = new BrowserScreencastSession(key, params);
  sessions.set(key, session);
  session.addViewer(ws, requester);
  const next = session;
  // Finish retiring the predecessor before attaching a replacement to the same page.
  void Promise.resolve(previousDrain).then(() => next.start());
}

export function stopBrowserScreencasts(): Promise<void> {
  clearBrowserScreencastTokens();
  const drains = [...sessions.values()].map((session) =>
    session.close(1012, "gateway shutting down"),
  );
  return Promise.allSettled(drains).then(() => {});
}
