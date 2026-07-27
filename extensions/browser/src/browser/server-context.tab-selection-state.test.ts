// Browser tests cover server context.tab selection state plugin behavior.
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
  vi.useRealTimers();
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
    expect(fetchCallUrls(fetchMock).filter((url) => url.includes("/json/close/OLD1"))).not.toEqual(
      [],
    );
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
      .mockResolvedValue({ targetId: "CREATED", finalUrl: "http://127.0.0.1:8080" });

    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/json/version")) {
        return {
          ok: true,
          json: async () => ({
            webSocketDebuggerUrl:
              "ws://127.0.0.1:18800/devtools/browser/MANAGED-BROWSER?auth=fixture-value",
          }),
        } as unknown as Response;
      }
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
    expect((opened as { ownership?: unknown }).ownership).toMatchObject({
      status: "durable",
      nativeTargetId: "CREATED",
      profileFingerprint: expect.stringMatching(/^sha256:/),
      browserInstanceFingerprint: expect.stringMatching(/^sha256:/),
    });
    expect(state.profiles.get("openclaw")?.lastTargetId).toBe("CREATED");
    expect(createTargetViaCdp).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:18800",
      url: "http://127.0.0.1:8080",
      ssrfPolicy: undefined,
      waitForNavigationResult: true,
    });
  });

  it("does not sticky-adopt a CDP-created tab when the discovered URL is policy-blocked", async () => {
    const createTargetViaCdp = vi
      .spyOn(cdpModule, "createTargetViaCdp")
      .mockResolvedValueOnce({ targetId: "GOOD", finalUrl: "about:blank" })
      .mockResolvedValueOnce({ targetId: "BLOCKED", finalUrl: "https://example.com" });

    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (!u.includes("/json/list")) {
        throw new Error(`unexpected fetch: ${u}`);
      }
      const createdCount = createTargetViaCdp.mock.calls.length;
      return {
        ok: true,
        json: async () =>
          createdCount <= 1
            ? [
                {
                  id: "GOOD",
                  title: "Good",
                  url: "about:blank",
                  webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/GOOD",
                  type: "page",
                },
              ]
            : [
                {
                  id: "GOOD",
                  title: "Good",
                  url: "about:blank",
                  webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/GOOD",
                  type: "page",
                },
                {
                  id: "BLOCKED",
                  title: "Blocked",
                  url: "http://127.0.0.1:9/",
                  webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/BLOCKED",
                  type: "page",
                },
              ],
      } as unknown as Response;
    });

    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    state.resolved.ssrfPolicy = {};
    seedRunningProfileState(state);
    const ctx = createTestBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    await expect(openclaw.openTab("about:blank", { label: "good" })).resolves.toEqual(
      expect.objectContaining({ targetId: "GOOD" }),
    );
    expect(state.profiles.get("openclaw")?.lastTargetId).toBe("GOOD");
    const aliasesBefore = structuredClone(state.profiles.get("openclaw")?.tabAliases);

    await expect(openclaw.openTab("https://example.com", { label: "blocked" })).rejects.toThrow(
      /private|blocked|ssrf/i,
    );
    const profileState = state.profiles.get("openclaw");
    expect(profileState?.lastTargetId).toBe("GOOD");
    expect(profileState?.lastTargetId).not.toBe("BLOCKED");
    expect(profileState?.tabAliases).toEqual(aliasesBefore);
    expect(profileState?.tabAliases?.byTargetId.BLOCKED).toBeUndefined();
    expect(fetchCallUrls(fetchMock).some((url) => url.includes("/json/close/BLOCKED"))).toBe(false);

    await expect(openclaw.ensureTabAvailable()).resolves.toEqual(
      expect.objectContaining({ targetId: "GOOD" }),
    );
  });

  it("does not migrate a disappeared sticky alias onto a sole blocked discovery", async () => {
    const createTargetViaCdp = vi
      .spyOn(cdpModule, "createTargetViaCdp")
      .mockResolvedValueOnce({ targetId: "GOOD", finalUrl: "about:blank" })
      .mockResolvedValueOnce({ targetId: "BLOCKED", finalUrl: "https://example.com" });
    const fetchMock = vi.fn(async (url: unknown) => {
      const value = String(url);
      if (!value.includes("/json/list")) {
        throw new Error(`unexpected fetch: ${value}`);
      }
      const target =
        createTargetViaCdp.mock.calls.length === 1
          ? { id: "GOOD", title: "Good", url: "about:blank" }
          : { id: "BLOCKED", title: "Blocked", url: "http://127.0.0.1:9/" };
      return {
        ok: true,
        json: async () => [
          {
            ...target,
            webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${target.id}`,
            type: "page",
          },
        ],
      } as unknown as Response;
    });
    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    state.resolved.ssrfPolicy = {};
    const openclaw = createTestBrowserRouteContext({ getState: () => state }).forProfile(
      "openclaw",
    );

    await openclaw.openTab("about:blank", { label: "good" });
    const aliasesBefore = structuredClone(state.profiles.get("openclaw")?.tabAliases);

    await expect(openclaw.openTab("https://example.com", { label: "blocked" })).rejects.toThrow(
      /private|blocked|ssrf/i,
    );

    const profileState = state.profiles.get("openclaw");
    expect(profileState?.lastTargetId).toBe("GOOD");
    expect(profileState?.tabAliases).toEqual(aliasesBefore);
    expect(profileState?.tabAliases?.byTargetId).toEqual({
      GOOD: { tabId: "t1", label: "good", url: "about:blank" },
    });
  });

  it("returns an undiscovered CDP target without adopting or cleaning it", async () => {
    vi.useFakeTimers();
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({
      targetId: "UNDISCOVERED",
      finalUrl: "https://example.com/final",
    });
    const fetchMock = vi.fn(async (url: unknown) => {
      const value = String(url);
      if (!value.includes("/json/list")) {
        throw new Error(`unexpected fetch: ${value}`);
      }
      return {
        ok: true,
        json: async () => [
          {
            id: "GOOD",
            title: "Good",
            url: "about:blank",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/GOOD",
            type: "page",
          },
        ],
      } as unknown as Response;
    });
    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    seedRunningProfileState(state);
    const openclaw = createTestBrowserRouteContext({ getState: () => state }).forProfile(
      "openclaw",
    );
    await openclaw.listTabs();
    const profileState = state.profiles.get("openclaw");
    if (!profileState) {
      throw new Error("expected profile state");
    }
    profileState.lastTargetId = "GOOD";
    const aliasesBefore = structuredClone(profileState.tabAliases);

    const opening = openclaw.openTab("https://example.com/start", { label: "undiscovered" });
    await vi.advanceTimersByTimeAsync(2_100);
    await expect(opening).resolves.toEqual({
      targetId: "UNDISCOVERED",
      title: "",
      url: "https://example.com/final",
      type: "page",
      ownership: {
        status: "non-durable",
        reason: "browser-identity-lookup-failed",
      },
    });

    expect(profileState.lastTargetId).toBe("GOOD");
    expect(profileState.tabAliases).toEqual(aliasesBefore);
    expect(profileState.tabAliases?.byTargetId.UNDISCOVERED).toBeUndefined();
    expect(fetchCallUrls(fetchMock).some((url) => url.includes("/json/close/"))).toBe(false);
    await expect(openclaw.ensureTabAvailable()).resolves.toEqual(
      expect.objectContaining({ targetId: "GOOD", tabId: "t1" }),
    );
  });

  it("returns an unadopted target when CDP cannot prove the committed navigation", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({
      targetId: "UNSETTLED",
    });
    const fetchMock = vi.fn(async () => {
      throw new Error("navigation timeout must not start discovery or cleanup");
    });
    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    seedRunningProfileState(state);
    const profileState = state.profiles.get("openclaw");
    if (!profileState) {
      throw new Error("expected profile state");
    }
    profileState.lastTargetId = "GOOD";
    profileState.tabAliases = {
      nextTabNumber: 2,
      byTargetId: { GOOD: { tabId: "t1", label: "good", url: "about:blank" } },
    };
    const openclaw = createTestBrowserRouteContext({ getState: () => state }).forProfile(
      "openclaw",
    );

    await expect(openclaw.openTab("https://example.com", { label: "unsettled" })).resolves.toEqual({
      targetId: "UNSETTLED",
      title: "",
      url: "https://example.com",
      type: "page",
      ownership: {
        status: "non-durable",
        reason: "browser-identity-lookup-failed",
      },
    });

    expect(profileState.lastTargetId).toBe("GOOD");
    expect(profileState.tabAliases).toEqual({
      nextTabNumber: 2,
      byTargetId: { GOOD: { tabId: "t1", label: "good", url: "about:blank" } },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects invalid labels before direct CDP target creation", async () => {
    const createTargetViaCdp = vi.spyOn(cdpModule, "createTargetViaCdp");
    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });
    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    const openclaw = createTestBrowserRouteContext({ getState: () => state }).forProfile(
      "openclaw",
    );

    await expect(openclaw.openTab("about:blank", { label: "not allowed" })).rejects.toThrow(
      /tab label/i,
    );

    expect(createTargetViaCdp).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.profiles.get("openclaw")?.tabAliases).toBeUndefined();
  });

  it("can bootstrap a managed loopback tab under strict SSRF because CDP control stays local", async () => {
    const createTargetViaCdp = vi
      .spyOn(cdpModule, "createTargetViaCdp")
      .mockResolvedValue({ targetId: "CREATED", finalUrl: "about:blank" });

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
      waitForNavigationResult: true,
    });
  });

  it("opens a real tab when only browser-internal CDP targets are listed", async () => {
    const createTargetViaCdp = vi
      .spyOn(cdpModule, "createTargetViaCdp")
      .mockResolvedValue({ targetId: "REAL", finalUrl: "about:blank" });

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
      waitForNavigationResult: true,
    });
  });

  it("closes excess managed tabs after opening a new tab", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({
      targetId: "NEW",
      finalUrl: "http://127.0.0.1:3009",
    });
    const existingTabs = makeManagedTabsWithNew();
    const fetchMock = createOldTabCleanupFetchMock(existingTabs);

    const opened = await openManagedTabWithRunningProfile({ fetchMock });
    expect(opened.targetId).toBe("NEW");
    await expectOldManagedTabClose(fetchMock);
  });

  it("never closes the just-opened managed tab during cap cleanup", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({
      targetId: "NEW",
      finalUrl: "http://127.0.0.1:3009",
    });
    const existingTabs = makeManagedTabsWithNew({ newFirst: true });
    const fetchMock = createOldTabCleanupFetchMock(existingTabs, { rejectNewTabClose: true });

    const opened = await openManagedTabWithRunningProfile({ fetchMock });
    expect(opened.targetId).toBe("NEW");
    await expectOldManagedTabClose(fetchMock);
    expect(fetchCallUrls(fetchMock).filter((url) => url.includes("/json/close/NEW"))).toEqual([]);
  });

  it("does not fail tab open when managed-tab cleanup list fails", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({
      targetId: "NEW",
      finalUrl: "http://127.0.0.1:3009",
    });

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
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({
      targetId: "NEW",
      finalUrl: "http://127.0.0.1:3009",
    });
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
    expect(fetchCallUrls(fetchMock).filter((url) => url.includes("/json/close/"))).toEqual([]);
  });

  it("does not block openTab on slow best-effort cleanup closes", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockResolvedValue({
      targetId: "NEW",
      finalUrl: "http://127.0.0.1:3009",
    });
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
    const waitForCommittedNavigation = vi
      .spyOn(cdpModule, "waitForCdpCommittedNavigationUrl")
      .mockResolvedValue("https://example.com");
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

    const opened = await openclaw.openTab("https://example.com", { label: "raw" });
    expect(opened).toEqual(
      expect.objectContaining({
        targetId: "NEW",
        tabId: "t1",
        label: "raw",
        suggestedTargetId: "raw",
      }),
    );
    expect(state.profiles.get("openclaw")?.lastTargetId).toBe("NEW");
    expect(waitForCommittedNavigation).toHaveBeenCalledWith(
      expect.objectContaining({ requestedUrl: "https://example.com" }),
    );
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

  it("returns a raw-created target without adoption when its committed URL is unavailable", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockRejectedValue(new Error("cdp unavailable"));
    vi.spyOn(cdpModule, "waitForCdpCommittedNavigationUrl").mockResolvedValue(undefined);
    vi.spyOn(cdpHelpersModule, "fetchJson").mockResolvedValue({
      id: "RAW_UNSETTLED",
      title: "Unsettled",
      url: "https://example.com",
      webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/page/RAW_UNSETTLED",
      type: "page",
    });
    const state = makeState("openclaw");
    seedRunningProfileState(state);
    const profileState = state.profiles.get("openclaw");
    if (!profileState) {
      throw new Error("expected profile state");
    }
    profileState.lastTargetId = "GOOD";
    profileState.tabAliases = {
      nextTabNumber: 2,
      byTargetId: { GOOD: { tabId: "t1", label: "good", url: "about:blank" } },
    };
    const openclaw = createTestBrowserRouteContext({ getState: () => state }).forProfile(
      "openclaw",
    );

    await expect(openclaw.openTab("https://example.com", { label: "unsettled" })).resolves.toEqual({
      targetId: "RAW_UNSETTLED",
      title: "Unsettled",
      url: "https://example.com",
      wsUrl: "ws://127.0.0.1:18800/devtools/page/RAW_UNSETTLED",
      type: "page",
      ownership: {
        status: "non-durable",
        reason: "browser-identity-lookup-failed",
      },
    });
    expect(profileState.lastTargetId).toBe("GOOD");
    expect(profileState.tabAliases?.byTargetId.RAW_UNSETTLED).toBeUndefined();
  });

  it("rejects a raw-created target whose committed URL is policy-blocked", async () => {
    vi.spyOn(cdpModule, "createTargetViaCdp").mockRejectedValue(new Error("cdp unavailable"));
    vi.spyOn(cdpModule, "waitForCdpCommittedNavigationUrl").mockResolvedValue(
      "http://127.0.0.1:9/blocked",
    );
    vi.spyOn(cdpHelpersModule, "fetchJson").mockResolvedValue({
      id: "RAW_BLOCKED",
      title: "Blocked",
      url: "https://example.com",
      webSocketDebuggerUrl: "ws://127.0.0.1:18800/devtools/page/RAW_BLOCKED",
      type: "page",
    });
    const state = makeState("openclaw");
    state.resolved.ssrfPolicy = {};
    const openclaw = createTestBrowserRouteContext({ getState: () => state }).forProfile(
      "openclaw",
    );

    await expect(openclaw.openTab("https://example.com", { label: "blocked" })).rejects.toThrow(
      /private|blocked|ssrf/i,
    );
    const profileState = state.profiles.get("openclaw");
    expect(profileState?.lastTargetId).toBeNull();
    expect(profileState?.tabAliases).toBeUndefined();
  });

  it("assigns stable tab ids and prefers labels as suggested target ids", async () => {
    const fetchMock = vi.fn(async (url: unknown) => {
      const value = String(url);
      if (!value.includes("/json/list")) {
        throw new Error(`unexpected fetch: ${value}`);
      }
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
          {
            id: "APP_RAW",
            title: "App",
            url: "https://app.example.com",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/APP_RAW",
            type: "page",
          },
        ],
      } as unknown as Response;
    });

    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    const ctx = createTestBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    expect(await openclaw.listTabs()).toEqual([
      expect.objectContaining({
        targetId: "DOCS_RAW",
        tabId: "t1",
        suggestedTargetId: "t1",
      }),
      expect.objectContaining({
        targetId: "APP_RAW",
        tabId: "t2",
        suggestedTargetId: "t2",
      }),
    ]);

    await expect(openclaw.labelTab("t1", "docs")).resolves.toEqual(
      expect.objectContaining({
        targetId: "DOCS_RAW",
        tabId: "t1",
        label: "docs",
        suggestedTargetId: "docs",
      }),
    );
  });

  it("carries a stale alias to a single replacement target", async () => {
    let listCount = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      const value = String(url);
      if (!value.includes("/json/list")) {
        throw new Error(`unexpected fetch: ${value}`);
      }
      listCount += 1;
      const secondList = listCount > 1;
      return {
        ok: true,
        json: async () =>
          secondList
            ? [
                {
                  id: "FIRST_RAW",
                  title: "First",
                  url: "https://first.example.com",
                  webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/FIRST_RAW",
                  type: "page",
                },
                {
                  id: "THIRD_RAW",
                  title: "Third",
                  url: "https://third.example.com",
                  webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/THIRD_RAW",
                  type: "page",
                },
              ]
            : [
                {
                  id: "FIRST_RAW",
                  title: "First",
                  url: "https://first.example.com",
                  webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/FIRST_RAW",
                  type: "page",
                },
                {
                  id: "SECOND_RAW",
                  title: "Second",
                  url: "https://second.example.com",
                  webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/SECOND_RAW",
                  type: "page",
                },
              ],
      } as unknown as Response;
    });

    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    const ctx = createTestBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    expect((await openclaw.listTabs()).map((tab) => tab.tabId)).toEqual(["t1", "t2"]);
    expect(await openclaw.listTabs()).toEqual([
      expect.objectContaining({ targetId: "FIRST_RAW", tabId: "t1" }),
      expect.objectContaining({ targetId: "THIRD_RAW", tabId: "t2" }),
    ]);
  });

  it("carries stable aliases across confident raw target replacement", async () => {
    let listCount = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      const value = String(url);
      if (!value.includes("/json/list")) {
        throw new Error(`unexpected fetch: ${value}`);
      }
      listCount += 1;
      const targetId = listCount > 1 ? "NEW_RAW" : "OLD_RAW";
      return {
        ok: true,
        json: async () => [
          {
            id: targetId,
            title: "Checkout",
            url: "https://shop.example.com/checkout",
            webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${targetId}`,
            type: "page",
          },
        ],
      } as unknown as Response;
    });

    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    const ctx = createTestBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    await expect(openclaw.labelTab("OLD_RAW", "checkout")).resolves.toEqual(
      expect.objectContaining({
        targetId: "OLD_RAW",
        tabId: "t1",
        suggestedTargetId: "checkout",
      }),
    );
    const profileState = state.profiles.get("openclaw");
    if (!profileState) {
      throw new Error("expected profile state");
    }
    profileState.lastTargetId = "OLD_RAW";

    await expect(openclaw.listTabs()).resolves.toEqual([
      expect.objectContaining({
        targetId: "NEW_RAW",
        tabId: "t1",
        label: "checkout",
        suggestedTargetId: "checkout",
      }),
    ]);
    expect(state.profiles.get("openclaw")?.lastTargetId).toBe("NEW_RAW");
  });

  it("expires aliases when duplicate-URL targets are replaced ambiguously", async () => {
    let targets = [
      { id: "OLD_LEFT", title: "Left", url: "https://app.example/same" },
      { id: "OLD_RIGHT", title: "Right", url: "https://app.example/same" },
    ];
    const fetchMock = vi.fn(async (url: unknown) => {
      const value = String(url);
      if (!value.includes("/json/list")) {
        throw new Error(`unexpected fetch: ${value}`);
      }
      return {
        ok: true,
        json: async () =>
          targets.map((target) => ({
            id: target.id,
            title: target.title,
            url: target.url,
            webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${target.id}`,
            type: "page",
          })),
      } as unknown as Response;
    });

    global.fetch = withBrowserFetchPreconnect(fetchMock);
    const state = makeState("openclaw");
    const ctx = createTestBrowserRouteContext({ getState: () => state });
    const openclaw = ctx.forProfile("openclaw");

    expect((await openclaw.listTabs()).map((tab) => [tab.targetId, tab.tabId])).toEqual([
      ["OLD_LEFT", "t1"],
      ["OLD_RIGHT", "t2"],
    ]);
    await openclaw.labelTab("t1", "left");
    await openclaw.labelTab("t2", "right");
    state.profiles.get("openclaw")!.lastTargetId = "OLD_LEFT";

    targets = [
      { id: "NEW_RIGHT", title: "Right", url: "https://app.example/same" },
      { id: "NEW_LEFT", title: "Left", url: "https://app.example/same" },
    ];

    await expect(openclaw.listTabs()).resolves.toEqual([
      expect.objectContaining({ targetId: "NEW_RIGHT", tabId: "t3", suggestedTargetId: "t3" }),
      expect.objectContaining({ targetId: "NEW_LEFT", tabId: "t4", suggestedTargetId: "t4" }),
    ]);
    expect(state.profiles.get("openclaw")?.lastTargetId).toBe("OLD_LEFT");
    await expect(openclaw.ensureTabAvailable("left")).rejects.toThrow(/tab not found/i);
    await expect(openclaw.ensureTabAvailable()).rejects.toThrow(/tab not found/i);

    await openclaw.labelTab("t3", "fresh-right");
    targets = [
      { id: "NEW_LEFT", title: "Left", url: "https://app.example/same" },
      { id: "NEWER_RIGHT", title: "Right", url: "https://app.example/same" },
    ];
    await expect(openclaw.listTabs()).resolves.toEqual([
      expect.objectContaining({ targetId: "NEW_LEFT", tabId: "t4" }),
      expect.objectContaining({
        targetId: "NEWER_RIGHT",
        tabId: "t3",
        label: "fresh-right",
        suggestedTargetId: "fresh-right",
      }),
    ]);
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
