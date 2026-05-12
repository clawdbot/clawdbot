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

    const { state, remote, fetchMock } = deps.createRemoteRouteHarness();

    const tabs = await remote.listTabs();
    expect(tabs.map((t) => t.targetId)).toEqual(["T1"]);

    const opened = await remote.openTab("http://127.0.0.1:3000");
    expect(opened.targetId).toBe("T2");
    expect(state.profiles.get("remote")?.lastTargetId).toBe("T2");
    expect(createPageViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://1.1.1.1:9222/chrome?token=abc",
      url: "http://127.0.0.1:3000",
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    await remote.closeTab("T1");
    expect(closePageByTargetIdViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: "https://1.1.1.1:9222/chrome?token=abc",
      targetId: "T1",
      ssrfPolicy: { allowPrivateNetwork: true },
    });
    expect(fetchMock).not.toHaveBeenCalled();
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
      ssrfPolicy: { allowPrivateNetwork: true },
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
    state.resolved.profiles.remote = {
      ...state.resolved.profiles.remote,
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
