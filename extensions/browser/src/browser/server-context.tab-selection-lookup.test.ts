import { afterEach, describe, expect, it, vi } from "vitest";
import { withBrowserFetchPreconnect } from "../../test-fetch.js";
import "../test-support/browser-security.mock.js";
import "./server-context.chrome-test-harness.js";
import * as cdpHelpersModule from "./cdp.helpers.js";
import * as cdpModule from "./cdp.js";
import {
  createTestBrowserRouteContext,
  makeState,
  originalFetch,
} from "./server-context.remote-tab-ops.harness.js";

afterEach(async () => {
  const { closePlaywrightBrowserConnection } = await import("./pw-session.js");
  await closePlaywrightBrowserConnection().catch(() => {});
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function seedRunningProfileState(
  state: ReturnType<typeof makeState>,
  profileName = "openclaw",
): void {
  (state.profiles as Map<string, unknown>).set(profileName, {
    profile: { name: profileName },
    running: { pid: 1234, proc: { on: vi.fn() } },
    lastTargetId: null,
  });
}

function fetchCallUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

describe("browser server-context tab selection lookup state", () => {
  it("preserves the opened tab lookup when a same-target listing lacks a WebSocket URL", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockRejectedValue(new Error("raw create failed"));
    vi.spyOn(cdpModule, "waitForCdpCommittedNavigationUrl").mockResolvedValue(undefined);
    let listCalls = 0;
    const lookupHosts: string[] = [];
    const fetchJson = vi.spyOn(cdpHelpersModule, "fetchJson").mockImplementation(async (url) => {
      if (url.includes("/json/list")) {
        listCalls += 1;
        return listCalls === 1
          ? []
          : [
              {
                id: "NEW",
                title: "Listed",
                url: "about:blank",
                type: "page",
              },
            ];
      }
      if (url.includes("/json/new")) {
        return {
          id: "NEW",
          title: "Opened",
          url: "about:blank",
          webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/page/NEW",
          type: "page",
        };
      }
      throw new Error(`unexpected fetchJson: ${url}`);
    });
    vi.spyOn(cdpHelpersModule, "assertCdpEndpointAllowed").mockImplementation(async () => ({
      hostname: "browser.example",
      addresses: ["127.0.0.1"],
      lookup: ((hostname: string, _options: unknown, callback?: unknown) => {
        lookupHosts.push(hostname);
        if (typeof callback === "function") {
          callback(null, "127.0.0.1", 4);
        }
      }) as never,
    }));
    const state = makeState("openclaw");
    state.resolved.ssrfPolicy = {};
    seedRunningProfileState(state);
    const openclaw = createTestBrowserRouteContext({ getState: () => state }).forProfile(
      "openclaw",
    );

    const selected = await openclaw.ensureTabAvailable();

    expect(selected).toEqual(
      expect.objectContaining({
        targetId: "NEW",
        title: "Listed",
        url: "about:blank",
        wsUrl: "ws://127.0.0.1:18800/devtools/page/NEW",
      }),
    );
    expect(selected.wsLookup).toBeTypeOf("function");
    selected.wsLookup?.("browser.example", {}, () => {});
    expect(lookupHosts).toEqual(["browser.example"]);
    expect(fetchJson.mock.calls.some(([url]) => url.includes("/json/new"))).toBe(true);
  });

  it("resolves friendly tab references before backend focus and close calls", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const value = String(url);
      if (value.includes("/json/list")) {
        return {
          ok: true,
          json: async () => [
            {
              id: "DOCS_RAW",
              title: "Docs",
              url: "https://docs.example.com",
              webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/DOCS_RAW",
              type: "page",
            },
          ],
        } as unknown as Response;
      }
      if (value.includes("/json/activate/DOCS_RAW") || value.includes("/json/close/DOCS_RAW")) {
        return { ok: true } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${value}`);
    });

    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    const ctx = createTestBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    await openclaw.labelTab("DOCS_RAW", "docs");
    await expect(openclaw.ensureTabAvailable("t1")).resolves.toEqual(
      expect.objectContaining({ targetId: "DOCS_RAW" }),
    );
    await openclaw.focusTab("docs");
    await openclaw.closeTab("t1");

    expect(fetchCallUrls(fetchMock).some((url) => url.includes("/json/activate/DOCS_RAW"))).toBe(
      true,
    );
    expect(fetchCallUrls(fetchMock).some((url) => url.includes("/json/close/DOCS_RAW"))).toBe(true);
  });
});
