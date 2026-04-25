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
    expect(labeled).toMatchObject({
      targetId: "B",
      suggestedTargetId: "docs",
      tabId: "t2",
      label: "docs",
    });

    await remote.focusTab("docs");
    expect(focusPageByTargetIdViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({ targetId: "B" }),
    );
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

    await expect(remote.listTabs()).rejects.toMatchObject({
      name: "BrowserCdpEndpointBlockedError",
      status: 400,
    });
    await expect(remote.focusTab("T1")).rejects.toMatchObject({
      name: "BrowserCdpEndpointBlockedError",
      status: 400,
    });
    await expect(remote.closeTab("T1")).rejects.toMatchObject({
      name: "BrowserCdpEndpointBlockedError",
      status: 400,
    });
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
