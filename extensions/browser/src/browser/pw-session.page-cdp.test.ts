import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_REF_MARKER_ATTRIBUTE,
  markBackendDomRefsOnPage,
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
