import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-support/browser-security.mock.js";
import type { BrowserServerState } from "./server-context.js";

const chromeMcpMock = vi.hoisted(() => ({
  closeChromeMcpSession: vi.fn(async () => true),
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
  userDataDir?: string;
};

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
    vi.mocked(chromeMcp.listChromeMcpTabs).mockRejectedValueOnce(new Error("No page selected"));

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
    expect(ensureOptions).toEqual({ ephemeral: true, timeoutMs: 300 });
    const [, listedProfile, listOptions] =
      (
        vi.mocked(chromeMcp.listChromeMcpTabs).mock.calls as unknown as Array<
          [string, ChromeLiveProfile, { ephemeral?: boolean }]
        >
      )[0] ?? [];
    expect(listedProfile?.name).toBe("chrome-live");
    expect(listedProfile?.driver).toBe("existing-session");
    expect(listedProfile?.userDataDir).toBe("/tmp/brave-profile");
    expect(listOptions).toEqual({ ephemeral: true });
  });

  it("keeps the next real attach on the normal sticky session path after an idle status probe", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    vi.mocked(chromeMcp.listChromeMcpTabs).mockRejectedValueOnce(new Error("No page selected"));

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
