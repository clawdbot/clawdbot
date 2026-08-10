// Browser tests cover pw session.page cdp plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_REF_MARKER_ATTRIBUTE,
  markBackendDomRefsOnPage,
  readMainFrameDocumentIdentityForPage,
  withPageScopedCdpClient,
} from "./pw-session.page-cdp.js";

describe("pw-session page-scoped CDP client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses Playwright page sessions", async () => {
    const sessionSend = vi.fn(async () => ({ ok: true }));
    const sessionDetach = vi.fn(async () => {});
    const newCDPSession = vi.fn(async () => ({
      send: sessionSend,
      detach: sessionDetach,
    }));
    const page = {
      context: () => ({
        newCDPSession,
      }),
    };

    await withPageScopedCdpClient({
      cdpUrl: "http://127.0.0.1:9222",
      page: page as never,
      targetId: "tab-1",
      fn: async (pageSend) => {
        await pageSend("Emulation.setLocaleOverride", { locale: "en-US" });
      },
    });

    expect(newCDPSession).toHaveBeenCalledWith(page);
    expect(sessionSend).toHaveBeenCalledWith("Emulation.setLocaleOverride", { locale: "en-US" });
    expect(sessionDetach).toHaveBeenCalledTimes(1);
  });

  it("detaches the exact page session when its caller aborts", async () => {
    const controller = new AbortController();
    const abortError = new Error("doctor request cancelled");
    const sessionSend = vi.fn(() => new Promise<never>(() => {}));
    const sessionDetach = vi.fn(async () => {});
    const page = {
      context: () => ({
        newCDPSession: vi.fn(async () => ({ send: sessionSend, detach: sessionDetach })),
      }),
    };

    const pending = withPageScopedCdpClient({
      cdpUrl: "http://127.0.0.1:9222",
      page: page as never,
      targetId: "tab-1",
      signal: controller.signal,
      fn: async (send) => await send("Accessibility.getFullAXTree"),
    });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(sessionSend).toHaveBeenCalledOnce());

    controller.abort(abortError);

    await expect(pending).rejects.toBe(abortError);
    expect(sessionDetach).toHaveBeenCalledTimes(1);
  });

  it("aborts while page-session creation is pending and detaches a late session", async () => {
    const controller = new AbortController();
    const cancellation = new Error("doctor request cancelled during session creation");
    const sessionDetach = vi.fn(async () => {});
    let resolveSession!: (session: {
      send: ReturnType<typeof vi.fn>;
      detach: typeof sessionDetach;
    }) => void;
    const newCDPSession = vi.fn(
      () =>
        new Promise<{ send: ReturnType<typeof vi.fn>; detach: typeof sessionDetach }>((resolve) => {
          resolveSession = resolve;
        }),
    );
    const page = { context: () => ({ newCDPSession }) };
    const callback = vi.fn(async () => "unexpected");

    const pending = withPageScopedCdpClient({
      cdpUrl: "http://127.0.0.1:9222",
      page: page as never,
      targetId: "tab-1",
      signal: controller.signal,
      fn: callback,
    });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(newCDPSession).toHaveBeenCalledOnce());
    controller.abort(cancellation);

    try {
      await expect(
        Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error("session creation ignored cancellation")),
              300,
            );
            timer.unref?.();
          }),
        ]),
      ).rejects.toBe(cancellation);
    } finally {
      resolveSession({ send: vi.fn(), detach: sessionDetach });
    }

    await vi.waitFor(() => expect(sessionDetach).toHaveBeenCalledOnce());
    expect(callback).not.toHaveBeenCalled();
  });

  it("does not await a stalled detach before rejecting an aborted page operation", async () => {
    const controller = new AbortController();
    const cancellation = new Error("doctor request cancelled during page command");
    const sessionSend = vi.fn(() => new Promise<never>(() => {}));
    const sessionDetach = vi.fn(() => new Promise<void>(() => {}));
    const page = {
      context: () => ({
        newCDPSession: vi.fn(async () => ({ send: sessionSend, detach: sessionDetach })),
      }),
    };

    const pending = withPageScopedCdpClient({
      cdpUrl: "http://127.0.0.1:9222",
      page: page as never,
      targetId: "tab-1",
      signal: controller.signal,
      fn: async (send) => await send("Accessibility.getFullAXTree"),
    });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(sessionSend).toHaveBeenCalledOnce());
    controller.abort(cancellation);

    await expect(
      Promise.race([
        pending,
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("stalled detach blocked cancellation")),
            300,
          );
          timer.unref?.();
        }),
      ]),
    ).rejects.toBe(cancellation);
    expect(sessionDetach).toHaveBeenCalledOnce();
  });

  it("lets a detached session's precise command error win the abort fallback", async () => {
    const controller = new AbortController();
    const relayError = new Error(
      "extension relay page session detached: cdp (tabId=1, method=Accessibility.enable)",
    );
    let rejectSend!: (error: Error) => void;
    const sessionSend = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectSend = reject;
        }),
    );
    const sessionDetach = vi.fn(async () => {
      setImmediate(() => rejectSend(relayError));
    });
    const page = {
      context: () => ({
        newCDPSession: vi.fn(async () => ({ send: sessionSend, detach: sessionDetach })),
      }),
    };

    const pending = withPageScopedCdpClient({
      cdpUrl: "http://127.0.0.1:9222",
      page: page as never,
      targetId: "tab-1",
      signal: controller.signal,
      fn: async (send) => await send("Accessibility.enable"),
    });
    void pending.catch(() => {});
    await vi.waitFor(() => expect(sessionSend).toHaveBeenCalledOnce());

    controller.abort(new Error("deep doctor deadline"));

    await expect(pending).rejects.toBe(relayError);
    expect(sessionDetach).toHaveBeenCalledTimes(1);
  });

  it("reads the main-frame loader identity through the existing page session", async () => {
    const sessionSend = vi.fn(async (method: string) =>
      method === "Page.getFrameTree"
        ? { frameTree: { frame: { loaderId: "LOADER_SAME_URL" } } }
        : {},
    );
    const sessionDetach = vi.fn(async () => {});
    const page = {
      context: () => ({
        newCDPSession: vi.fn(async () => ({ send: sessionSend, detach: sessionDetach })),
      }),
    };

    await expect(readMainFrameDocumentIdentityForPage(page as never)).resolves.toBe(
      "cdp:LOADER_SAME_URL",
    );
    expect(sessionDetach).toHaveBeenCalledTimes(1);
  });

  it("marks backend DOM refs on the page", async () => {
    const sessionSend = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "DOM.pushNodesByBackendIdsToFrontend") {
        expect(params).toEqual({ backendNodeIds: [42, 84] });
        return { nodeIds: [101, 202] };
      }
      return {};
    });
    const sessionDetach = vi.fn(async () => {});
    const newCDPSession = vi.fn(async () => ({
      send: sessionSend,
      detach: sessionDetach,
    }));
    const evaluateAll = vi.fn(async () => {});
    const page = {
      context: () => ({
        newCDPSession,
      }),
      locator: vi.fn(() => ({ evaluateAll })),
    };

    const marked = await markBackendDomRefsOnPage({
      page: page as never,
      refs: [
        { ref: "ax1", backendDOMNodeId: 42 },
        { ref: "ax2", backendDOMNodeId: 84 },
      ],
    });

    expect(page.locator).toHaveBeenCalledWith(`[${BROWSER_REF_MARKER_ATTRIBUTE}]`);
    expect(evaluateAll).toHaveBeenCalledTimes(1);
    expect(sessionSend).toHaveBeenNthCalledWith(1, "DOM.enable", undefined);
    expect(sessionSend).toHaveBeenNthCalledWith(2, "DOM.pushNodesByBackendIdsToFrontend", {
      backendNodeIds: [42, 84],
    });
    expect(sessionSend).toHaveBeenNthCalledWith(3, "DOM.setAttributeValue", {
      nodeId: 101,
      name: BROWSER_REF_MARKER_ATTRIBUTE,
      value: "ax1",
    });
    expect(sessionSend).toHaveBeenNthCalledWith(4, "DOM.setAttributeValue", {
      nodeId: 202,
      name: BROWSER_REF_MARKER_ATTRIBUTE,
      value: "ax2",
    });
    expect(marked).toEqual(new Set(["ax1", "ax2"]));
    expect(sessionDetach).toHaveBeenCalledTimes(1);
  });

  it("clears stale markers even when no backend refs are valid", async () => {
    const newCDPSession = vi.fn();
    const evaluateAll = vi.fn(async () => {});
    const page = {
      context: () => ({
        newCDPSession,
      }),
      locator: vi.fn(() => ({ evaluateAll })),
    };

    const marked = await markBackendDomRefsOnPage({
      page: page as never,
      refs: [{ ref: "e1", backendDOMNodeId: 0 }],
    });

    expect(page.locator).toHaveBeenCalledWith(`[${BROWSER_REF_MARKER_ATTRIBUTE}]`);
    expect(evaluateAll).toHaveBeenCalledTimes(1);
    expect(newCDPSession).not.toHaveBeenCalled();
    expect(marked).toEqual(new Set());
  });

  it("keeps unmarked refs out of the marked set when marker writes fail", async () => {
    const sessionSend = vi.fn(async (method: string) => {
      if (method === "DOM.pushNodesByBackendIdsToFrontend") {
        return { nodeIds: [101, 202] };
      }
      if (method === "DOM.setAttributeValue") {
        throw new Error("detached");
      }
      return {};
    });
    const sessionDetach = vi.fn(async () => {});
    const page = {
      context: () => ({
        newCDPSession: vi.fn(async () => ({
          send: sessionSend,
          detach: sessionDetach,
        })),
      }),
      locator: vi.fn(() => ({ evaluateAll: vi.fn(async () => {}) })),
    };

    const marked = await markBackendDomRefsOnPage({
      page: page as never,
      refs: [
        { ref: "ax1", backendDOMNodeId: 42 },
        { ref: "ax2", backendDOMNodeId: 84 },
      ],
    });

    expect(marked).toEqual(new Set());
    expect(sessionDetach).toHaveBeenCalledTimes(1);
  });
});
