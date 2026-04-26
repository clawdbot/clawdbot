import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../test-support/browser-security-runtime.mock.js";
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

function expectChromeLiveProfile() {
  return expect.objectContaining({
    name: "chrome-live",
    driver: "existing-session",
    userDataDir: "/tmp/brave-profile",
  });
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
    expect(profiles).toEqual([
      expect.objectContaining({
        name: "chrome-live",
        transport: "chrome-mcp",
        running: true,
        tabCount: 0,
      }),
    ]);

    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenCalledWith(
      "chrome-live",
      expectChromeLiveProfile(),
      { ephemeral: true, timeoutMs: 300 },
    );
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenCalledWith(
      "chrome-live",
      expectChromeLiveProfile(),
      {
        ephemeral: true,
      },
    );
  });

  it("keeps the next real attach on the normal sticky session path after an idle status probe", async () => {
    fs.mkdirSync("/tmp/brave-profile", { recursive: true });
    const state = makeState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    const live = ctx.forProfile("chrome-live");

    vi.mocked(chromeMcp.listChromeMcpTabs).mockRejectedValueOnce(new Error("No page selected"));

    await expect(ctx.listProfiles()).resolves.toEqual([
      expect.objectContaining({
        name: "chrome-live",
        running: true,
        tabCount: 0,
      }),
    ]);

    vi.mocked(chromeMcp.listChromeMcpTabs).mockClear();

    await live.ensureBrowserAvailable();
    const tabs = await live.listTabs();

    expect(tabs.map((tab) => tab.targetId)).toEqual(["7"]);
    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenLastCalledWith(
      "chrome-live",
      expectChromeLiveProfile(),
    );
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenNthCalledWith(
      1,
      "chrome-live",
      expectChromeLiveProfile(),
    );
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenNthCalledWith(
      2,
      "chrome-live",
      expectChromeLiveProfile(),
    );
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

    expect(chromeMcp.ensureChromeMcpAvailable).toHaveBeenCalledWith(
      "chrome-live",
      expectChromeLiveProfile(),
    );
    expect(chromeMcp.listChromeMcpTabs).toHaveBeenCalledWith(
      "chrome-live",
      expectChromeLiveProfile(),
    );
    expect(chromeMcp.openChromeMcpTab).toHaveBeenCalledWith(
      "chrome-live",
      "about:blank",
      expectChromeLiveProfile(),
    );
    expect(chromeMcp.focusChromeMcpTab).toHaveBeenCalledWith(
      "chrome-live",
      "7",
      expectChromeLiveProfile(),
    );
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
