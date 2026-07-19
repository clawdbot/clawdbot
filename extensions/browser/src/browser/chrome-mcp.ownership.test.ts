import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { fetchJsonMock, fetchOkMock } = vi.hoisted(() => ({
  fetchJsonMock: vi.fn(),
  fetchOkMock: vi.fn(),
}));

vi.mock("./cdp.helpers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cdp.helpers.js")>();
  return {
    ...actual,
    fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
    fetchOk: (...args: unknown[]) => fetchOkMock(...args),
    resolveCdpTabOwnership: async (params: {
      profileName: string;
      cdpUrl: string;
      nativeTargetId: string;
      signal?: AbortSignal;
      timeoutMs?: number;
      ssrfPolicy?: unknown;
    }) => {
      const version = (await fetchJsonMock(
        `${actual.normalizeCdpHttpBaseForJsonEndpoints(params.cdpUrl)}/json/version`,
        params.timeoutMs,
        { signal: params.signal },
        params.ssrfPolicy,
      )) as { webSocketDebuggerUrl?: unknown };
      if (
        typeof version.webSocketDebuggerUrl !== "string" ||
        !/\/devtools\/browser\/[^/?#]+/i.test(new URL(version.webSocketDebuggerUrl).pathname)
      ) {
        return { status: "non-durable", reason: "browser-identity-unavailable" };
      }
      return {
        status: "durable",
        nativeTargetId: params.nativeTargetId,
        profileFingerprint: "sha256:fixture-profile",
        browserInstanceFingerprint: "sha256:fixture-browser",
      };
    },
  };
});

import {
  openChromeMcpTab,
  resetChromeMcpSessionsForTest,
  setChromeMcpSessionFactoryForTest,
} from "./chrome-mcp.js";
import { BrowserCdpEndpointBlockedError } from "./errors.js";

type ToolCall = {
  name: string;
  arguments?: Record<string, unknown>;
};

type FakePage = {
  id: number;
  nativeTargetId: string;
  url: string;
};

function createSerialLock() {
  let tail = Promise.resolve();
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    const current = tail.then(operation);
    tail = current.then(
      () => undefined,
      () => undefined,
    );
    return await current;
  };
}

function createMarkerSession(options: { existingPage?: boolean; navigateError?: Error } = {}) {
  const pages: FakePage[] =
    options.existingPage === false
      ? []
      : [{ id: 1, nativeTargetId: "NATIVE-EXISTING", url: "about:blank" }];
  const events: string[] = [];
  const readUrl = (value: unknown) => (typeof value === "string" ? value : "");
  const callTool = vi.fn(async (call: ToolCall) => {
    if (call.name === "new_page") {
      const url = readUrl(call.arguments?.url);
      const page = {
        id: pages.length + 1,
        nativeTargetId: `NATIVE-${pages.length + 1}`,
        url,
      };
      pages.push(page);
      events.push(`new:${url}`);
      return {
        structuredContent: {
          pages: [{ id: page.id, url: page.url, selected: true }],
        },
      };
    }
    if (call.name === "navigate_page") {
      if (options.navigateError) {
        throw options.navigateError;
      }
      const page = pages.find((candidate) => candidate.id === call.arguments?.pageId);
      if (!page) {
        throw new Error("unknown page");
      }
      events.push(`navigate:${page.url}`);
      page.url = readUrl(call.arguments?.url);
      return { content: [{ type: "text", text: "navigated" }] };
    }
    if (call.name === "list_pages") {
      return {
        structuredContent: {
          pages: pages.map((page) => ({ id: page.id, url: page.url })),
        },
      };
    }
    if (call.name === "close_page") {
      const pageIndex = pages.findIndex((candidate) => candidate.id === call.arguments?.pageId);
      if (pageIndex < 0) {
        throw new Error("unknown page");
      }
      const [closed] = pages.splice(pageIndex, 1);
      events.push(`close:${closed?.url ?? ""}`);
      return { content: [{ type: "text", text: "closed" }] };
    }
    throw new Error(`unexpected tool ${call.name}`);
  });
  const session = {
    client: {
      callTool,
      listTools: vi.fn(),
      close: vi.fn(async () => {}),
      connect: vi.fn(),
    },
    transport: { pid: 123 },
    ready: Promise.resolve(),
    routing: {
      sessionNonce: "000000000001",
      withOperationLock: createSerialLock(),
      targetIdByPageId: new Map<number, string>(),
      nextTargetHandleId: 1,
      snapshotRefById: new Map(),
      nextSnapshotRefId: 1,
    },
  };
  return { session, pages, events };
}

function ownershipOf(value: unknown): Record<string, unknown> | undefined {
  return (value as { ownership?: Record<string, unknown> }).ownership;
}

function fixtureCdpEndpoint(protocol: "http:" | "ws:", path = ""): string {
  const endpoint = new URL(`${protocol}//127.0.0.1:9222${path}`);
  endpoint.searchParams.set("auth", "fixture-value");
  return endpoint.toString();
}

describe("Chrome MCP durable tab ownership", () => {
  beforeEach(async () => {
    await resetChromeMcpSessionsForTest();
    fetchJsonMock.mockReset();
    fetchOkMock.mockReset().mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await resetChromeMcpSessionsForTest();
  });

  it("captures the uniquely marked native target before final navigation", async () => {
    const { session, pages, events } = createMarkerSession();
    setChromeMcpSessionFactoryForTest(async () => session as never);
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/json/list")) {
        events.push("json-list");
        return pages.map((page) => ({
          id: page.nativeTargetId,
          url: page.url,
          type: "page",
        }));
      }
      if (url.includes("/json/version")) {
        events.push("json-version");
        return {
          webSocketDebuggerUrl: fixtureCdpEndpoint("ws:", "/devtools/browser/BROWSER-ONE"),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const opened = await openChromeMcpTab("chrome-live", "https://example.com/final", {
      cdpUrl: fixtureCdpEndpoint("http:"),
    });

    expect(events[0]).toMatch(/^new:about:blank#openclaw-/);
    expect(events.indexOf("json-list")).toBeLessThan(
      events.findIndex((event) => event.startsWith("navigate:")),
    );
    expect(ownershipOf(opened)).toMatchObject({
      status: "durable",
      nativeTargetId: "NATIVE-2",
      profileFingerprint: expect.stringMatching(/^sha256:/),
      browserInstanceFingerprint: expect.stringMatching(/^sha256:/),
    });
  });

  it("serializes duplicate-destination opens while preserving unique marker mapping", async () => {
    const { session, pages } = createMarkerSession();
    setChromeMcpSessionFactoryForTest(async () => session as never);
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/json/list")) {
        return pages.map((page) => ({
          id: page.nativeTargetId,
          url: page.url,
          type: "page",
        }));
      }
      return {
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/BROWSER-ONE",
      };
    });

    const profile = { cdpUrl: "http://127.0.0.1:9222" };
    const [first, second] = await Promise.all([
      openChromeMcpTab("chrome-live", "https://example.com/same", profile),
      openChromeMcpTab("chrome-live", "https://example.com/same", profile),
    ]);

    expect(ownershipOf(first)?.nativeTargetId).toBe("NATIVE-2");
    expect(ownershipOf(second)?.nativeTargetId).toBe("NATIVE-3");
    const calls = (session.client.callTool as ReturnType<typeof vi.fn>).mock.calls as Array<
      [ToolCall, ...unknown[]]
    >;
    const markerUrls = calls
      .filter(([call]) => call.name === "new_page")
      .map(([call]) => call.arguments?.url);
    expect(new Set(markerUrls).size).toBe(2);
  });

  it("threads CDP policy, signal, and remote HTTP timeout through marker capture", async () => {
    const { session, pages } = createMarkerSession();
    setChromeMcpSessionFactoryForTest(async () => session as never);
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/json/list")) {
        return pages.map((page) => ({
          id: page.nativeTargetId,
          url: page.url,
          type: "page",
        }));
      }
      return {
        webSocketDebuggerUrl: "wss://browser.example/devtools/browser/BROWSER-ONE",
      };
    });
    const controller = new AbortController();
    const cdpPolicy = {
      dangerouslyAllowPrivateNetwork: false,
      hostnameAllowlist: ["browser.example"],
    };
    const operationOptions = {
      signal: controller.signal,
      cdpPolicy,
      cdpTimeouts: { httpTimeoutMs: 4321, handshakeTimeoutMs: 8765 },
    } as unknown as Parameters<typeof openChromeMcpTab>[3];

    await openChromeMcpTab(
      "chrome-live",
      "https://example.com",
      { cdpUrl: "https://browser.example" },
      operationOptions,
    );

    const ownershipFetches = fetchJsonMock.mock.calls.filter(([url]) =>
      /\/json\/(?:list|version)/.test(String(url)),
    );
    expect(ownershipFetches).toEqual([
      ["https://browser.example/json/list", 4321, { signal: controller.signal }, cdpPolicy],
      ["https://browser.example/json/version", 4321, { signal: controller.signal }, cdpPolicy],
    ]);
  });

  it("propagates aborts and strict CDP policy failures from marker lookup", async () => {
    const abortedSession = createMarkerSession();
    setChromeMcpSessionFactoryForTest(async () => abortedSession.session as never);
    const controller = new AbortController();
    const abortError = new Error("marker lookup aborted");
    fetchJsonMock.mockImplementationOnce(async () => {
      controller.abort(abortError);
      throw abortError;
    });

    await expect(
      openChromeMcpTab(
        "chrome-live",
        "about:blank",
        { cdpUrl: "http://127.0.0.1:9222" },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("marker lookup aborted");
    expect(abortedSession.pages).toEqual([
      { id: 1, nativeTargetId: "NATIVE-EXISTING", url: "about:blank" },
    ]);
    expect(abortedSession.events.at(-1)).toMatch(/^close:about:blank#openclaw-/);

    await resetChromeMcpSessionsForTest();
    const blockedSession = createMarkerSession();
    setChromeMcpSessionFactoryForTest(async () => blockedSession.session as never);
    const blocked = new BrowserCdpEndpointBlockedError({
      cause: new Error("strict SSRF policy rejected endpoint"),
    });
    fetchJsonMock.mockRejectedValueOnce(blocked);

    await expect(
      openChromeMcpTab("chrome-live", "about:blank", {
        cdpUrl: "http://10.0.0.1:9222",
      }),
    ).rejects.toBe(blocked);
    expect(blockedSession.pages).toEqual([
      { id: 1, nativeTargetId: "NATIVE-EXISTING", url: "about:blank" },
    ]);
  });

  it("opens the first page in an empty explicit-CDP browser", async () => {
    const { session, pages } = createMarkerSession({ existingPage: false });
    setChromeMcpSessionFactoryForTest(async () => session as never);
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/json/list")) {
        return pages.map((page) => ({
          id: page.nativeTargetId,
          url: page.url,
          type: "page",
        }));
      }
      return {
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/BROWSER-ONE",
      };
    });

    const opened = await openChromeMcpTab("chrome-live", "about:blank", {
      cdpUrl: "http://127.0.0.1:9222",
    });

    expect(ownershipOf(opened)).toMatchObject({
      status: "durable",
      nativeTargetId: "NATIVE-1",
    });
    expect(pages).toEqual([{ id: 1, nativeTargetId: "NATIVE-1", url: "about:blank" }]);
  });

  it("rejects an empty auto-connected browser before creating a page", async () => {
    const { session, pages } = createMarkerSession({ existingPage: false });
    setChromeMcpSessionFactoryForTest(async () => session as never);

    await expect(openChromeMcpTab("chrome-live", "about:blank")).rejects.toThrow(
      "without an explicit CDP endpoint",
    );
    expect(pages).toEqual([]);
    const calls = (session.client.callTool as ReturnType<typeof vi.fn>).mock.calls as Array<
      [ToolCall, ...unknown[]]
    >;
    expect(calls.map(([call]) => call.name)).toEqual(["list_pages"]);
  });

  it("rejects and closes a first page without durable browser ownership", async () => {
    const { session, pages } = createMarkerSession({ existingPage: false });
    setChromeMcpSessionFactoryForTest(async () => session as never);
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/json/list")) {
        return pages.map((page) => ({
          id: page.nativeTargetId,
          url: page.url,
          type: "page",
        }));
      }
      return { webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/NATIVE-1" };
    });
    fetchOkMock.mockImplementationOnce(async (url: string) => {
      const nativeTargetId = decodeURIComponent(url.split("/").at(-1) ?? "");
      const index = pages.findIndex((page) => page.nativeTargetId === nativeTargetId);
      if (index >= 0) {
        pages.splice(index, 1);
      }
    });

    await expect(
      openChromeMcpTab("chrome-live", "about:blank", {
        cdpUrl: "http://127.0.0.1:9222",
      }),
    ).rejects.toThrow("without durable CDP ownership");
    expect(pages).toEqual([]);
    expect(fetchOkMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9222/json/close/NATIVE-1",
      undefined,
      undefined,
      undefined,
    );
  });

  it("closes a failed first-page marker through its captured native target", async () => {
    const navigateError = new Error("navigation failed");
    const { session, pages } = createMarkerSession({ existingPage: false, navigateError });
    setChromeMcpSessionFactoryForTest(async () => session as never);
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/json/list")) {
        return pages.map((page) => ({
          id: page.nativeTargetId,
          url: page.url,
          type: "page",
        }));
      }
      return {
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/BROWSER-ONE",
      };
    });
    fetchOkMock.mockImplementationOnce(async (url: string) => {
      const nativeTargetId = decodeURIComponent(url.split("/").at(-1) ?? "");
      const index = pages.findIndex((page) => page.nativeTargetId === nativeTargetId);
      if (index >= 0) {
        pages.splice(index, 1);
      }
    });

    await expect(
      openChromeMcpTab("chrome-live", "https://example.com", {
        cdpUrl: "http://127.0.0.1:9222",
      }),
    ).rejects.toBe(navigateError);
    expect(pages).toEqual([]);
    expect(fetchOkMock).toHaveBeenCalledWith(
      "http://127.0.0.1:9222/json/close/NATIVE-1",
      undefined,
      undefined,
      undefined,
    );
    const calls = (session.client.callTool as ReturnType<typeof vi.fn>).mock.calls as Array<
      [ToolCall, ...unknown[]]
    >;
    expect(calls.map(([call]) => call.name)).not.toContain("close_page");
  });

  it("classifies marker lookup network failures separately from ambiguous matches", async () => {
    const { session } = createMarkerSession();
    setChromeMcpSessionFactoryForTest(async () => session as never);
    fetchJsonMock.mockRejectedValueOnce(new Error("marker lookup timed out"));

    const opened = await openChromeMcpTab("chrome-live", "about:blank", {
      cdpUrl: "https://browser.example",
    });

    expect(ownershipOf(opened)).toEqual({
      status: "non-durable",
      reason: "target-marker-lookup-failed",
    });
  });

  it("classifies malformed marker lookup payloads as lookup failures", async () => {
    const { session } = createMarkerSession();
    setChromeMcpSessionFactoryForTest(async () => session as never);
    fetchJsonMock.mockResolvedValueOnce({ targets: "not-an-array" });

    const opened = await openChromeMcpTab("chrome-live", "about:blank", {
      cdpUrl: "https://browser.example",
    });

    expect(ownershipOf(opened)).toEqual({
      status: "non-durable",
      reason: "target-marker-lookup-failed",
    });
  });

  it("classifies malformed marker list entries as lookup failures", async () => {
    const { session } = createMarkerSession();
    setChromeMcpSessionFactoryForTest(async () => session as never);
    fetchJsonMock.mockResolvedValueOnce([null, undefined, "not-a-target"]);

    const opened = await openChromeMcpTab("chrome-live", "about:blank", {
      cdpUrl: "https://browser.example",
    });

    expect(ownershipOf(opened)).toEqual({
      status: "non-durable",
      reason: "target-marker-lookup-failed",
    });
  });

  it.each([
    { label: "no marker match", matches: [] },
    {
      label: "multiple marker matches",
      matches: [
        { id: "NATIVE-A", type: "page" },
        { id: "NATIVE-B", type: "page" },
      ],
    },
  ])("returns non-durable ownership for $label", async ({ matches }) => {
    const { session } = createMarkerSession();
    setChromeMcpSessionFactoryForTest(async () => session as never);
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/json/list")) {
        const calls = (session.client.callTool as ReturnType<typeof vi.fn>).mock.calls as Array<
          [ToolCall, ...unknown[]]
        >;
        const markerValue = calls.find(([call]) => call.name === "new_page")?.[0].arguments?.url;
        const marker = typeof markerValue === "string" ? markerValue : "";
        return matches.map((entry) => ({ ...entry, url: marker }));
      }
      return {
        webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/BROWSER-ONE",
      };
    });

    const opened = await openChromeMcpTab("chrome-live", "https://example.com/final", {
      cdpUrl: "http://127.0.0.1:9222",
    });

    expect(ownershipOf(opened)).toEqual({
      status: "non-durable",
      reason: "target-marker-not-unique",
    });
  });

  it("does not claim durable ownership for auto-connect or missing browser identity", async () => {
    const autoConnectSession = createMarkerSession();
    setChromeMcpSessionFactoryForTest(async () => autoConnectSession.session as never);

    const autoConnected = await openChromeMcpTab("chrome-live", "about:blank");

    expect(ownershipOf(autoConnected)).toEqual({
      status: "non-durable",
      reason: "explicit-cdp-url-required",
    });
    expect(fetchJsonMock).not.toHaveBeenCalled();

    await resetChromeMcpSessionsForTest();
    const endpointSession = createMarkerSession();
    setChromeMcpSessionFactoryForTest(async () => endpointSession.session as never);
    fetchJsonMock.mockImplementation(async (url: string) => {
      if (url.includes("/json/list")) {
        return endpointSession.pages.map((page) => ({
          id: page.nativeTargetId,
          url: page.url,
          type: "page",
        }));
      }
      return { Browser: "Chrome/138" };
    });

    const withoutVersionIdentity = await openChromeMcpTab("chrome-live", "about:blank", {
      cdpUrl: "http://127.0.0.1:9222",
    });

    expect(ownershipOf(withoutVersionIdentity)).toEqual({
      status: "non-durable",
      reason: "browser-identity-unavailable",
    });
  });
});
