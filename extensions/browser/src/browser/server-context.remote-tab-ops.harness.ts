import { vi } from "vitest";
import { withFetchPreconnect } from "../../test-support.js";
import type { BrowserServerState } from "./server-context.js";
import { createBrowserRouteContext } from "./server-context.js";

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
      evaluateEnabled: false,
      extraArgs: [],
      color: "#FF4500",
      headless: true,
      noSandbox: false,
      attachOnly: false,
      ssrfPolicy: { allowPrivateNetwork: true },
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

export function createRemoteRouteHarness(fetchMock?: (url: unknown) => Promise<Response>) {
  const activeFetchMock = fetchMock ?? makeUnexpectedFetchMock();
  global.fetch = withFetchPreconnect(activeFetchMock);
  const state = makeState("remote");
  const ctx = createBrowserRouteContext({ getState: () => state });
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
