// Browser tests cover server context.existing session plugin behavior.
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import type { BrowserServerState } from "./server-context.js";

const chromeMcpMock = vi.hoisted(() => ({
  closeChromeMcpSession: vi.fn(async () => true),
  countChromeMcpTabs: vi.fn(async () => 1),
  ensureChromeMcpAvailable: vi.fn(async () => {}),
  focusChromeMcpTab: vi.fn(async () => {}),
  listChromeMcpTabs: vi.fn(async () => [
    { targetId: "7", title: "", url: "https://example.com", type: "page" },
  ]),
  openChromeMcpTab: vi.fn(async () => ({
    targetId: "8",
    title: "",
    url: "about:blank",
    type: "page",
  })),
  closeChromeMcpTab: vi.fn(async () => {}),
  getChromeMcpPid: vi.fn(() => 4321),
}));

vi.mock("./chrome-mcp.js", () => chromeMcpMock);

vi.mock("./chrome-mcp.runtime.js", () => ({
  getChromeMcpModule: vi.fn(async () => chromeMcpMock),
}));

const { createBrowserRouteContext } = await import("./server-context.js");
const chromeMcp = chromeMcpMock;

type ChromeLiveProfile = {
  driver?: string;
  name?: string;
  cdpUrl?: string;
  userDataDir?: string;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeState(): BrowserServerState {
  return {
    server: null,
    port: 0,
    resolved: {
      enabled: true,
      evaluateEnabled: true,
      controlPort: 18791,
      cdpPortRangeStart: 18800,
      cdpPortRangeEnd: 18899,
      extensionRelayDefaultPort: 18799,
      extensionRelayPorts: {},
      cdpProtocol: "http",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      localLaunchTimeoutMs: 15_000,
      localCdpReadyTimeoutMs: 8_000,
      actionTimeoutMs: 60_000,
      color: "#FF4500",
      headless: false,
      noSandbox: false,
      attachOnly: false,
      defaultProfile: "chrome-live",
      tabCleanup: {
        enabled: true,
        idleMinutes: 120,
        maxTabsPerSession: 8,
        sweepMinutes: 5,
      },
      profiles: {
        "chrome-live": {
          cdpPort: 18801,
          color: "#0066CC",
          driver: "existing-session",
          attachOnly: true,
          userDataDir: "/tmp/brave-profile",
        },
      },
      extraArgs: [],
      ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
    },
    profiles: new Map(),
  };
}

beforeEach(() => {
  for (const key of [
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
  ]) {
    vi.stubEnv(key, "");
  }
  vi.mocked(chromeMcp.listChromeMcpTabs)
    .mockReset()
    .mockResolvedValue([{ targetId: "7", title: "", url: "https://example.com", type: "page" }]);
  vi.mocked(chromeMcp.countChromeMcpTabs).mockReset().mockResolvedValue(1);
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("browser server-context existing-session profile", () => {
  it("reports attach-only profiles as running when the MCP session is available but no page is selected", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });

    vi.mocked(chromeMcp.ensureChromeMcpAvailable).mockResolvedValueOnce();
    vi.mocked(chromeMcp.countChromeMcpTabs).mockRejectedValueOnce(new Error("No page selected"));

    const profiles = await ctx.listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.name).toBe("chrome-live");
    expect(profiles[0]?.transport).toBe("chrome-mcp");
    expect(profiles[0]?.running).toBe(true);
    expect(profiles[0]?.tabCount).toBe(0);

    const [, ensuredProfile, ensureOptions] =
      (
        vi.mocked(chromeMcp.ensureChromeMcpAvailable).mock.calls as unknown as Array<
          [string, ChromeLiveProfile, { ephemeral?: boolean; timeoutMs?: number }]
        >
      )[0] ?? [];
    expect(ensuredProfile?.name).toBe("chrome-live");
    expect(ensuredProfile?.driver).toBe("existing-session");
    expect(ensuredProfile?.userDataDir).toBe("/tmp/brave-profile");
    expect(ensureOptions).toEqual({
      ephemeral: true,
      timeoutMs: 300,
      signal: expect.any(AbortSignal),
    });
    const [, countedProfile, countOptions] =
      (
        vi.mocked(chromeMcp.countChromeMcpTabs).mock.calls as unknown as Array<
          [string, ChromeLiveProfile, { ephemeral?: boolean }]
        >
      )[0] ?? [];
    expect(countedProfile?.name).toBe("chrome-live");
    expect(countedProfile?.driver).toBe("existing-session");
    expect(countedProfile?.userDataDir).toBe("/tmp/brave-profile");
    expect(countOptions).toEqual({ ephemeral: true, signal: expect.any(AbortSignal) });
  });

  it("reports endpoint cdpUrl for existing-session profiles", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    state.resolved.profiles["chrome-live"] = {
      ...state.resolved.profiles["chrome-live"],
      cdpUrl: "http://openclaw:relay-token@127.0.0.1:9222",
    };
    const ctx = createBrowserRouteContext({ getState: () => state });

    const profiles = await ctx.listProfiles();

    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.transport).toBe("chrome-mcp");
    expect(profiles[0]?.cdpPort).toBeNull();
    expect(profiles[0]?.cdpUrl).toBe("http://127.0.0.1:9222");
    const [, ensuredProfile] =
      (
        vi.mocked(chromeMcp.ensureChromeMcpAvailable).mock.calls as unknown as Array<
          [string, ChromeLiveProfile, { ephemeral?: boolean; timeoutMs?: number }]
        >
      )[0] ?? [];
    expect(ensuredProfile?.cdpUrl).toBe("http://openclaw:relay-token@127.0.0.1:9222");
  });

  it("keeps the next real attach on the normal sticky session path after an idle status probe", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    vi.mocked(chromeMcp.countChromeMcpTabs).mockRejectedValueOnce(new Error("No page selected"));

    const profiles = await ctx.listProfiles();
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.name).toBe("chrome-live");
    expect(profiles[0]?.running).toBe(true);
    expect(profiles[0]?.tabCount).toBe(0);

    vi.mocked(chromeMcp.listChromeMcpTabs).mockClear();

    await live.ensureBrowserAvailable();
    const tabs = await live.listTabs();

    expect(tabs.map((tab) => tab.targetId)).toEqual(["7"]);
    const ensureCalls = vi.mocked(chromeMcp.ensureChromeMcpAvailable).mock
      .calls as unknown as Array<[string, ChromeLiveProfile]>;
    const lastEnsureCall = ensureCalls.at(-1);
    expect(lastEnsureCall?.[0]).toBe("chrome-live");
    expect(lastEnsureCall?.[1]?.name).toBe("chrome-live");
    expect(lastEnsureCall?.[1]?.driver).toBe("existing-session");
    expect(lastEnsureCall?.[1]?.userDataDir).toBe("/tmp/brave-profile");
    const listCalls = vi.mocked(chromeMcp.listChromeMcpTabs).mock.calls as unknown as Array<
      [string, ChromeLiveProfile]
    >;
    expect(listCalls[0]?.[0]).toBe("chrome-live");
    expect(listCalls[0]?.[1]?.name).toBe("chrome-live");
    expect(listCalls[0]?.[1]?.driver).toBe("existing-session");
    expect(listCalls[0]?.[1]?.userDataDir).toBe("/tmp/brave-profile");
    expect(listCalls[1]?.[0]).toBe("chrome-live");
    expect(listCalls[1]?.[1]?.name).toBe("chrome-live");
    expect(listCalls[1]?.[1]?.driver).toBe("existing-session");
    expect(listCalls[1]?.[1]?.userDataDir).toBe("/tmp/brave-profile");
  });

  it("routes tab operations through the Chrome MCP backend", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    vi.mocked(chromeMcp.listChromeMcpTabs)
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
        { targetId: "8", title: "", url: "about:blank", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
        { targetId: "8", title: "", url: "about:blank", type: "page" },
      ])
      .mockResolvedValueOnce([
        { targetId: "7", title: "", url: "https://example.com", type: "page" },
        { targetId: "8", title: "", url: "about:blank", type: "page" },
      ]);

    await live.ensureBrowserAvailable();
    const tabs = await live.listTabs();
    expect(tabs.map((tab) => tab.targetId)).toEqual(["7"]);

    const opened = await live.openTab("about:blank");
    expect(opened.targetId).toBe("8");

    const selected = await live.ensureTabAvailable();
    expect(selected.targetId).toBe("8");

    await live.focusTab("7");
    await live.stopRunningBrowser();

    const [ensureCall] = vi.mocked(chromeMcp.ensureChromeMcpAvailable).mock
      .calls as unknown as Array<[string, ChromeLiveProfile]>;
    expect(ensureCall?.[0]).toBe("chrome-live");
    expect(ensureCall?.[1]?.name).toBe("chrome-live");
    expect(ensureCall?.[1]?.driver).toBe("existing-session");
    const [listCall] = vi.mocked(chromeMcp.listChromeMcpTabs).mock.calls as unknown as Array<
      [string, ChromeLiveProfile]
    >;
    expect(listCall?.[0]).toBe("chrome-live");
    expect(listCall?.[1]?.name).toBe("chrome-live");
    expect(listCall?.[1]?.driver).toBe("existing-session");
    const [openCall] = vi.mocked(chromeMcp.openChromeMcpTab).mock.calls as unknown as Array<
      [string, string, ChromeLiveProfile]
    >;
    expect(openCall?.[0]).toBe("chrome-live");
    expect(openCall?.[1]).toBe("about:blank");
    expect(openCall?.[2]?.name).toBe("chrome-live");
    expect(openCall?.[2]?.driver).toBe("existing-session");
    const [focusCall] = vi.mocked(chromeMcp.focusChromeMcpTab).mock.calls as unknown as Array<
      [string, string, ChromeLiveProfile]
    >;
    expect(focusCall?.[0]).toBe("chrome-live");
    expect(focusCall?.[1]).toBe("7");
    expect(focusCall?.[2]?.name).toBe("chrome-live");
    expect(focusCall?.[2]?.driver).toBe("existing-session");
    expect(chromeMcp.closeChromeMcpSession).toHaveBeenCalledWith("chrome-live");
  });

  it("eagerly closes MCP while attach readiness is pending and prevents retry", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const readinessEntered = deferred<void>();
    const readiness = deferred<never>();
    vi.mocked(chromeMcp.listChromeMcpTabs).mockImplementationOnce(async () => {
      readinessEntered.resolve();
      return await readiness.promise;
    });
    let mcpSessionCached = true;
    const closeResults: boolean[] = [];
    vi.mocked(chromeMcp.closeChromeMcpSession)
      .mockReset()
      .mockImplementation(async () => {
        const closed = mcpSessionCached;
        mcpSessionCached = false;
        closeResults.push(closed);
        return closed;
      });
    const state = makeState();
    const live = createBrowserRouteContext({ getState: () => state }).forProfile("chrome-live");

    const starting = live.ensureBrowserAvailable();
    await readinessEntered.promise;
    const stopping = live.stopRunningBrowser();
    await vi.waitFor(() => expect(chromeMcp.closeChromeMcpSession).toHaveBeenCalledTimes(1));
    readiness.reject(new Error("attach not ready"));

    await expect(starting).rejects.toThrow(/lifecycle changed|superseded/i);
    await expect(stopping).resolves.toEqual({ stopped: true });
    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenCalledTimes(1);
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenCalledTimes(1);
    expect(chromeMcp.closeChromeMcpSession).toHaveBeenCalledTimes(2);
    expect(chromeMcp.closeChromeMcpSession).toHaveBeenNthCalledWith(1, "chrome-live");
    expect(chromeMcp.closeChromeMcpSession).toHaveBeenNthCalledWith(2, "chrome-live");
    expect(closeResults).toEqual([true, false]);
    expect(mcpSessionCached).toBe(false);
  });

  it("drains an admitted MCP tab open before the final session sweep", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const openEntered = deferred<void>();
    const opened = deferred<{
      targetId: string;
      title: string;
      url: string;
      type: "page";
    }>();
    vi.mocked(chromeMcp.openChromeMcpTab).mockImplementationOnce(async () => {
      openEntered.resolve();
      return await opened.promise;
    });
    let mcpSessionCached = true;
    const closeResults: boolean[] = [];
    vi.mocked(chromeMcp.closeChromeMcpSession)
      .mockReset()
      .mockImplementation(async () => {
        const closed = mcpSessionCached;
        mcpSessionCached = false;
        closeResults.push(closed);
        return closed;
      });
    const state = makeState();
    const live = createBrowserRouteContext({ getState: () => state }).forProfile("chrome-live");

    const opening = live.openTab("about:blank");
    await openEntered.promise;
    const stopping = live.stopRunningBrowser();
    await vi.waitFor(() => expect(chromeMcp.closeChromeMcpSession).toHaveBeenCalledTimes(1));
    opened.resolve({ targetId: "late", title: "", url: "about:blank", type: "page" });

    await expect(opening).rejects.toThrow(/lifecycle changed|superseded/i);
    await expect(stopping).resolves.toEqual({ stopped: true });
    expect(chromeMcp.openChromeMcpTab).toHaveBeenCalledTimes(1);
    expect(chromeMcp.closeChromeMcpSession).toHaveBeenCalledTimes(2);
    expect(chromeMcp.closeChromeMcpSession).toHaveBeenNthCalledWith(1, "chrome-live");
    expect(chromeMcp.closeChromeMcpSession).toHaveBeenNthCalledWith(2, "chrome-live");
    expect(closeResults).toEqual([true, false]);
    expect(mcpSessionCached).toBe(false);
  });

  it("expires Chrome MCP aliases instead of transferring them to a replacement tab", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const originalTab = {
      targetId: "TARGET-A",
      title: "Checkout",
      url: "https://shop.example/checkout",
      type: "page" as const,
    };
    const replacementTab = { ...originalTab, targetId: "TARGET-B" };
    let currentTabs = [originalTab];
    vi.mocked(chromeMcp.listChromeMcpTabs).mockImplementation(async () => currentTabs);
    const state = makeState();
    const live = createBrowserRouteContext({ getState: () => state }).forProfile("chrome-live");

    await expect(live.listTabs()).resolves.toEqual([
      expect.objectContaining({ targetId: "TARGET-A", tabId: "t1" }),
    ]);
    await live.labelTab("t1", "checkout");
    await live.ensureTabAvailable("t1");

    currentTabs = [replacementTab];
    await expect(live.listTabs()).resolves.toEqual([
      expect.objectContaining({
        targetId: "TARGET-B",
        tabId: "t2",
        suggestedTargetId: "t2",
      }),
    ]);
    await expect(live.ensureTabAvailable()).rejects.toThrow(/tab not found/i);
    await expect(live.ensureTabAvailable("t1")).rejects.toThrow(/tab not found/i);
    await expect(live.ensureTabAvailable("checkout")).rejects.toThrow(/tab not found/i);
    await expect(live.ensureTabAvailable("TARGET-B")).resolves.toEqual(
      expect.objectContaining({ targetId: "TARGET-B", tabId: "t2" }),
    );
  });

  it("allows targetless selection when a fresh Chrome MCP profile has no stale identity", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const freshTab = {
      targetId: "chrome-mcp:fresh:1",
      title: "Fresh",
      url: "https://example.com",
      type: "page" as const,
    };
    vi.mocked(chromeMcp.listChromeMcpTabs).mockResolvedValue([freshTab]);
    const state = makeState();
    const live = createBrowserRouteContext({ getState: () => state }).forProfile("chrome-live");

    await expect(live.ensureTabAvailable()).resolves.toEqual(
      expect.objectContaining({ targetId: "chrome-mcp:fresh:1", tabId: "t1" }),
    );
    expect(state.profiles.get("chrome-live")?.lastTargetId).toBe("chrome-mcp:fresh:1");
  });

  it("clears only the sticky Chrome MCP target after a successful close", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const tabA = {
      targetId: "chrome-mcp:fresh:1",
      title: "A",
      url: "https://a.example",
      type: "page" as const,
    };
    const tabB = {
      targetId: "chrome-mcp:fresh:2",
      title: "B",
      url: "https://b.example",
      type: "page" as const,
    };
    let currentTabs = [tabA, tabB];
    vi.mocked(chromeMcp.listChromeMcpTabs).mockImplementation(async () => currentTabs);
    const state = makeState();
    const live = createBrowserRouteContext({ getState: () => state }).forProfile("chrome-live");

    await live.ensureTabAvailable(tabA.targetId);
    await live.closeTab(tabA.targetId);
    expect(chromeMcp.closeChromeMcpTab).toHaveBeenNthCalledWith(
      1,
      "chrome-live",
      tabA.targetId,
      expect.objectContaining({ driver: "existing-session" }),
      { signal: expect.any(AbortSignal) },
    );
    currentTabs = [tabB];
    await expect(live.ensureTabAvailable()).resolves.toEqual(
      expect.objectContaining({ targetId: tabB.targetId }),
    );

    currentTabs = [tabA, tabB];
    await live.ensureTabAvailable(tabA.targetId);
    await live.closeTab(tabB.targetId);
    expect(chromeMcp.closeChromeMcpTab).toHaveBeenNthCalledWith(
      2,
      "chrome-live",
      tabB.targetId,
      expect.objectContaining({ driver: "existing-session" }),
      { signal: expect.any(AbortSignal) },
    );
    currentTabs = [tabA];
    await expect(live.ensureTabAvailable()).resolves.toEqual(
      expect.objectContaining({ targetId: tabA.targetId }),
    );
  });

  it("keeps the sticky Chrome MCP target when close fails", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const tab = {
      targetId: "chrome-mcp:fresh:1",
      title: "A",
      url: "https://a.example",
      type: "page" as const,
    };
    vi.mocked(chromeMcp.listChromeMcpTabs).mockResolvedValue([tab]);
    vi.mocked(chromeMcp.closeChromeMcpTab).mockRejectedValueOnce(new Error("close failed"));
    const state = makeState();
    const live = createBrowserRouteContext({ getState: () => state }).forProfile("chrome-live");

    await live.ensureTabAvailable(tab.targetId);
    await expect(live.closeTab(tab.targetId)).rejects.toThrow(/close failed/);

    expect(state.profiles.get("chrome-live")?.lastTargetId).toBe(tab.targetId);
    await expect(live.ensureTabAvailable()).resolves.toEqual(
      expect.objectContaining({ targetId: tab.targetId }),
    );
  });

  it("surfaces DevToolsActivePort attach failures instead of a generic tab timeout", async () => {
    vi.useFakeTimers();
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    vi.mocked(chromeMcp.listChromeMcpTabs).mockRejectedValue(
      new Error(
        "Could not connect to Chrome. Check if Chrome is running. Cause: Could not find DevToolsActivePort for chrome at /tmp/brave-profile/DevToolsActivePort",
      ),
    );

    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    const pending = live.ensureBrowserAvailable();
    const assertion = expect(pending).rejects.toThrow(
      /could not connect to Chrome.*managed "openclaw" profile.*DevToolsActivePort/s,
    );
    await vi.advanceTimersByTimeAsync(8_000);
    await assertion;
  });
});
