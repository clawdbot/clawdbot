import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import type { RunningChrome } from "./chrome.js";
import type { ResolvedBrowserProfile } from "./config.js";
import type { BrowserServerState } from "./server-context.js";

export function makeBrowserProfile(
  overrides: Partial<ResolvedBrowserProfile> = {},
): ResolvedBrowserProfile {
  return {
    name: "openclaw",
    cdpUrl: "http://127.0.0.1:18800",
    cdpHost: "127.0.0.1",
    cdpIsLoopback: true,
    cdpPort: 18800,
    color: "#FF4500",
    driver: "openclaw",
    headless: false,
    attachOnly: false,
    ...overrides,
  };
}

export function makeBrowserServerState(params?: {
  profile?: ResolvedBrowserProfile;
  resolvedOverrides?: Partial<BrowserServerState["resolved"]>;
}): BrowserServerState {
  const profile = params?.profile ?? makeBrowserProfile();
  const resolvedBase: BrowserServerState["resolved"] = {
    enabled: true,
    controlPort: 18791,
    cdpProtocol: "http",
    cdpHost: profile.cdpHost,
    cdpIsLoopback: profile.cdpIsLoopback,
    cdpPortRangeStart: 18800,
    cdpPortRangeEnd: 18810,
    evaluateEnabled: false,
    remoteCdpTimeoutMs: 1500,
    remoteCdpHandshakeTimeoutMs: 3000,
    localLaunchTimeoutMs: 15_000,
    localCdpReadyTimeoutMs: 8_000,
    actionTimeoutMs: 60_000,
    extraArgs: [],
    color: profile.color,
    headless: true,
    noSandbox: false,
    attachOnly: false,
    ssrfPolicy: { allowPrivateNetwork: true },
    tabCleanup: {
      enabled: true,
      idleMinutes: 120,
      maxTabsPerSession: 8,
      sweepMinutes: 5,
    },
    defaultProfile: profile.name,
    profiles: {
      [profile.name]: profile,
    },
  };
  return {
    server: null as any,
    port: 0,
    resolved: {
      ...resolvedBase,
      ...params?.resolvedOverrides,
      tabCleanup: params?.resolvedOverrides?.tabCleanup ?? resolvedBase.tabCleanup,
    },
    profiles: new Map(),
  };
}

export function mockLaunchedChrome(
  launchOpenClawChrome: { mockResolvedValue: (value: RunningChrome) => unknown },
  pid: number,
) {
  const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  launchOpenClawChrome.mockResolvedValue({
    pid,
    exe: { kind: "chromium", path: "/usr/bin/chromium" },
    userDataDir: "/tmp/openclaw-test",
    cdpPort: 18800,
    startedAt: Date.now(),
    proc,
  });
}
