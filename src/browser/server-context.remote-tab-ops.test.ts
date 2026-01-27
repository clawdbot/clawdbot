import { describe, expect, it, vi } from "vitest";

import type { BrowserServerState } from "./server-context.js";

vi.mock("./chrome.js", () => ({
  isChromeCdpReady: vi.fn(async () => true),
  isChromeReachable: vi.fn(async () => true),
  launchClawdChrome: vi.fn(async () => {
    throw new Error("unexpected launch");
  }),
  resolveClawdUserDataDir: vi.fn(() => "/tmp/clawd"),
  stopClawdChrome: vi.fn(async () => {}),
}));

function makeState(
  profile: "remote" | "clawd",
): BrowserServerState & { profiles: Map<string, { lastTargetId?: string | null }> } {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: test stub
    server: null as any,
    port: 0,
    resolved: {
      enabled: true,
      controlPort: 18791,
      cdpProtocol: profile === "remote" ? "https" : "http",
      cdpHost: profile === "remote" ? "browserless.example" : "127.0.0.1",
      cdpIsLoopback: profile !== "remote",
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      color: "#FF4500",
      headless: true,
      noSandbox: false,
      attachOnly: false,
      defaultProfile: profile,
      profiles: {
        remote: {
          cdpUrl: "https://browserless.example/chrome?token=abc",
          cdpPort: 443,
          color: "#00AA00",
        },
        clawd: { cdpPort: 18800, color: "#FF4500" },
      },
    },
    profiles: new Map(),
  };
}

describe("browser server-context remote profile tab operations", () => {
  it("uses Playwright tab operations when available", async () => {
    vi.resetModules();
    const listPagesViaPlaywright = vi.fn(async () => [
      { targetId: "T1", title: "Tab 1", url: "https://a.example", type: "page" },
    ]);
    const createPageViaPlaywright = vi.fn(async () => ({
      targetId: "T2",
      title: "Tab 2",
      url: "https://b.example",
      type: "page",
    }));
    const closePageByTargetIdViaPlaywright = vi.fn(async () => {});

    vi.doMock("./pw-ai.js", () => ({
      listPagesViaPlaywright,
      createPageViaPlaywright,
      closePageByTargetIdViaPlaywright,
    }));

    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });
    // @ts-expect-error test override
    global.fetch = fetchMock;

    const { createBrowserRouteContext } = await import("./server-context.js");
    const state = makeState("remote");
    const ctx = createBrowserRouteContext({ getState: () => state });
    const remote = ctx.forProfile("remote");

    const tabs = await remote.listTabs();
    expect(tabs.map((t) => t.targetId)).toEqual(["T1"]);

    const opened = await remote.openTab("https://b.example");
    expect(opened.targetId).toBe("T2");
    expect(state.profiles.get("remote")?.lastTargetId).toBe("T2");

    await remote.closeTab("T1");
    expect(closePageByTargetIdViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://browserless.example/chrome?token=abc",
      targetId: "T1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("prefers lastTargetId for remote profiles when targetId is omitted", async () => {
    vi.resetModules();
    const responses = [
      // ensureTabAvailable() calls listTabs twice
      [
        { targetId: "A", title: "A", url: "https://a.example", type: "page" },
        { targetId: "B", title: "B", url: "https://b.example", type: "page" },
      ],
      [
        { targetId: "A", title: "A", url: "https://a.example", type: "page" },
        { targetId: "B", title: "B", url: "https://b.example", type: "page" },
      ],
      // second ensureTabAvailable() calls listTabs twice, order flips
      [
        { targetId: "B", title: "B", url: "https://b.example", type: "page" },
        { targetId: "A", title: "A", url: "https://a.example", type: "page" },
      ],
      [
        { targetId: "B", title: "B", url: "https://b.example", type: "page" },
        { targetId: "A", title: "A", url: "https://a.example", type: "page" },
      ],
    ];

    const listPagesViaPlaywright = vi.fn(async () => {
      const next = responses.shift();
      if (!next) throw new Error("no more responses");
      return next;
    });

    vi.doMock("./pw-ai.js", () => ({
      listPagesViaPlaywright,
      createPageViaPlaywright: vi.fn(async () => {
        throw new Error("unexpected create");
      }),
      closePageByTargetIdViaPlaywright: vi.fn(async () => {
        throw new Error("unexpected close");
      }),
    }));

    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });
    // @ts-expect-error test override
    global.fetch = fetchMock;

    const { createBrowserRouteContext } = await import("./server-context.js");
    const state = makeState("remote");
    const ctx = createBrowserRouteContext({ getState: () => state });
    const remote = ctx.forProfile("remote");

    const first = await remote.ensureTabAvailable();
    expect(first.targetId).toBe("A");
    const second = await remote.ensureTabAvailable();
    expect(second.targetId).toBe("A");
  });

  it("uses Playwright focus for remote profiles when available", async () => {
    vi.resetModules();
    const listPagesViaPlaywright = vi.fn(async () => [
      { targetId: "T1", title: "Tab 1", url: "https://a.example", type: "page" },
    ]);
    const focusPageByTargetIdViaPlaywright = vi.fn(async () => {});

    vi.doMock("./pw-ai.js", () => ({
      listPagesViaPlaywright,
      focusPageByTargetIdViaPlaywright,
    }));

    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });
    // @ts-expect-error test override
    global.fetch = fetchMock;

    const { createBrowserRouteContext } = await import("./server-context.js");
    const state = makeState("remote");
    const ctx = createBrowserRouteContext({ getState: () => state });
    const remote = ctx.forProfile("remote");

    await remote.focusTab("T1");
    expect(focusPageByTargetIdViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://browserless.example/chrome?token=abc",
      targetId: "T1",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.profiles.get("remote")?.lastTargetId).toBe("T1");
  });

  it("does not swallow Playwright runtime errors for remote profiles", async () => {
    vi.resetModules();
    vi.doMock("./pw-ai.js", () => ({
      listPagesViaPlaywright: vi.fn(async () => {
        throw new Error("boom");
      }),
    }));

    const fetchMock = vi.fn(async () => {
      throw new Error("unexpected fetch");
    });
    // @ts-expect-error test override
    global.fetch = fetchMock;

    const { createBrowserRouteContext } = await import("./server-context.js");
    const state = makeState("remote");
    const ctx = createBrowserRouteContext({ getState: () => state });
    const remote = ctx.forProfile("remote");

    await expect(remote.listTabs()).rejects.toThrow(/boom/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to /json/list when Playwright is not available", async () => {
    vi.resetModules();
    vi.doMock("./pw-ai.js", () => ({
      listPagesViaPlaywright: undefined,
      createPageViaPlaywright: undefined,
      closePageByTargetIdViaPlaywright: undefined,
    }));

    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (!u.includes("/json/list")) throw new Error(`unexpected fetch: ${u}`);
      return {
        ok: true,
        json: async () => [
          {
            id: "T1",
            title: "Tab 1",
            url: "https://a.example",
            webSocketDebuggerUrl: "wss://browserless.example/devtools/page/T1",
            type: "page",
          },
        ],
      } as unknown as Response;
    });
    // @ts-expect-error test override
    global.fetch = fetchMock;

    const { createBrowserRouteContext } = await import("./server-context.js");
    const state = makeState("remote");
    const ctx = createBrowserRouteContext({ getState: () => state });
    const remote = ctx.forProfile("remote");

    const tabs = await remote.listTabs();
    expect(tabs.map((t) => t.targetId)).toEqual(["T1"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("browser server-context tab selection state", () => {
  it("updates lastTargetId when openTab is created via CDP", async () => {
    vi.resetModules();
    vi.doUnmock("./pw-ai.js");
    vi.doMock("./cdp.js", async () => {
      const actual = await vi.importActual<typeof import("./cdp.js")>("./cdp.js");
      return {
        ...actual,
        createTargetViaCdp: vi.fn(async () => ({ targetId: "CREATED" })),
      };
    });

    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (!u.includes("/json/list")) throw new Error(`unexpected fetch: ${u}`);
      return {
        ok: true,
        json: async () => [
          {
            id: "CREATED",
            title: "New Tab",
            url: "https://created.example",
            webSocketDebuggerUrl: "ws://127.0.0.1/devtools/page/CREATED",
            type: "page",
          },
        ],
      } as unknown as Response;
    });
    // @ts-expect-error test override
    global.fetch = fetchMock;

    const { createBrowserRouteContext } = await import("./server-context.js");
    const state = makeState("clawd");
    const ctx = createBrowserRouteContext({ getState: () => state });
    const clawd = ctx.forProfile("clawd");

    const opened = await clawd.openTab("https://created.example");
    expect(opened.targetId).toBe("CREATED");
    expect(state.profiles.get("clawd")?.lastTargetId).toBe("CREATED");
  });
});
