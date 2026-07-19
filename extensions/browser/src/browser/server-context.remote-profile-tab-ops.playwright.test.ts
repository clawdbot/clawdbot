// Browser tests cover server context.remote profile tab ops.playwright plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  installRemoteProfileTestLifecycle,
  loadRemoteProfileTestDeps,
  type RemoteProfileTestDeps,
} from "./server-context.remote-profile-tab-ops.test-helpers.js";

const deps: RemoteProfileTestDeps = await loadRemoteProfileTestDeps();
installRemoteProfileTestLifecycle(deps);

function page(targetId: string, url = `https://${targetId.toLowerCase()}.example`) {
  return {
    targetId,
    title: targetId === "T1" ? "Tab 1" : targetId,
    url,
    type: "page" as const,
  };
}

async function expectBlockedCdpEndpoint(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect((error as { name?: unknown }).name).toBe("BrowserCdpEndpointBlockedError");
    expect((error as { status?: unknown }).status).toBe(400);
    return;
  }
  throw new Error("expected blocked browser CDP endpoint");
}

const permissiveRemoteCdpPolicy = {
  allowPrivateNetwork: true,
  allowedHostnames: ["1.1.1.1"],
  hostnameAllowlist: ["1.1.1.1"],
};

describe("browser remote profile tab ops via Playwright", () => {
  it("uses Playwright tab operations when available", async () => {
    const listPagesViaPlaywright = vi.fn(async () => [
      { targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" },
    ]);
    const createPageViaPlaywright = vi.fn(async () => ({
      targetId: "T2",
      title: "Tab 2",
      url: "http://127.0.0.1:3000",
      type: "page",
    }));
    const closePageByTargetIdViaPlaywright = vi.fn(async () => {});

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      createPageViaPlaywright,
      closePageByTargetIdViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const fetchMock = vi.fn(async (url: unknown) => {
      expect(String(url)).toContain("/json/version");
      return {
        ok: true,
        json: async () => ({
          webSocketDebuggerUrl:
            "wss://1.1.1.1:9222/devtools/browser/REMOTE-BROWSER?auth=fixture-value",
        }),
      } as unknown as Response;
    });
    const { state, remote } = deps.createRemoteRouteHarness(fetchMock);

    const tabs = await remote.listTabs();
    expect(tabs.map((t) => t.targetId)).toEqual(["T1"]);
    expect(listPagesViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://1.1.1.1:9222/chrome?token=abc",
      ssrfPolicy: permissiveRemoteCdpPolicy,
      timeoutMs: 3000,
    });

    const opened = await remote.openTab("http://127.0.0.1:3000");
    expect(opened.targetId).toBe("T2");
    expect((opened as { ownership?: unknown }).ownership).toMatchObject({
      status: "durable",
      nativeTargetId: "T2",
      profileFingerprint: expect.stringMatching(/^sha256:/),
      browserInstanceFingerprint: expect.stringMatching(/^sha256:/),
    });
    expect(state.profiles.get("remote")?.lastTargetId).toBe("T2");
    expect(createPageViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://1.1.1.1:9222/chrome?token=abc",
      url: "http://127.0.0.1:3000",
      cdpPolicy: permissiveRemoteCdpPolicy,
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    await remote.closeTab("T1");
    expect(closePageByTargetIdViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://1.1.1.1:9222/chrome?token=abc",
      targetId: "T1",
      ssrfPolicy: permissiveRemoteCdpPolicy,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses the remote HTTP timeout for the ownership version probe", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      createPageViaPlaywright: vi.fn(async () => page("T2")),
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);
    const fetchMock = vi.fn(
      async (_url: unknown, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new Error("ownership version probe timed out")),
            { once: true },
          );
        }),
    );
    const { state, remote } = deps.createRemoteRouteHarness(fetchMock);
    state.resolved.remoteCdpTimeoutMs = 25;

    const startedAt = Date.now();
    const opened = await remote.openTab("https://t2.example");

    expect(Date.now() - startedAt).toBeLessThan(700);
    expect((opened as { ownership?: unknown }).ownership).toEqual({
      status: "non-durable",
      reason: "browser-identity-lookup-failed",
    });
  });

  it("propagates caller abort through the ownership version probe", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      createPageViaPlaywright: vi.fn(async () => page("T2")),
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);
    let markProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => {
      markProbeStarted = resolve;
    });
    const cleanupUrls: string[] = [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/json/close/T2")) {
        cleanupUrls.push(String(url));
        return new Response(null, { status: 200 });
      }
      return await new Promise<Response>((_resolve, reject) => {
        markProbeStarted();
        init?.signal?.addEventListener(
          "abort",
          () =>
            reject(
              init.signal?.reason instanceof Error
                ? init.signal.reason
                : new Error("ownership version probe aborted"),
            ),
          { once: true },
        );
      });
    });
    const { remote } = deps.createRemoteRouteHarness(fetchMock);
    const controller = new AbortController();
    const abortError = new Error("caller aborted ownership probe");

    const opening = remote.openTab("https://t2.example", { signal: controller.signal });
    await probeStarted;
    controller.abort(abortError);

    await expect(opening).rejects.toBe(abortError);
    expect(cleanupUrls).toEqual([expect.stringContaining("/json/close/T2")]);
  });

  it("rejects invalid labels before Playwright creates a page", async () => {
    const createPageViaPlaywright = vi.fn(async () => page("NEVER"));
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      createPageViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);
    const { state, remote, fetchMock } = deps.createRemoteRouteHarness();

    await expect(remote.openTab("https://example.com", { label: "not allowed" })).rejects.toThrow(
      /tab label/i,
    );

    expect(createPageViaPlaywright).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.profiles.get("remote")?.tabAliases).toBeUndefined();
  });

  it("assigns stable tab ids and resolves labels", async () => {
    const listPagesViaPlaywright = vi.fn(async () => [
      page("A", "https://example.com"),
      page("B", "https://docs.example.com"),
    ]);
    const focusPageByTargetIdViaPlaywright = vi.fn(async () => {});

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      focusPageByTargetIdViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { remote } = deps.createRemoteRouteHarness();

    const tabs = await remote.listTabs();
    expect(tabs.map((tab) => [tab.targetId, tab.tabId])).toEqual([
      ["A", "t1"],
      ["B", "t2"],
    ]);
    expect(tabs.map((tab) => tab.suggestedTargetId)).toEqual(["t1", "t2"]);

    const labeled = await remote.labelTab("t2", "docs");
    expect(labeled.targetId).toBe("B");
    expect(labeled.suggestedTargetId).toBe("docs");
    expect(labeled.tabId).toBe("t2");
    expect(labeled.label).toBe("docs");

    await remote.focusTab("docs");
    const focusCall = (focusPageByTargetIdViaPlaywright.mock.calls as unknown[][])[0]?.[0] as
      | { targetId?: unknown }
      | undefined;
    expect(focusCall?.targetId).toBe("B");

    await remote.labelTab("t1", "B");
    await expect(remote.focusTab("B")).rejects.toThrow("ambiguous browser tab reference");
    await remote.focusTab("B", { exactTargetId: true });
    const exactFocusCall = (focusPageByTargetIdViaPlaywright.mock.calls as unknown[][])[1]?.[0] as
      | { targetId?: unknown }
      | undefined;
    expect(exactFocusCall?.targetId).toBe("B");
  });

  it("transfers stable aliases across a high-confidence target replacement", async () => {
    let currentPages = [page("A", "https://app.example/form")];
    const listPagesViaPlaywright = vi.fn(async () => currentPages);

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { state, remote } = deps.createRemoteRouteHarness();

    const first = await remote.listTabs();
    expect(first).toHaveLength(1);
    expect(first[0]?.targetId).toBe("A");
    expect(first[0]?.tabId).toBe("t1");
    expect(first[0]?.suggestedTargetId).toBe("t1");
    const labeled = await remote.labelTab("t1", "form");
    expect(labeled.targetId).toBe("A");
    expect(labeled.tabId).toBe("t1");
    expect(labeled.label).toBe("form");
    state.profiles.get("remote")!.lastTargetId = "A";

    currentPages = [page("B", "https://app.example/submitted")];

    const afterSwap = await remote.listTabs();
    expect(afterSwap).toHaveLength(1);
    expect(afterSwap[0]?.targetId).toBe("B");
    expect(afterSwap[0]?.tabId).toBe("t1");
    expect(afterSwap[0]?.suggestedTargetId).toBe("form");
    expect(afterSwap[0]?.label).toBe("form");
    expect(state.profiles.get("remote")?.lastTargetId).toBe("B");
    await expect(remote.ensureTabAvailable("A")).rejects.toThrow(/tab not found/i);
    const formTab = await remote.ensureTabAvailable("form");
    expect(formTab.targetId).toBe("B");
    expect(formTab.tabId).toBe("t1");
    expect(formTab.label).toBe("form");
  });

  it("does not transfer aliases when target replacement is ambiguous", async () => {
    let currentPages = [page("A", "https://a.example"), page("C", "https://c.example")];
    const listPagesViaPlaywright = vi.fn(async () => currentPages);

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { state, remote } = deps.createRemoteRouteHarness();

    const first = await remote.listTabs();
    expect(first.map((tab) => [tab.targetId, tab.tabId])).toEqual([
      ["A", "t1"],
      ["C", "t2"],
    ]);
    state.profiles.get("remote")!.lastTargetId = "A";

    currentPages = [page("B", "https://b.example"), page("D", "https://d.example")];

    const afterSwap = await remote.listTabs();
    expect(afterSwap.map((tab) => [tab.targetId, tab.tabId])).toEqual([
      ["B", "t3"],
      ["D", "t4"],
    ]);
    expect(state.profiles.get("remote")?.lastTargetId).toBe("A");
  });

  it("migrates only unique URL groups alongside ambiguous duplicate groups", async () => {
    let currentPages = [
      page("A", "https://unique.example"),
      page("B", "https://duplicate.example"),
      page("C", "https://duplicate.example"),
    ];
    const listPagesViaPlaywright = vi.fn(async () => currentPages);

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { state, remote } = deps.createRemoteRouteHarness();

    expect((await remote.listTabs()).map((tab) => [tab.targetId, tab.tabId])).toEqual([
      ["A", "t1"],
      ["B", "t2"],
      ["C", "t3"],
    ]);
    await remote.labelTab("t1", "unique");
    state.profiles.get("remote")!.lastTargetId = "A";

    currentPages = [
      page("D", "https://unique.example"),
      page("E", "https://duplicate.example"),
      page("F", "https://duplicate.example"),
    ];

    await expect(remote.listTabs()).resolves.toEqual([
      expect.objectContaining({
        targetId: "D",
        tabId: "t1",
        label: "unique",
        suggestedTargetId: "unique",
      }),
      expect.objectContaining({ targetId: "E", tabId: "t4", suggestedTargetId: "t4" }),
      expect.objectContaining({ targetId: "F", tabId: "t5", suggestedTargetId: "t5" }),
    ]);
    expect(state.profiles.get("remote")?.lastTargetId).toBe("D");
  });

  it("prefers lastTargetId for remote profiles when targetId is omitted", async () => {
    const responses = [
      [
        { targetId: "A", title: "A", url: "https://example.com", type: "page" },
        { targetId: "B", title: "B", url: "https://www.example.com", type: "page" },
      ],
      [
        { targetId: "A", title: "A", url: "https://example.com", type: "page" },
        { targetId: "B", title: "B", url: "https://www.example.com", type: "page" },
      ],
      [
        { targetId: "B", title: "B", url: "https://www.example.com", type: "page" },
        { targetId: "A", title: "A", url: "https://example.com", type: "page" },
      ],
      [
        { targetId: "B", title: "B", url: "https://www.example.com", type: "page" },
        { targetId: "A", title: "A", url: "https://example.com", type: "page" },
      ],
    ];

    const listPagesViaPlaywright = vi.fn(deps.createSequentialPageLister(responses));

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      createPageViaPlaywright: vi.fn(async () => {
        throw new Error("unexpected create");
      }),
      closePageByTargetIdViaPlaywright: vi.fn(async () => {
        throw new Error("unexpected close");
      }),
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { remote } = deps.createRemoteRouteHarness();

    const first = await remote.ensureTabAvailable();
    expect(first.targetId).toBe("A");
    const second = await remote.ensureTabAvailable();
    expect(second.targetId).toBe("A");
  });

  it("opens a real remote Playwright tab when only browser-internal targets are listed", async () => {
    const internalTab = {
      targetId: "OMNI",
      title: "Omnibox Popup",
      url: "chrome://omnibox-popup.top-chrome/",
      type: "page" as const,
    };
    const realTab = {
      targetId: "REAL",
      title: "New Tab",
      url: "about:blank",
      type: "page" as const,
    };
    const listPagesViaPlaywright = vi.fn(
      deps.createSequentialPageLister([[internalTab], [internalTab, realTab]]),
    );
    const createPageViaPlaywright = vi.fn(async () => realTab);

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      createPageViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { state, remote } = deps.createRemoteRouteHarness();

    const selected = await remote.ensureTabAvailable();
    expect(selected.targetId).toBe("REAL");
    expect(state.profiles.get("remote")?.lastTargetId).toBe("REAL");
    expect(createPageViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://1.1.1.1:9222/chrome?token=abc",
      url: "about:blank",
      cdpPolicy: permissiveRemoteCdpPolicy,
      ssrfPolicy: { allowPrivateNetwork: true },
    });
  });

  it("rejects stale targetId for remote profiles even when only one tab remains", async () => {
    const responses = Array.from({ length: 2 }, () => [page("T1", "https://example.com")]);
    const listPagesViaPlaywright = vi.fn(deps.createSequentialPageLister(responses));

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { remote } = deps.createRemoteRouteHarness();
    await expect(remote.ensureTabAvailable("STALE_TARGET")).rejects.toThrow(/tab not found/i);
  });

  it("keeps rejecting stale targetId for remote profiles when multiple tabs exist", async () => {
    const responses = Array.from({ length: 2 }, () => [page("A"), page("B")]);
    const listPagesViaPlaywright = vi.fn(deps.createSequentialPageLister(responses));

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { remote } = deps.createRemoteRouteHarness();
    await expect(remote.ensureTabAvailable("STALE_TARGET")).rejects.toThrow(/tab not found/i);
  });

  it("uses Playwright focus for remote profiles when available", async () => {
    const listPagesViaPlaywright = vi.fn(async () => [
      { targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" },
    ]);
    const focusPageByTargetIdViaPlaywright = vi.fn(async () => {});

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      focusPageByTargetIdViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { state, remote, fetchMock } = deps.createRemoteRouteHarness();

    await remote.focusTab("T1");
    expect(focusPageByTargetIdViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://1.1.1.1:9222/chrome?token=abc",
      targetId: "T1",
      ssrfPolicy: permissiveRemoteCdpPolicy,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.profiles.get("remote")?.lastTargetId).toBe("T1");
  });

  it("blocks remote Playwright tab operations when strict SSRF hostname allowlist rejects the cdpUrl", async () => {
    const listPagesViaPlaywright = vi.fn(async () => [
      { targetId: "T1", title: "Tab 1", url: "https://example.com", type: "page" },
    ]);
    const focusPageByTargetIdViaPlaywright = vi.fn(async () => {});
    const closePageByTargetIdViaPlaywright = vi.fn(async () => {});

    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright,
      focusPageByTargetIdViaPlaywright,
      closePageByTargetIdViaPlaywright,
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const state = deps.makeState("remote");
    state.resolved.ssrfPolicy = {
      dangerouslyAllowPrivateNetwork: false,
      hostnameAllowlist: ["browserless.example.com"],
    };
    const remoteProfile = expectDefined(state.resolved.profiles.remote, "remote browser profile");
    state.resolved.profiles.remote = {
      ...remoteProfile,
      cdpUrl: "http://10.0.0.42:9222",
      cdpPort: 9222,
    };
    const ctx = deps.createBrowserRouteContext({ getState: () => state });
    const remote = ctx.forProfile("remote");

    await expectBlockedCdpEndpoint(remote.listTabs());
    await expectBlockedCdpEndpoint(remote.focusTab("T1"));
    await expectBlockedCdpEndpoint(remote.closeTab("T1"));
    expect(listPagesViaPlaywright).not.toHaveBeenCalled();
    expect(focusPageByTargetIdViaPlaywright).not.toHaveBeenCalled();
    expect(closePageByTargetIdViaPlaywright).not.toHaveBeenCalled();
  });

  it("does not swallow Playwright runtime errors for remote profiles", async () => {
    vi.spyOn(deps.pwAiModule, "getPwAiModule").mockResolvedValue({
      listPagesViaPlaywright: vi.fn(async () => {
        throw new Error("boom");
      }),
    } as unknown as Awaited<ReturnType<typeof deps.pwAiModule.getPwAiModule>>);

    const { remote, fetchMock } = deps.createRemoteRouteHarness();

    await expect(remote.listTabs()).rejects.toThrow(/boom/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
