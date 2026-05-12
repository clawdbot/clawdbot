import { afterEach, describe, expect, it, vi } from "vitest";
import { withBrowserFetchPreconnect } from "../../test-fetch.js";
import "../test-support/browser-security.mock.js";
import "./server-context.chrome-test-harness.js";
import { CDP_JSON_NEW_TIMEOUT_MS } from "./cdp-timeouts.js";
import * as cdpHelpersModule from "./cdp.helpers.js";
import * as cdpModule from "./cdp.js";
import { InvalidBrowserNavigationUrlError } from "./navigation-guard.js";
import {
  createTestBrowserRouteContext,
  makeManagedTabsWithNew,
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

async function expectOldManagedTabClose(fetchMock: ReturnType<typeof vi.fn>): Promise<void> {
  await vi.waitFor(() => {
    expect(fetchCallUrls(fetchMock).some((url) => url.includes("/json/close/OLD1"))).toBe(true);
  });
}

function fetchCallUrls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url));
}

function fetchJsonCall(fetchJson: ReturnType<typeof vi.fn>, index: number): unknown[] {
  const call = fetchJson.mock.calls[index];
  if (!call) {
    throw new Error(`expected fetchJson call ${index + 1}`);
  }
  return call;
}

function createOldTabCleanupFetchMock(
  existingTabs: ReturnType<typeof makeManagedTabsWithNew>,
  params?: { rejectNewTabClose?: boolean },
): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: unknown) => {
    const value = String(url);
    if (value.includes("/json/list")) {
      return { ok: true, json: async () => existingTabs } as unknown as Response;
    }
    if (value.includes("/json/close/OLD1")) {
      return { ok: true, json: async () => ({}) } as unknown as Response;
    }
    if (params?.rejectNewTabClose && value.includes("/json/close/NEW")) {
      throw new Error("cleanup must not close NEW");
    }
    throw new Error(`unexpected fetch: ${value}`);
  });
}

function createManagedTabListFetchMock(params: {
  existingTabs: ReturnType<typeof makeManagedTabsWithNew>;
  onClose: (url: string) => Response | Promise<Response>;
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: unknown) => {
    const value = String(url);
    if (value.includes("/json/list")) {
      return { ok: true, json: async () => params.existingTabs } as unknown as Response;
    }
    if (value.includes("/json/close/")) {
      return await params.onClose(value);
    }
    throw new Error(`unexpected fetch: ${value}`);
  });
}

async function openManagedTabWithRunningProfile(params: {
  fetchMock: ReturnType<typeof vi.fn>;
  url?: string;
}) {
  global.fetch = withBrowserFetchPreconnect(params.fetchMock);
  const state = makeState("openclaw");
  seedRunningProfileState(state);
  const ctx = createTestBrowserRouteContext({ getState: () => state });
  const openclaw = ctx.forProfile("openclaw");
  return await openclaw.openTab(params.url ?? "http://127.0.0.1:3009");
}

describe("browser server-context tab selection state", () => {
  it("updates lastTargetId when openTab is created via CDP", async () => {
    const createTargetViaCdp = vi
      .spyOn(cdpModule, "createTargetViaCdp")
      .mockResolvedValue({ targetId: "CREATED" });

    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (!u.includes("/json/list")) {
        throw new Error(`unexpected fetch: ${u}`);
      }
      return {
        ok: true,
        json: async () => [
          {
            id: "CREATED",
            title: "New Tab",
            url: "http://127.0.0.1:8080",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/CREATED",
            type: "page",
          },
        ],
      } as unknown as Response;
    });

    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    const ctx = createTestBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const opened = await openclaw.openTab("http://127.0.0.1:8080");
    expect(opened.targetId).toBe("CREATED");
    expect(state.profiles.get("openclaw")?.lastTargetId).toBe("CREATED");
    expect(createTargetViaCdp).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      url: "http://127.0.0.1:8080",
      ssrfPolicy: undefined,
    });
  });

  it("can bootstrap a managed loopback tab under strict SSRF because CDP control stays local", async () => {
    const createTargetViaCdp = vi
      .spyOn(cdpModule, "createTargetViaCdp")
      .mockResolvedValue({ targetId: "CREATED" });

    let listCount = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (!u.includes("/json/list")) {
        throw new Error(`unexpected fetch: ${u}`);
      }
      listCount += 1;
      return {
        ok: true,
        json: async () =>
          listCount === 1
            ? []
            : [
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

    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    state.resolved.ssrfPolicy = {};
    const ctx = createTestBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const selected = await openclaw.ensureTabAvailable();
    expect(selected.targetId).toBe("CREATED");
    expect(createTargetViaCdp).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      url: "about:blank",
      ssrfPolicy: undefined,
    });
  });

  it("opens a real tab when only browser-internal CDP targets are listed", async () => {
    const createTargetViaCdp = vi
      .spyOn(cdpModule, "createTargetViaCdp")
      .mockResolvedValue({ targetId: "REAL" });

    let listCount = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (!u.includes("/json/list")) {
        throw new Error(`unexpected fetch: ${u}`);
      }
      listCount += 1;
      return {
        ok: true,
        json: async () =>
          listCount <= 2
            ? [
                {
                  id: "OMNI",
                  title: "Omnibox Popup",
                  url: "chrome://omnibox-popup.top-chrome/",
                  webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OMNI",
                  type: "page",
                },
              ]
            : [
                {
                  id: "OMNI",
                  title: "Omnibox Popup",
                  url: "chrome://omnibox-popup.top-chrome/",
                  webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/OMNI",
                  type: "page",
                },
                {
                  id: "REAL",
                  title: "New Tab",
                  url: "about:blank",
                  webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/REAL",
                  type: "page",
                },
              ],
      } as unknown as Response;
    });

    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    const ctx = createTestBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const selected = await openclaw.ensureTabAvailable();
    expect(selected.targetId).toBe("REAL");
    expect(state.profiles.get("openclaw")?.lastTargetId).toBe("REAL");
    expect(createTargetViaCdp).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      url: "about:blank",
      ssrfPolicy: undefined,
    });
  });

  it("closes excess managed tabs after opening a new tab", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({ targetId: "NEW" });
    const existingTabs = makeManagedTabsWithNew();
    const fetchMock = createOldTabCleanupFetchMock(existingTabs);

    const opened = await openManagedTabWithRunningProfile({ fetchMock });
    expect(opened.targetId).toBe("NEW");
    await expectOldManagedTabClose(fetchMock);
  });

  it("never closes the just-opened managed tab during cap cleanup", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({ targetId: "NEW" });
    const existingTabs = makeManagedTabsWithNew({ newFirst: true });
    const fetchMock = createOldTabCleanupFetchMock(existingTabs, { rejectNewTabClose: true });

    const opened = await openManagedTabWithRunningProfile({ fetchMock });
    expect(opened.targetId).toBe("NEW");
    await expectOldManagedTabClose(fetchMock);
    expect(fetchCallUrls(fetchMock).some((url) => url.includes("/json/close/NEW"))).toBe(false);
  });

  it("does not fail tab open when managed-tab cleanup list fails", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({ targetId: "NEW" });

    let listCount = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      const value = String(url);
      if (value.includes("/json/list")) {
        listCount += 1;
        if (listCount === 1) {
          return {
            ok: true,
            json: async () => [
              {
                id: "NEW",
                title: "New Tab",
                url: "http://127.0.0.1:3009",
                webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/NEW",
                type: "page",
              },
            ],
          } as unknown as Response;
        }
        throw new Error("/json/list timeout");
      }
      throw new Error(`unexpected fetch: ${value}`);
    });

    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    seedRunningProfileState(state);
    const ctx = createTestBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const opened = await openclaw.openTab("http://127.0.0.1:3009");
    expect(opened.targetId).toBe("NEW");
  });

  it("does not run managed tab cleanup in attachOnly mode", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({ targetId: "NEW" });
    const existingTabs = makeManagedTabsWithNew();
    const fetchMock = createManagedTabListFetchMock({
      existingTabs,
      onClose: () => {
        throw new Error("should not close tabs in attachOnly mode");
      },
    });

    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    state.resolved.attachOnly = true;
    const ctx = createTestBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const opened = await openclaw.openTab("http://127.0.0.1:3009");
    expect(opened.targetId).toBe("NEW");
    expect(fetchCallUrls(fetchMock).some((url) => url.includes("/json/close/"))).toBe(false);
  });

  it("does not block openTab on slow best-effort cleanup closes", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({ targetId: "NEW" });
    const existingTabs = makeManagedTabsWithNew();
    const fetchMock = createManagedTabListFetchMock({
      existingTabs,
      onClose: (url) => {
        if (url.includes("/json/close/OLD1")) {
          return new Promise<Response>(() => {});
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
    });

    let timeout: NodeJS.Timeout | undefined;
    const opened = await Promise.race([
      openManagedTabWithRunningProfile({ fetchMock }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("openTab timed out waiting for cleanup")), 300);
      }),
    ]).finally(() => {
      if (timeout) {
        clearTimeout(timeout);
      }
    });

    expect(opened.targetId).toBe("NEW");
  });

  it("blocks unsupported non-network URLs before any HTTP tab-open fallback", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });

    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    const ctx = createTestBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    await expect(openclaw.openTab("file:///etc/passwd")).rejects.toBeInstanceOf(
      InvalidBrowserNavigationUrlError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the loopback CDP control policy for /json/new fallback requests", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockRejectedValue(new Error("cdp unavailable"));
    const fetchJson = vi.spyOn(cdpHelpersModule, "fetchJson");
    fetchJson.mockRejectedValueOnce(new Error("HTTP 405")).mockResolvedValueOnce({
      id: "NEW",
      title: "New Tab",
      url: "https://example.com",
      webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/NEW",
      type: "page",
    });

    const state = makeState("openclaw");
    state.resolved.ssrfPolicy = {};
    const ctx = createTestBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    const opened = await openclaw.openTab("https://example.com");
    expect(opened.targetId).toBe("NEW");
    const jsonNewEndpoint = "http://127.0.0.1:18800/json/new?https%3A%2F%2Fexample.com";
    expect(fetchJsonCall(fetchJson, 0)).toEqual([
      jsonNewEndpoint,
      CDP_JSON_NEW_TIMEOUT_MS,
      { method: "PUT" },
      undefined,
    ]);
    expect(fetchJsonCall(fetchJson, 1)).toEqual([
      jsonNewEndpoint,
      CDP_JSON_NEW_TIMEOUT_MS,
      undefined,
      undefined,
    ]);
  });
});
