import { afterEach, describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../../test-support.js";
import * as cdpModule from "./cdp.js";
import { BrowserCdpEndpointBlockedError } from "./errors.js";
import { createBrowserRouteContext } from "./server-context.js";
import { makeState, originalFetch } from "./server-context.remote-tab-ops.harness.js";

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("browser server-context loopback direct WebSocket profiles", () => {
  it("uses an HTTP /json/list base when opening about:blank under strict SSRF", async () => {
    const createTargetViaCdp = vi
      .spyOn(cdpModule, "createTargetViaCdp")
      .mockResolvedValue({ targetId: "CREATED" });

    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      expect(u).toBe("http://127.0.0.1:18800/json/list?token=abc");
      return {
        ok: true,
        json: async () => [
          {
            id: "CREATED",
            title: "New Tab",
            url: "about:blank",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/CREATED",
            type: "page",
          },
        ],
      } as unknown as Response;
    });

    global.fetch = withFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    state.resolved.ssrfPolicy = {};
    state.resolved.profiles.openclaw = {
      cdpUrl: "ws://127.0.0.1:18800/devtools/browser/SESSION?token=abc",
      color: "#FF4500",
    };
    const ctx = createBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const opened = await openclaw.openTab("about:blank");
    expect(opened.targetId).toBe("CREATED");
    expect(createTargetViaCdp).toHaveBeenCalledWith({
      cdpUrl: "ws://127.0.0.1:18800/devtools/browser/SESSION?token=abc",
      url: "about:blank",
      ssrfPolicy: undefined,
    });
  });

  it("uses an HTTP /json base for focus and close under strict SSRF", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u === "http://127.0.0.1:18800/json/list?token=abc") {
        return {
          ok: true,
          json: async () => [
            {
              id: "T1",
              title: "Tab 1",
              url: "https://example.com",
              webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/T1",
              type: "page",
            },
          ],
        } as unknown as Response;
      }
      if (u === "http://127.0.0.1:18800/json/activate/T1?token=abc") {
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      if (u === "http://127.0.0.1:18800/json/close/T1?token=abc") {
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    global.fetch = withFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    state.resolved.ssrfPolicy = {};
    state.resolved.profiles.openclaw = {
      cdpUrl: "ws://127.0.0.1:18800/devtools/browser/SESSION?token=abc",
      color: "#FF4500",
    };
    const ctx = createBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    await openclaw.focusTab("T1");
    await openclaw.closeTab("T1");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18800/json/activate/T1?token=abc",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:18800/json/close/T1?token=abc",
      expect.any(Object),
    );
  });

  it("uses an HTTPS /json base for secure direct WebSocket profiles with a /cdp suffix", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u === "https://127.0.0.1:18800/json/list?token=abc") {
        return {
          ok: true,
          json: async () => [
            {
              id: "T2",
              title: "Secure Tab",
              url: "https://example.com",
              webSocketDebuggerUrl: "wss://127.0.0.1/devtools/page/T2",
              type: "page",
            },
          ],
        } as unknown as Response;
      }
      if (u === "https://127.0.0.1:18800/json/activate/T2?token=abc") {
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      if (u === "https://127.0.0.1:18800/json/close/T2?token=abc") {
        return { ok: true, json: async () => ({}) } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${u}`);
    });

    global.fetch = withFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    state.resolved.profiles.openclaw = {
      cdpUrl: "wss://127.0.0.1:18800/cdp?token=abc",
      color: "#FF4500",
    };
    const ctx = createBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const tabs = await openclaw.listTabs();
    expect(tabs.map((tab) => tab.targetId)).toEqual(["T2"]);

    await openclaw.focusTab("T2");
    await openclaw.closeTab("T2");
  });

  it("blocks direct WebSocket tab operations when strict SSRF policy rejects the cdpUrl", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });

    global.fetch = withFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    state.resolved.ssrfPolicy = { dangerouslyAllowPrivateNetwork: false };
    state.resolved.profiles.openclaw = {
      cdpUrl: "ws://10.0.0.42:18800/devtools/browser/SESSION?token=abc",
      color: "#FF4500",
    };
    const ctx = createBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    await expect(openclaw.listTabs()).rejects.toBeInstanceOf(BrowserCdpEndpointBlockedError);
    await expect(openclaw.focusTab("T1")).rejects.toBeInstanceOf(BrowserCdpEndpointBlockedError);
    await expect(openclaw.closeTab("T1")).rejects.toBeInstanceOf(BrowserCdpEndpointBlockedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
