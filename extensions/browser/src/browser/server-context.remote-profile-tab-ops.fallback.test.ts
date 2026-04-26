import { describe, expect, it, vi } from "vitest";
import { withBrowserFetchPreconnect } from "../../test-fetch.js";
import {
  installRemoteProfileTestLifecycle,
  loadRemoteProfileTestDeps,
  type RemoteProfileTestDeps,
} from "./server-context.remote-profile-tab-ops.test-helpers.js";

const deps: RemoteProfileTestDeps = await loadRemoteProfileTestDeps();
installRemoteProfileTestLifecycle(deps);

describe("browser remote profile fallback and attachOnly behavior", () => {
  it("uses profile-level attachOnly when global attachOnly is false", async () => {
    const state = deps.makeState("openclaw");
    state.resolved.attachOnly = false;
    state.resolved.profiles.openclaw = {
      cdpPort: 18800,
      attachOnly: true,
      color: "#FF4500",
    };

    const reachableMock = vi
      .mocked(deps.chromeModule.isChromeReachable)
      .mockResolvedValueOnce(false);
    const launchMock = vi.mocked(deps.chromeModule.launchOpenClawChrome);
    const ctx = deps.createBrowserRouteContext({ getState: () => state });

    await expect(ctx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
      /attachOnly is enabled/i,
    );
    expect(reachableMock).toHaveBeenCalled();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("keeps attachOnly websocket failures off the loopback ownership error path", async () => {
    const state = deps.makeState("openclaw");
    state.resolved.attachOnly = false;
    state.resolved.profiles.openclaw = {
      cdpPort: 18800,
      attachOnly: true,
      color: "#FF4500",
    };

    const httpReachableMock = vi
      .mocked(deps.chromeModule.isChromeReachable)
      .mockResolvedValueOnce(true);
    const wsReachableMock = vi
      .mocked(deps.chromeModule.isChromeCdpReady)
      .mockResolvedValueOnce(false);
    const launchMock = vi.mocked(deps.chromeModule.launchOpenClawChrome);
    const ctx = deps.createBrowserRouteContext({ getState: () => state });

    await expect(ctx.forProfile("openclaw").ensureBrowserAvailable()).rejects.toThrow(
      /attachOnly is enabled and CDP websocket/i,
    );
    expect(httpReachableMock).toHaveBeenCalled();
    expect(wsReachableMock).toHaveBeenCalled();
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("falls back to /json/list when Playwright is not available", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue(null);
    const { remote } = deps.createRemoteRouteHarness(
      vi.fn(
        deps.createJsonListFetchMock([
          {
            id: "T1",
            title: "Tab 1",
            url: "https://example.com",
            webSocketDebuggerUrl: "wss://browserless.example/devtools/page/T1",
            type: "page",
          },
        ]),
      ),
    );

    const tabs = await remote.listTabs();
    expect(tabs.map((t) => t.targetId)).toEqual(["T1"]);
  });

  it("fails closed for remote tab opens in strict mode without Playwright", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue(null);
    const { state, remote, fetchMock } = deps.createRemoteRouteHarness();
    state.resolved.ssrfPolicy = { dangerouslyAllowPrivateNetwork: false };

    await expect(remote.openTab("https://example.com")).rejects.toBeInstanceOf(
      deps.InvalidBrowserNavigationUrlError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not enforce managed tab cap for remote openclaw profiles", async () => {
    const listPagesViaPlaywright = vi
      .fn()
      .mockResolvedValueOnce([
        { targetId: "T1", title: "1", url: "https://1.example", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "T1", title: "1", url: "https://1.example", type: "page" },
        { targetId: "T2", title: "2", url: "https://2.example", type: "page" },
        { targetId: "T3", title: "3", url: "https://3.example", type: "page" },
        { targetId: "T4", title: "4", url: "https://4.example", type: "page" },
        { targetId: "T5", title: "5", url: "https://5.example", type: "page" },
        { targetId: "T6", title: "6", url: "https://6.example", type: "page" },
        { targetId: "T7", title: "7", url: "https://7.example", type: "page" },
        { targetId: "T8", title: "8", url: "https://8.example", type: "page" },
        { targetId: "T9", title: "9", url: "https://9.example", type: "page" },
      ]);

    const createPageViaPlaywright = vi.fn(async () => ({
      targetId: "T1",
      title: "Tab 1",
      url: "https://1.example",
      type: "page",
    }));

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      createPageViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const fetchMock = vi.fn(async (url: unknown) => {
      throw new Error(`unexpected fetch: ${String(url)}`);
    });

    const { remote } = deps.createRemoteRouteHarness(fetchMock);
    const opened = await remote.openTab("https://1.example");
    expect(opened.targetId).toBe("T1");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes configured remote CDP timeouts when opening tabs through raw CDP", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue(null);
    const createTargetViaCdp = vi
      .spyOn(deps.cdpModule, "createTargetViaCdp")
      .mockResolvedValue({ targetId: "T_REMOTE" });
    const { state, remote } = deps.createRemoteRouteHarness(
      vi.fn(
        deps.createJsonListFetchMock([
          {
            id: "T_REMOTE",
            title: "Remote Tab",
            url: "https://example.com",
            webSocketDebuggerUrl: "wss://browserless.example/devtools/page/T_REMOTE",
            type: "page",
          },
        ]),
      ),
    );
    state.resolved.remoteCdpTimeoutMs = 4321;
    state.resolved.remoteCdpHandshakeTimeoutMs = 8765;

    const opened = await remote.openTab("https://example.com");

    expect(opened.targetId).toBe("T_REMOTE");
    expect(createTargetViaCdp).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: "https://1.1.1.1:9222/chrome?token=abc",
        url: "https://example.com",
        timeouts: {
          httpTimeoutMs: 4321,
          handshakeTimeoutMs: 8765,
        },
      }),
    );
  });

  it("uses remote-class tab-open timeouts for attachOnly loopback CDP profiles", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue(null);
    const createTargetViaCdp = vi
      .spyOn(deps.cdpModule, "createTargetViaCdp")
      .mockResolvedValue({ targetId: "T_ATTACH" });
    const state = deps.makeState("openclaw");
    state.resolved.remoteCdpTimeoutMs = 2345;
    state.resolved.remoteCdpHandshakeTimeoutMs = 6789;
    state.resolved.profiles.openclaw = {
      cdpPort: 18800,
      attachOnly: true,
      color: "#FF4500",
    };
    const fetchMock = vi.fn(
      deps.createJsonListFetchMock([
        {
          id: "T_ATTACH",
          title: "Attach Tab",
          url: "https://example.com",
          webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/page/T_ATTACH",
          type: "page",
        },
      ]),
    );
    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const ctx = deps.createBrowserRouteContext({ getState: () => state });

    const opened = await ctx.forProfile("openclaw").openTab("https://example.com");

    expect(opened.targetId).toBe("T_ATTACH");
    expect(createTargetViaCdp).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: "http://127.0.0.1:18800",
        timeouts: {
          httpTimeoutMs: 2345,
          handshakeTimeoutMs: 6789,
        },
      }),
    );
  });

  it("keeps managed loopback tab opens on local CDP defaults", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue(null);
    const createTargetViaCdp = vi
      .spyOn(deps.cdpModule, "createTargetViaCdp")
      .mockResolvedValue({ targetId: "T_LOCAL" });
    const state = deps.makeState("openclaw");
    const fetchMock = vi.fn(
      deps.createJsonListFetchMock([
        {
          id: "T_LOCAL",
          title: "Local Tab",
          url: "http://127.0.0.1:3000",
          webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/page/T_LOCAL",
          type: "page",
        },
      ]),
    );
    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const ctx = deps.createBrowserRouteContext({ getState: () => state });

    await ctx.forProfile("openclaw").openTab("http://127.0.0.1:3000");

    expect(createTargetViaCdp).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      url: "http://127.0.0.1:3000",
      ssrfPolicy: undefined,
    });
  });

  it("uses the remote HTTP timeout for /json/new fallback tab opens", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue(null);
    vi.spyOn(deps.cdpModule, "createTargetViaCdp").mockRejectedValue(
      new Error("Target.createTarget unavailable"),
    );
    const fetchMock = vi.fn(async (...args: unknown[]) => {
      const url = String(args[0]);
      if (url.includes("/json/new")) {
        const init = args[1] as RequestInit | undefined;
        expect(init?.method).toBe("PUT");
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("aborted after remote timeout")),
            { once: true },
          );
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const { state, remote } = deps.createRemoteRouteHarness(fetchMock);
    state.resolved.remoteCdpTimeoutMs = 25;

    const startedAt = Date.now();
    await expect(remote.openTab("https://example.com")).rejects.toThrow(
      /aborted after remote timeout/,
    );

    expect(Date.now() - startedAt).toBeLessThan(700);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/json/new"),
      expect.objectContaining({
        method: "PUT",
        signal: expect.any(AbortSignal),
      }),
    );
  });
});
