// Browser tests cover server context.list profiles plugin behavior.
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import "./server-context.chrome-test-harness.js";
import {
  listChromeMcpTabs,
  resetChromeMcpSessionsForTest,
  setChromeMcpProcessCleanupDepsForTest,
  setChromeMcpSessionFactoryForTest,
} from "./chrome-mcp.js";
import * as chromeModule from "./chrome.js";
import { registerBrowserBasicRoutes } from "./routes/basic.js";
import { createBrowserRouteApp, createBrowserRouteResponse } from "./routes/test-helpers.js";
import { createBrowserRouteContext } from "./server-context.js";
import { beginProfileTransition } from "./server-context.lifecycle.js";
import { makeBrowserProfile, makeBrowserServerState } from "./server-context.test-harness.js";

afterEach(async () => {
  await resetChromeMcpSessionsForTest();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

function createExistingSessionProcessFixture(
  profileCount = 1,
  pageFailure = false,
  options: { attachElapsedMs?: number; hangingPage?: boolean; instantProcessScans?: boolean } = {},
) {
  const profiles = Array.from({ length: profileCount }, (_, index) =>
    makeBrowserProfile({
      name: `chrome-live-${index + 1}`,
      driver: "existing-session",
      attachOnly: true,
      cdpUrl: "",
      cdpPort: 0,
      userDataDir: `/tmp/openclaw-browser-status-${index + 1}`,
    }),
  );
  const profile = profiles[0];
  if (!profile) {
    throw new Error("expected browser profile");
  }
  const state = makeBrowserServerState({
    profile,
    resolvedOverrides: {
      defaultProfile: profile.name,
      profiles: Object.fromEntries(profiles.map((current) => [current.name, current])),
    },
  });
  const alive = new Set<number>();
  let nextPid = 40_000;
  const listProcesses = vi.fn(async () => {
    if (!options.instantProcessScans) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });
    }
    return [...alive].map((pid) => ({ pid, ppid: 1, identity: `fixture:${pid}` }));
  });
  setChromeMcpProcessCleanupDepsForTest({
    platform: "linux",
    listProcesses,
    sleep: async () => {},
    killProcess: (pid) => alive.delete(pid),
  });
  const callTool = vi.fn(
    async (
      _request: { name: string; arguments?: Record<string, unknown> },
      _resultSchema?: unknown,
      requestOptions?: { signal?: AbortSignal; timeout?: number },
    ) => {
      if (options.hangingPage) {
        return await new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(
            () => reject(new McpError(ErrorCode.RequestTimeout, "Request timed out")),
            requestOptions?.timeout ?? 60_000,
          );
          requestOptions?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new McpError(ErrorCode.RequestTimeout, "Request cancelled"));
            },
            { once: true },
          );
        });
      }
      if (pageFailure) {
        throw new Error("page unavailable");
      }
      return {
        content: [{ type: "text", text: "## Pages\n1: https://example.com [selected]" }],
      };
    },
  );
  const factory = vi.fn(async () => {
    if (options.attachElapsedMs) {
      vi.setSystemTime(Date.now() + options.attachElapsedMs);
    }
    const pid = nextPid++;
    alive.add(pid);
    const transport: { pid: number | null } = { pid };
    return {
      transport,
      processCleanup: { status: "open" as const },
      ready: Promise.resolve(),
      client: {
        callTool,
        close: vi.fn(async () => {
          alive.delete(pid);
          transport.pid = null;
        }),
      },
    } as never;
  });
  setChromeMcpSessionFactoryForTest(factory);
  return { callTool, factory, listProcesses, profile, profiles, state };
}

describe("browser server-context listProfiles", () => {
  it.each([1, 3])(
    "uses one temporary MCP session and only authority-required process scans for %i cold profiles",
    async (profileCount) => {
      const fixture = createExistingSessionProcessFixture(profileCount);
      const started = performance.now();
      const profiles = await createBrowserRouteContext({
        getState: () => fixture.state,
      }).listProfiles();
      const elapsedMs = performance.now() - started;

      console.info(
        `[browser-status-process-scans] profiles=${profileCount} scans=${fixture.listProcesses.mock.calls.length} elapsedMs=${elapsedMs.toFixed(1)}`,
      );
      expect(profiles.map(({ name, running, tabCount }) => ({ name, running, tabCount }))).toEqual(
        fixture.profiles.map(({ name }) => ({ name, running: true, tabCount: 1 })),
      );
      expect(fixture.factory).toHaveBeenCalledTimes(profileCount);
      expect(fixture.listProcesses).toHaveBeenCalledTimes(profileCount * 2);
    },
  );

  it("does not enumerate processes when profile status reuses a warm MCP session", async () => {
    const fixture = createExistingSessionProcessFixture();
    const ctx = createBrowserRouteContext({ getState: () => fixture.state });
    const profile = ctx.forProfile(fixture.profile.name).profile;
    await listChromeMcpTabs(profile.name, profile);
    fixture.listProcesses.mockClear();

    const profiles = await ctx.listProfiles();

    expect(profiles[0]).toMatchObject({ running: true, tabCount: 1 });
    expect(fixture.factory).toHaveBeenCalledOnce();
    expect(fixture.listProcesses).not.toHaveBeenCalled();
  });

  it("bounds a shared profile-list page probe with its inherited transport timeout", async () => {
    const fixture = createExistingSessionProcessFixture();

    const profiles = await createBrowserRouteContext({
      getState: () => fixture.state,
    }).listProfiles();

    expect(profiles[0]).toMatchObject({ running: true, tabCount: 1 });
    expect(fixture.callTool).toHaveBeenCalledWith(
      { name: "list_pages", arguments: {} },
      undefined,
      { signal: expect.any(AbortSignal), timeout: 300 },
    );
  });

  it("keeps process discovery scoped to each independent cold profile request", async () => {
    const fixture = createExistingSessionProcessFixture();
    const ctx = createBrowserRouteContext({ getState: () => fixture.state });

    await ctx.listProfiles();
    await ctx.listProfiles();

    expect(fixture.factory).toHaveBeenCalledTimes(2);
    expect(fixture.listProcesses).toHaveBeenCalledTimes(4);
  });

  it("reuses one temporary MCP session for the real browser status route", async () => {
    const fixture = createExistingSessionProcessFixture();
    const ctx = createBrowserRouteContext({ getState: () => fixture.state });
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserBasicRoutes(app, ctx);
    const response = createBrowserRouteResponse();
    const started = performance.now();

    await getHandlers.get("/")?.(
      { params: {}, query: { profile: fixture.profile.name } },
      response.res,
    );

    console.info(
      `[browser-status-process-scans] route=status scans=${fixture.listProcesses.mock.calls.length} elapsedMs=${(performance.now() - started).toFixed(1)}`,
    );
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({
      profile: fixture.profile.name,
      running: true,
      cdpReady: true,
      pageReady: true,
    });
    expect(fixture.factory).toHaveBeenCalledOnce();
    expect(fixture.listProcesses).toHaveBeenCalledTimes(2);
  });

  it("preserves healthy transport status when the shared page probe fails", async () => {
    const fixture = createExistingSessionProcessFixture(1, true);
    const ctx = createBrowserRouteContext({ getState: () => fixture.state });
    const { app, getHandlers } = createBrowserRouteApp();
    registerBrowserBasicRoutes(app, ctx);
    const response = createBrowserRouteResponse();

    await getHandlers.get("/")?.(
      { params: {}, query: { profile: fixture.profile.name } },
      response.res,
    );

    expect(response.body).toMatchObject({ running: true, cdpReady: true, pageReady: false });
    expect(fixture.factory).toHaveBeenCalledOnce();

    const profiles = await ctx.listProfiles();
    expect(profiles[0]).toMatchObject({ running: true, tabCount: 0 });
    expect(fixture.factory).toHaveBeenCalledTimes(2);
  });

  it("times out a stuck status page probe within the budget remaining after attach", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const fixture = createExistingSessionProcessFixture(1, false, {
        attachElapsedMs: 3_000,
        hangingPage: true,
        instantProcessScans: true,
      });
      const ctx = createBrowserRouteContext({ getState: () => fixture.state });
      const { app, getHandlers } = createBrowserRouteApp();
      registerBrowserBasicRoutes(app, ctx);
      const response = createBrowserRouteResponse();

      const pending = getHandlers.get("/")?.(
        { params: {}, query: { profile: fixture.profile.name } },
        response.res,
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(fixture.callTool).toHaveBeenCalledWith(
        { name: "list_pages", arguments: {} },
        undefined,
        { signal: expect.any(AbortSignal), timeout: 4_000 },
      );
      await vi.advanceTimersByTimeAsync(3_999);
      expect(response.body).toBeUndefined();

      await vi.advanceTimersByTimeAsync(1);
      await pending;

      expect(response.statusCode).toBe(200);
      expect(response.body).toMatchObject({ running: true, cdpReady: true, pageReady: false });
      expect(fixture.factory).toHaveBeenCalledOnce();
      expect(fixture.listProcesses).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads running state only after an in-flight profile transition settles", async () => {
    const state = makeBrowserServerState();
    const ctx = createBrowserRouteContext({ getState: () => state });
    ctx.forProfile("openclaw");
    const runtime = state.profiles.get("openclaw");
    if (!runtime) {
      throw new Error("expected profile runtime");
    }
    runtime.running = {
      pid: 123,
      exe: { kind: "chromium", path: "/usr/bin/chromium" },
      userDataDir: "/tmp/openclaw-profile",
      cdpPort: 18800,
      startedAt: Date.now(),
      proc: {} as never,
    };
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const transition = beginProfileTransition({
      state,
      runtime,
      reason: "stop requested",
      closeSharedAdapters: false,
      afterCleanup: async () => {
        await cleanupGate;
        runtime.running = null;
      },
    });
    vi.mocked(chromeModule.isChromeReachable).mockResolvedValue(false);

    const listing = ctx.listProfiles();
    await Promise.resolve();
    releaseCleanup();
    await transition;
    const profiles = await listing;

    expect(profiles[0]?.running).toBe(false);
  });

  it("bypasses SSRF gating when probing managed loopback profiles", async () => {
    const state = makeBrowserServerState({
      resolvedOverrides: {
        ssrfPolicy: {},
      },
    });
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
    isChromeReachable.mockResolvedValue(true);

    const ctx = createBrowserRouteContext({ getState: () => state });
    const profiles = await ctx.listProfiles();

    expect(isChromeReachable).toHaveBeenCalledWith("http://127.0.0.1:18800", 200, undefined);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.name).toBe("openclaw");
    expect(profiles[0]?.running).toBe(true);
  });

  it("uses remote-class probes for attachOnly loopback CDP profiles", async () => {
    const state = makeBrowserServerState({
      profile: {
        name: "manual-cdp",
        cdpUrl: "http://127.0.0.1:9222",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        cdpPort: 9222,
        color: "#00AA00",
        driver: "openclaw",
        headless: false,
        attachOnly: true,
      },
      resolvedOverrides: {
        defaultProfile: "manual-cdp",
        ssrfPolicy: {},
      },
    });
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
    isChromeReachable.mockResolvedValue(true);

    const ctx = createBrowserRouteContext({ getState: () => state });
    const profiles = await ctx.listProfiles();

    expect(isChromeReachable).toHaveBeenCalledWith(
      "http://127.0.0.1:9222",
      state.resolved.remoteCdpTimeoutMs,
      undefined,
    );
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.name).toBe("manual-cdp");
    expect(profiles[0]?.running).toBe(true);
  });

  it("redacts CDP URL credentials from profile status", async () => {
    const state = makeBrowserServerState({
      profile: {
        name: "manual-cdp",
        cdpUrl: "http://openclaw:relay-token@127.0.0.1:9222",
        cdpHost: "127.0.0.1",
        cdpIsLoopback: true,
        cdpPort: 9222,
        color: "#00AA00",
        driver: "openclaw",
        headless: false,
        attachOnly: true,
      },
      resolvedOverrides: {
        defaultProfile: "manual-cdp",
        ssrfPolicy: {},
      },
    });
    const isChromeReachable = vi.mocked(chromeModule.isChromeReachable);
    isChromeReachable.mockResolvedValue(true);

    const ctx = createBrowserRouteContext({ getState: () => state });
    const profiles = await ctx.listProfiles();

    expect(isChromeReachable).toHaveBeenCalledWith(
      "http://openclaw:relay-token@127.0.0.1:9222",
      state.resolved.remoteCdpTimeoutMs,
      undefined,
    );
    expect(profiles[0]?.cdpUrl).toBe("http://127.0.0.1:9222");
  });

  it.each(["constructor", "prototype"] as const)(
    "marks runtime-only %s profiles as missing from config",
    async (profileName) => {
      const profile = makeBrowserProfile({ name: profileName });
      const state = makeBrowserServerState({
        profile,
        resolvedOverrides: { profiles: {} },
      });
      state.profiles.set(profileName, {
        profile,
        running: { pid: 123 } as never,
        lastTargetId: null,
      });

      const ctx = createBrowserRouteContext({ getState: () => state });
      const profiles = await ctx.listProfiles();

      expect(profiles).toHaveLength(1);
      expect(profiles[0]).toMatchObject({ name: profileName, missingFromConfig: true });
    },
  );
});
