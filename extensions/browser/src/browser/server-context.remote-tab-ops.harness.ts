import { vi } from "vitest";
import { withBrowserFetchPreconnect } from "../../test-fetch.js";
import { resolveCdpControlPolicy } from "./cdp-reachability-policy.js";
import type { ResolvedBrowserProfile } from "./config.js";
import { createProfileSelectionOps } from "./server-context.selection.js";
import { createProfileTabOps } from "./server-context.tab-ops.js";
import type { BrowserServerState, ProfileRuntimeState } from "./server-context.types.js";

export const originalFetch = globalThis.fetch;

export function makeState(
  profile: "remote" | "openclaw",
): BrowserServerState & { profiles: Map<string, { lastTargetId?: string | null }> } {
  return {
    server: null as unknown as BrowserServerState["server"],
    port: 0,
    resolved: {
      enabled: true,
      controlPort: 18791,
      cdpPortRangeStart: 18800,
      cdpPortRangeEnd: 18899,
      cdpProtocol: profile === "remote" ? "https" : "http",
      cdpHost: profile === "remote" ? "1.1.1.1" : "127.0.0.1",
      cdpIsLoopback: profile !== "remote",
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      localLaunchTimeoutMs: 15_000,
      localCdpReadyTimeoutMs: 8_000,
      actionTimeoutMs: 60_000,
      evaluateEnabled: false,
      extraArgs: [],
      color: "#FF4500",
      headless: true,
      headlessSource: "config",
      noSandbox: false,
      attachOnly: false,
      ssrfPolicy: { allowPrivateNetwork: true },
      tabCleanup: {
        enabled: true,
        idleMinutes: 120,
        maxTabsPerSession: 8,
        sweepMinutes: 5,
      },
      defaultProfile: profile,
      profiles: {
        remote: {
          cdpUrl: "https://1.1.1.1:9222/chrome?token=abc",
          cdpPort: 9222,
          color: "#00AA00",
        },
        openclaw: { cdpPort: 18800, color: "#FF4500" },
      },
    },
    profiles: new Map(),
  };
}

export function makeUnexpectedFetchMock() {
  return vi.fn(async () => {
    throw new Error("unexpected fetch");
  });
}

function resolveProfileForTest(
  state: BrowserServerState,
  profileName: string,
): ResolvedBrowserProfile {
  const rawProfile = state.resolved.profiles[profileName] ?? {};
  const cdpPort =
    typeof rawProfile.cdpPort === "number"
      ? rawProfile.cdpPort
      : profileName === "remote"
        ? 9222
        : state.resolved.cdpPortRangeStart;
  const cdpUrl =
    typeof rawProfile.cdpUrl === "string"
      ? rawProfile.cdpUrl
      : `${state.resolved.cdpProtocol}://${state.resolved.cdpHost}:${cdpPort}`;
  const parsed = new URL(cdpUrl.replace(/^ws/i, "http"));
  const cdpHost = parsed.hostname;
  const cdpIsLoopback = cdpHost === "localhost" || cdpHost === "127.0.0.1" || cdpHost === "::1";
  return {
    name: profileName,
    cdpPort,
    cdpUrl,
    cdpHost,
    cdpIsLoopback,
    color: rawProfile.color ?? state.resolved.color,
    driver: rawProfile.driver === "existing-session" ? "existing-session" : "openclaw",
    headless: rawProfile.headless ?? state.resolved.headless,
    headlessSource:
      typeof rawProfile.headless === "boolean" ? "profile" : state.resolved.headlessSource,
    attachOnly: rawProfile.attachOnly ?? state.resolved.attachOnly,
    userDataDir: rawProfile.userDataDir,
  };
}

export function createTestBrowserRouteContext(opts: { getState: () => BrowserServerState }) {
  const forProfile = (profileName?: string) => {
    const state = opts.getState();
    const profile = resolveProfileForTest(state, profileName ?? state.resolved.defaultProfile);
    const getProfileState = (): ProfileRuntimeState => {
      let profileState = state.profiles.get(profile.name);
      if (!profileState) {
        profileState = { profile, running: null, lastTargetId: null, reconcile: null };
        state.profiles.set(profile.name, profileState);
      }
      return profileState;
    };
    const tabOps = createProfileTabOps({
      profile,
      state: () => state,
      getProfileState,
    });
    const selectionOps = createProfileSelectionOps({
      profile,
      getProfileState,
      getCdpControlPolicy: () => resolveCdpControlPolicy(profile, state.resolved.ssrfPolicy),
      ensureBrowserAvailable: async () => {},
      listTabs: tabOps.listTabs,
      openTab: tabOps.openTab,
    });
    return { profile, ...tabOps, ...selectionOps };
  };
  return { forProfile };
}

export function createRemoteRouteHarness(fetchMock?: (url: unknown) => Promise<Response>) {
  const activeFetchMock = fetchMock ?? makeUnexpectedFetchMock();
  global.fetch = withBrowserFetchPreconnect(activeFetchMock);
  const state = makeState("remote");
  const ctx = createTestBrowserRouteContext({ getState: () => state });
  return { state, remote: ctx.forProfile("remote"), fetchMock: activeFetchMock };
}

export function createSequentialPageLister<T>(responses: T[]) {
  return async () => {
    const next = responses.shift();
    if (!next) {
      throw new Error("no more responses");
    }
    return next;
  };
}

type JsonListEntry = {
  id: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
  type: "page";
};

export function createJsonListFetchMock(entries: JsonListEntry[]) {
  return async (url: unknown) => {
    const u = String(url);
    if (!u.includes("/json/list")) {
      throw new Error(`unexpected fetch: ${u}`);
    }
    return {
      ok: true,
      json: async () => entries,
    } as unknown as Response;
  };
}

function makeManagedTab(id: string, ordinal: number): JsonListEntry {
  return {
    id,
    title: String(ordinal),
    url: `http://127.0.0.1:300${ordinal}`,
    webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${id}`,
    type: "page",
  };
}

export function makeManagedTabsWithNew(params?: { newFirst?: boolean }): JsonListEntry[] {
  const oldTabs = Array.from({ length: 8 }, (_, index) =>
    makeManagedTab(`OLD${index + 1}`, index + 1),
  );
  const newTab = makeManagedTab("NEW", 9);
  return params?.newFirst ? [newTab, ...oldTabs] : [...oldTabs, newTab];
}
