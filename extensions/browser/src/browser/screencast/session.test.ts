import { EventEmitter, getEventListeners } from "node:events";
import { expectDefined } from "@openclaw/normalization-core";
import type { Page } from "playwright-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { attachBrowserScreencastViewer, stopBrowserScreencasts } from "./session.js";
import { parseScreencastFrame, screencastParams, ScreencastViewer } from "./test-support.js";

const mocks = vi.hoisted(() => ({ getPage: vi.fn<() => Promise<Page>>() }));
vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: async () => ({ getPageForTargetId: mocks.getPage }),
}));

class FakeCdp extends EventEmitter {
  send = vi.fn(async (_method: string, _params?: unknown) => ({}));
  detach = vi.fn(async () => {
    this.emit("close", this);
  });

  paint(sessionId = 1, jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9])): void {
    this.emit("Page.screencastFrame", {
      sessionId,
      data: jpeg.toString("base64"),
      metadata: {
        deviceWidth: 800,
        deviceHeight: 600,
        scrollOffsetX: 12,
        scrollOffsetY: 34,
        timestamp: 123,
      },
    });
  }
}

class FakePage extends EventEmitter {
  cdps: FakeCdp[] = [];
  newCDPSession = vi.fn(async () => {
    const cdp = new FakeCdp();
    this.cdps.push(cdp);
    return cdp;
  });

  get cdp(): FakeCdp {
    const cdp = this.cdps.at(-1);
    if (!cdp) {
      throw new Error("No capture session attached");
    }
    return cdp;
  }

  currentUrl = "https://example.test/";
  currentTitle = "Example";
  frame = {};
  title = vi.fn(async () => this.currentTitle);
  url = () => this.currentUrl;
  mainFrame = () => this.frame;
  isClosed = () => false;
  context = () => ({ newCDPSession: this.newCDPSession });

  navigate(url: string): void {
    this.currentUrl = url;
    this.emit("framenavigated", this.frame);
  }

  paint(sessionId = 1): void {
    this.cdps.at(-1)?.paint(sessionId);
  }
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe("browser screencast sessions", () => {
  let page: FakePage;

  beforeEach(() => {
    vi.useFakeTimers();
    page = new FakePage();
    mocks.getPage.mockReset().mockResolvedValue(page as unknown as Page);
  });

  afterEach(async () => {
    await stopBrowserScreencasts();
    vi.useRealTimers();
  });

  async function attach(params = screencastParams()): Promise<ScreencastViewer> {
    const viewer = new ScreencastViewer();
    attachBrowserScreencastViewer(params, viewer as unknown as WebSocket);
    await flush();
    return viewer;
  }

  it("revokes only the requesting viewer and stops capture after the last requester leaves", async () => {
    const firstRequester = new AbortController();
    const secondRequester = new AbortController();
    const first = await attach(screencastParams({ requesterSignal: firstRequester.signal }));
    const second = await attach(screencastParams({ requesterSignal: secondRequester.signal }));
    page.paint(1);
    firstRequester.abort();
    expect(first.close).toHaveBeenCalledWith(4006, "authority_revoked");
    expect(second.close).not.toHaveBeenCalled();
    expect(getEventListeners(firstRequester.signal, "abort")).toHaveLength(0);
    page.paint(2);
    expect(first.frames()).toHaveLength(1);
    expect(second.frames()).toHaveLength(2);
    expect(page.cdp.detach).not.toHaveBeenCalled();
    secondRequester.abort();
    expect(second.close).toHaveBeenCalledWith(4006, "authority_revoked");
    await flush();
    expect(page.cdp.detach).toHaveBeenCalledOnce();
  });

  it("releases requester subscriptions when a viewer closes normally", async () => {
    const requester = new AbortController();
    const viewer = await attach(screencastParams({ requesterSignal: requester.signal }));
    expect(getEventListeners(requester.signal, "abort")).toHaveLength(1);
    viewer.close();
    expect(getEventListeners(requester.signal, "abort")).toHaveLength(0);
    requester.abort();
    expect(viewer.close).toHaveBeenCalledOnce();
  });

  it("fences frames immediately on requester invalidation before its close handshake finishes, preserving live viewers", async () => {
    const requester = { invalidated: false, signal: new AbortController().signal };
    const first = await attach(
      screencastParams({
        requesterSignal: requester.signal,
        isRequesterCurrent: () => !requester.invalidated,
      }),
    );
    const second = await attach(
      screencastParams({
        requesterSignal: new AbortController().signal,
        isRequesterCurrent: () => true,
      }),
    );
    page.paint(1);
    expect(first.frames()).toHaveLength(1);
    expect(second.frames()[0]).toBe(first.frames()[0]);
    requester.invalidated = true;
    page.paint(2);
    page.paint(3);
    expect(requester.signal.aborted).toBe(false);
    expect(first.frames()).toHaveLength(1);
    expect(first.close.mock.calls).toEqual([[4006, "authority_revoked"]]);
    expect(getEventListeners(requester.signal, "abort")).toHaveLength(0);
    expect(second.frames()).toHaveLength(3);
    expect(second.close).not.toHaveBeenCalled();
    expect(page.cdp.detach).not.toHaveBeenCalled();
  });

  it.each(["ready", "meta"])(
    "fences %s after requester invalidation during the awaited title read without a socket close",
    async (message) => {
      const requester = { invalidated: false, signal: new AbortController().signal };
      const params = screencastParams({
        requesterSignal: requester.signal,
        isRequesterCurrent: () => !requester.invalidated,
      });
      const viewer = new ScreencastViewer();
      if (message === "meta") {
        attachBrowserScreencastViewer(params, viewer as unknown as WebSocket);
        await flush();
        expect(viewer.messages()).toHaveLength(1);
        viewer.send.mockClear();
      }
      page.title.mockImplementationOnce(async () => {
        requester.invalidated = true;
        return "Revoked title";
      });
      if (message === "ready") {
        attachBrowserScreencastViewer(params, viewer as unknown as WebSocket);
      } else {
        page.emit("load");
      }
      await flush();
      expect(requester.signal.aborted).toBe(false);
      expect(viewer.send).not.toHaveBeenCalled();
      expect(viewer.close.mock.calls).toEqual([[4006, "authority_revoked"]]);
    },
  );

  it("rejects a requester revoked before viewer attachment without starting capture", async () => {
    const viewer = await attach(screencastParams({ requesterSignal: AbortSignal.abort() }));
    expect(viewer.close).toHaveBeenCalledWith(4006, "authority_revoked");
    expect(page.newCDPSession).not.toHaveBeenCalled();
  });

  it("shares one JPEG message across viewers, skips congestion, and ack-paces every frame", async () => {
    const first = await attach();
    const second = await attach();
    expect(mocks.getPage).toHaveBeenCalledTimes(1);
    expect(first.messages()).toEqual([
      { type: "ready", targetId: "target-1", url: "https://example.test/", title: "Example" },
    ]);
    expect(page.cdp.send).toHaveBeenCalledWith("Page.startScreencast", {
      format: "jpeg",
      quality: 70,
      maxWidth: 1280,
      maxHeight: 1280,
      everyNthFrame: 1,
    });
    page.paint(1);
    expect(first.frames()).toHaveLength(1);
    expect(first.frames()[0]).toBe(second.frames()[0]);
    expect(
      parseScreencastFrame(expectDefined(first.frames()[0], "first screencast frame")),
    ).toEqual({
      header: {
        url: "https://example.test/",
        cssWidth: 800,
        cssHeight: 600,
        scrollX: 12,
        scrollY: 34,
        ts: 123,
      },
      jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(
      page.cdp.send.mock.calls.filter(([method]) => method === "Page.screencastFrameAck"),
    ).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    second.bufferedAmount = 2 * 1024 * 1024;
    page.paint(2);
    await vi.advanceTimersByTimeAsync(50);
    first.bufferedAmount = 2 * 1024 * 1024;
    page.paint(3);
    await vi.advanceTimersByTimeAsync(50);
    expect(first.frames()).toHaveLength(2);
    expect(second.frames()).toHaveLength(1);
    expect(
      page.cdp.send.mock.calls.filter(([method]) => method === "Page.screencastFrameAck"),
    ).toEqual([
      ["Page.screencastFrameAck", { sessionId: 1 }],
      ["Page.screencastFrameAck", { sessionId: 2 }],
      ["Page.screencastFrameAck", { sessionId: 3 }],
    ]);
  });

  it("detaches without capturing or acking while policy is pending, and closes on rejection", async () => {
    let reject!: (error: Error) => void;
    const check = vi.fn(async (_url: string) => {});
    const viewer = await attach(screencastParams({ checkNavigationAllowed: check }));
    const retired = page.cdp;
    page.paint(9);
    viewer.send.mockClear();
    check.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    page.navigate("https://blocked.test/");
    expect(retired.detach).toHaveBeenCalledOnce();
    expect(page.newCDPSession).toHaveBeenCalledTimes(1);
    page.paint(10);
    await vi.advanceTimersByTimeAsync(50);
    expect(viewer.frames()).toHaveLength(0);
    expect(retired.send.mock.calls.map(([method]) => method)).toEqual(["Page.startScreencast"]);
    reject(new Error("blocked"));
    await flush();
    page.paint(11);
    expect(viewer.frames()).toHaveLength(0);
    expect(viewer.close).toHaveBeenCalledWith(4003, "navigation_blocked");
    expect(retired.detach).toHaveBeenCalledOnce();
  });

  it("never forwards delayed blocked-document pixels after a later allowed navigation", async () => {
    let rejectBlocked!: (error: Error) => void;
    let allowNext!: () => void;
    const check = vi.fn(async (_url: string) => {});
    const viewer = await attach(screencastParams({ checkNavigationAllowed: check }));
    const retired = page.cdp;
    page.paint(1);
    await vi.advanceTimersByTimeAsync(50);
    viewer.send.mockClear();
    retired.send.mockClear();
    check.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectBlocked = reject;
        }),
    );
    page.navigate("https://blocked.test/");
    expect.soft(retired.detach).toHaveBeenCalledOnce();
    expect(page.newCDPSession).toHaveBeenCalledTimes(1);
    retired.paint(10);
    await vi.advanceTimersByTimeAsync(50);
    expect(viewer.frames()).toEqual([]);
    expect.soft(retired.send).not.toHaveBeenCalled();

    check.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          allowNext = resolve;
        }),
    );
    page.navigate("https://example.test/next");
    rejectBlocked(new Error("blocked"));
    await flush();
    expect(viewer.close).not.toHaveBeenCalled();
    expect(page.newCDPSession).toHaveBeenCalledTimes(1);
    allowNext();
    await flush();
    expect.soft(page.newCDPSession).toHaveBeenCalledTimes(2);

    retired.paint(99, Buffer.from([0xff, 0xd8, 0x42, 0xff, 0xd9]));
    expect(viewer.frames().map(parseScreencastFrame)).toEqual([]);
    page.paint(100);
    await vi.advanceTimersByTimeAsync(50);
    expect(viewer.frames().map(parseScreencastFrame)).toEqual([
      {
        header: {
          url: "https://example.test/next",
          cssWidth: 800,
          cssHeight: 600,
          scrollX: 12,
          scrollY: 34,
          ts: 123,
        },
        jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      },
    ]);
    expect(
      page.cdp.send.mock.calls.filter(([method]) => method === "Page.screencastFrameAck"),
    ).toEqual([["Page.screencastFrameAck", { sessionId: 100 }]]);
    expect(viewer.close).not.toHaveBeenCalled();
  });

  it("checks the initial URL before ready or frames, and ignores stale navigation completions", async () => {
    let initial!: () => void;
    const check = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            initial = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const viewer = await attach(screencastParams({ checkNavigationAllowed: check }));
    expect(page.newCDPSession).not.toHaveBeenCalled();
    page.paint();
    expect(viewer.send).not.toHaveBeenCalled();
    page.currentTitle = "Next";
    page.navigate("https://example.test/next");
    await flush();
    initial();
    await flush();
    page.paint(2);
    expect(viewer.messages()).toEqual([
      { type: "ready", targetId: "target-1", url: "https://example.test/next", title: "Next" },
    ]);
    expect(
      parseScreencastFrame(expectDefined(viewer.frames()[0], "approved document frame")).header.url,
    ).toBe("https://example.test/next");
    page.currentTitle = "Loaded";
    page.emit("load");
    await flush();
    expect(viewer.messages().at(-1)).toEqual({
      type: "meta",
      url: "https://example.test/next",
      title: "Loaded",
    });
  });

  it("does not leak a changed URL before Playwright's navigation event", async () => {
    let allowed!: () => void;
    const check = vi.fn(async (_url: string) => {});
    const viewer = await attach(screencastParams({ checkNavigationAllowed: check }));
    const retired = page.cdp;
    check.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          allowed = resolve;
        }),
    );
    page.currentUrl = "https://example.test/next";
    page.paint();
    expect(viewer.frames()).toHaveLength(0);
    expect(retired.detach).toHaveBeenCalledOnce();
    expect(page.newCDPSession).toHaveBeenCalledTimes(1);
    allowed();
    await flush();
    page.paint(2);
    expect(viewer.frames()).toHaveLength(1);
  });

  it.each(["page", "cdp", "lifecycle"])(
    "closes viewers with target_closed when %s closes",
    async (owner) => {
      const lifecycle = new AbortController();
      const viewer = await attach(screencastParams({ lifecycleSignal: lifecycle.signal }));
      if (owner === "lifecycle") {
        lifecycle.abort();
      } else if (owner === "page") {
        page.emit("close");
      } else {
        page.cdp.emit("close", page.cdp);
      }
      expect(viewer.close).toHaveBeenCalledWith(4004, "target_closed");
      await flush();
      expect(page.cdp.detach).toHaveBeenCalledTimes(1);
    },
  );

  it("stops only after the last viewer leaves and closes all viewers with 1012 on shutdown", async () => {
    const first = await attach();
    const second = await attach();
    first.close();
    await flush();
    expect(page.cdp.detach).not.toHaveBeenCalled();
    second.close();
    await flush();
    expect(page.cdp.detach).toHaveBeenCalledTimes(1);
    const next = await attach();
    const stopped = stopBrowserScreencasts();
    expect(next.close).toHaveBeenCalledWith(1012, "gateway shutting down");
    await stopped;
  });

  it("revalidates lifecycle after page acquisition and never attaches a stale token to a successor", async () => {
    let resolvePage!: (page: Page) => void;
    mocks.getPage.mockImplementationOnce(
      () =>
        new Promise<Page>((resolve) => {
          resolvePage = resolve;
        }),
    );
    const lifecycle = new AbortController();
    const params = screencastParams({ lifecycleSignal: lifecycle.signal });
    const pending = await attach(params);
    lifecycle.abort();
    resolvePage(page as unknown as Page);
    await flush();
    expect(pending.close).toHaveBeenCalledWith(4004, "target_closed");
    expect(page.newCDPSession).not.toHaveBeenCalled();
    const successor = await attach(screencastParams({ lifecycleGeneration: 1 }));
    const stale = await attach(params);
    expect(stale.close).toHaveBeenCalledWith(4004, "target_closed");
    expect(successor.close).not.toHaveBeenCalled();
  });

  it("waits for predecessor teardown before starting a replacement on the same target", async () => {
    const first = await attach();
    let finishDetach!: () => void;
    page.cdp.detach.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        finishDetach = resolve;
      });
    });
    first.close();
    await flush();
    const successor = await attach();
    expect(mocks.getPage).toHaveBeenCalledTimes(1);
    expect(successor.send).not.toHaveBeenCalled();
    finishDetach();
    await flush();
    expect(mocks.getPage).toHaveBeenCalledTimes(2);
    expect(successor.messages()).toHaveLength(1);
  });

  it("does not send stale metadata after a title read crosses a navigation", async () => {
    const viewer = await attach();
    let finishTitle!: (title: string) => void;
    page.title.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishTitle = resolve;
        }),
    );
    page.emit("load");
    page.currentTitle = "Next";
    page.navigate("https://example.test/next");
    await flush();
    finishTitle("Old title");
    await flush();
    expect(viewer.messages()).toEqual([
      { type: "ready", targetId: "target-1", url: "https://example.test/", title: "Example" },
      { type: "meta", url: "https://example.test/next", title: "Next" },
    ]);
  });
});
