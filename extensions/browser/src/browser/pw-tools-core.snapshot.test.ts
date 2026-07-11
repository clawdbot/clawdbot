// Browser tests cover pw tools core.snapshot plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getPageForTargetId = vi.fn();
const ensurePageState = vi.fn();
const storeRoleRefsForTarget = vi.fn();
const withPageScopedCdpClient = vi.fn();
const markBackendDomRefsOnPage = vi.fn();
const formatAriaSnapshot = vi.fn();
const gotoPageWithNavigationGuard = vi.fn();
const createDownloadCaptureForPage = vi.fn(() => ({
  armed: true,
  promise: new Promise(() => {}),
  cancel: vi.fn(),
}));

vi.mock("./pw-session.js", () => ({
  assertPageNavigationCompletedSafely: vi.fn(),
  closeBlockedNavigationTarget: vi.fn(),
  ensurePageState,
  forceDisconnectPlaywrightForTarget: vi.fn(),
  getPageForTargetId,
  gotoPageWithNavigationGuard,
  isDownloadStartingNavigationError: vi.fn(() => false),
  isPolicyDenyNavigationError: vi.fn(() => false),
  storeRoleRefsForTarget,
}));

vi.mock("./pw-download-capture.js", () => ({
  createDownloadCaptureForPage,
}));

vi.mock("./pw-session.page-cdp.js", () => ({
  markBackendDomRefsOnPage,
  withPageScopedCdpClient,
}));

vi.mock("./cdp.js", () => ({
  formatAriaSnapshot,
}));

type ScopedCdpClientOptions = {
  cdpUrl?: unknown;
  fn?: unknown;
  page?: unknown;
  targetId?: unknown;
};

function requireScopedCdpClientOptions(): ScopedCdpClientOptions {
  const [call] = withPageScopedCdpClient.mock.calls;
  if (!call) {
    throw new Error("expected scoped CDP client call");
  }
  const [options] = call;
  if (!options || typeof options !== "object") {
    throw new Error("expected scoped CDP client options");
  }
  return options as ScopedCdpClientOptions;
}

describe("pw-tools-core aria snapshot storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reuses the resolved page when storing aria refs", async () => {
    const page = { id: "page-1" };
    const rawNodes = [{ backendDOMNodeId: 42 }];
    const formattedNodes = [{ ref: "ax1", role: "button", name: "OK", backendDOMNodeId: 42 }];

    getPageForTargetId.mockResolvedValue(page);
    withPageScopedCdpClient.mockResolvedValue({ nodes: rawNodes });
    formatAriaSnapshot.mockReturnValue(formattedNodes);
    markBackendDomRefsOnPage.mockResolvedValue(new Set(["ax1"]));

    const mod = await import("./pw-tools-core.snapshot.js");
    const result = await mod.snapshotAriaViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      limit: 5,
    });

    expect(result).toEqual({ nodes: formattedNodes });
    expect(getPageForTargetId).toHaveBeenCalledTimes(1);
    expect(ensurePageState).toHaveBeenCalledWith(page);
    expect(withPageScopedCdpClient).toHaveBeenCalledTimes(1);
    const scopedClientOptions = requireScopedCdpClientOptions();
    expect(scopedClientOptions.cdpUrl).toBe("http://127.0.0.1:9222");
    expect(scopedClientOptions.page).toBe(page);
    expect(scopedClientOptions.targetId).toBe("tab-1");
    expect(typeof scopedClientOptions.fn).toBe("function");
    expect(markBackendDomRefsOnPage).toHaveBeenCalledWith({
      page,
      refs: [{ ref: "ax1", backendDOMNodeId: 42 }],
    });
    expect(storeRoleRefsForTarget).toHaveBeenCalledWith({
      page,
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      refs: {
        ax1: { role: "button", name: "OK", domMarker: true },
      },
      mode: "role",
    });
  });

  it("races snapshotAriaViaPlaywright against an explicit timeoutMs", async () => {
    vi.useFakeTimers();
    try {
      const page = { id: "page-1" };
      getPageForTargetId.mockResolvedValue(page);
      withPageScopedCdpClient.mockImplementation(() => new Promise(() => {}));

      const mod = await import("./pw-tools-core.snapshot.js");
      const promise = mod.snapshotAriaViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        targetId: "tab-1",
        timeoutMs: 750,
      });
      void promise.catch(() => {});

      await vi.advanceTimersByTimeAsync(750);

      await expect(promise).rejects.toThrow(/Aria snapshot via Playwright timed out/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the default aria node limit for non-finite limits", async () => {
    const page = { id: "page-1" };
    const rawNodes = [{ nodeId: "1" }];
    const formattedNodes = [{ ref: "ax1", role: "document", name: "", depth: 0 }];

    getPageForTargetId.mockResolvedValue(page);
    withPageScopedCdpClient.mockResolvedValue({ nodes: rawNodes });
    formatAriaSnapshot.mockReturnValue(formattedNodes);

    const mod = await import("./pw-tools-core.snapshot.js");
    const result = await mod.snapshotAriaViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      limit: Number.NaN,
    });

    expect(result).toEqual({ nodes: formattedNodes });
    expect(formatAriaSnapshot).toHaveBeenCalledWith(rawNodes, 500);
  });

  it("forwards an explicit timeoutMs into the role-aria Playwright ariaSnapshot call", async () => {
    const ariaSnapshotMock = vi.fn().mockResolvedValue("");
    const page = { ariaSnapshot: ariaSnapshotMock };
    getPageForTargetId.mockResolvedValue(page);

    const mod = await import("./pw-tools-core.snapshot.js");
    await mod.snapshotRoleViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      refsMode: "aria",
      timeoutMs: 8888,
    });

    expect(ariaSnapshotMock).toHaveBeenCalledWith({ mode: "ai", timeout: 8888 });
  });

  it("uses the default snapshot timeout for non-finite role-aria timeouts", async () => {
    const ariaSnapshotMock = vi.fn().mockResolvedValue("");
    const page = { ariaSnapshot: ariaSnapshotMock };
    getPageForTargetId.mockResolvedValue(page);

    const mod = await import("./pw-tools-core.snapshot.js");
    await mod.snapshotRoleViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      refsMode: "aria",
      timeoutMs: Number.NaN,
    });

    expect(ariaSnapshotMock).toHaveBeenCalledWith({ mode: "ai", timeout: 5000 });
  });

  it("uses the default snapshot timeout for non-finite ai snapshot timeouts", async () => {
    const ariaSnapshotMock = vi.fn().mockResolvedValue("");
    const page = { ariaSnapshot: ariaSnapshotMock };
    getPageForTargetId.mockResolvedValue(page);

    const mod = await import("./pw-tools-core.snapshot.js");
    await mod.snapshotAiViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      timeoutMs: Number.NaN,
    });

    expect(ariaSnapshotMock).toHaveBeenCalledWith({ mode: "ai", timeout: 5000 });
  });

  it("stores only complete refs after truncating ai snapshots", async () => {
    const first = '- button "Visible" [ref=e1]';
    const second = `- button "Hidden ${"X".repeat(100)} 🙂" [ref=e2]`;
    const marker = "[...TRUNCATED - page too large]";
    const ariaSnapshotMock = vi.fn().mockResolvedValue(`${first}\n${second}`);
    const page = { ariaSnapshot: ariaSnapshotMock };
    getPageForTargetId.mockResolvedValue(page);

    const mod = await import("./pw-tools-core.snapshot.js");
    const result = await mod.snapshotAiViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      maxChars: first.length + 2 + marker.length,
    });

    expect(result.snapshot).toBe(`${first}\n\n${marker}`);
    expect(result.truncated).toBe(true);
    expect(result.refs).toEqual({ e1: { role: "button", name: "Visible" } });
    expect(storeRoleRefsForTarget).toHaveBeenLastCalledWith({
      page,
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      refs: { e1: { role: "button", name: "Visible" } },
      mode: "aria",
    });
  });

  it("caps filtered role snapshots before storing refs", async () => {
    const first = '- button "Visible" [ref=e1]';
    const marker = "[...TRUNCATED - page too large]";
    const ariaSnapshotMock = vi
      .fn()
      .mockResolvedValue(`${first}\n- button "Hidden ${"X".repeat(100)}" [ref=e2]`);
    const page = { ariaSnapshot: ariaSnapshotMock };
    getPageForTargetId.mockResolvedValue(page);

    const mod = await import("./pw-tools-core.snapshot.js");
    const result = await mod.snapshotRoleViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      refsMode: "aria",
      maxChars: first.length + 2 + marker.length,
    });

    expect(result.snapshot).toBe(`${first}\n\n${marker}`);
    expect(result.refs).toEqual({ e1: { role: "button", name: "Visible" } });
    expect(result.stats.refs).toBe(1);
    expect(storeRoleRefsForTarget).toHaveBeenLastCalledWith(
      expect.objectContaining({ refs: { e1: { role: "button", name: "Visible" } } }),
    );
  });

  it("uses the default navigation timeout for non-finite timeouts", async () => {
    const page = { url: vi.fn(() => "http://127.0.0.1:31337/after") };
    getPageForTargetId.mockResolvedValue(page);
    gotoPageWithNavigationGuard.mockResolvedValue(null);

    const mod = await import("./pw-tools-core.snapshot.js");
    const result = await mod.navigateViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      url: "http://127.0.0.1:31337/",
      timeoutMs: Number.NaN,
      ssrfPolicy: { allowPrivateNetwork: true },
    });

    expect(result).toEqual({ url: "http://127.0.0.1:31337/after" });
    expect(gotoPageWithNavigationGuard).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 20_000 }),
    );
  });

  it("clamps non-finite viewport dimensions to the minimum size", async () => {
    const page = { setViewportSize: vi.fn(async () => {}) };
    getPageForTargetId.mockResolvedValue(page);

    const mod = await import("./pw-tools-core.snapshot.js");
    await mod.resizeViewportViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      width: Number.NaN,
      height: Number.POSITIVE_INFINITY,
    });

    expect(page.setViewportSize).toHaveBeenCalledWith({ width: 1, height: 1 });
  });

  it("rejects excessive viewport dimensions before calling Playwright", async () => {
    const page = { setViewportSize: vi.fn(async () => {}) };
    getPageForTargetId.mockResolvedValue(page);

    const mod = await import("./pw-tools-core.snapshot.js");
    await expect(
      mod.resizeViewportViaPlaywright({
        cdpUrl: "http://127.0.0.1:9222",
        targetId: "tab-1",
        width: Number.MAX_SAFE_INTEGER,
        height: 768,
      }),
    ).rejects.toThrow("viewport width exceeds maximum of 8192");

    expect(page.setViewportSize).not.toHaveBeenCalled();
  });

  it("stores role fallback metadata when backend markers are unavailable", async () => {
    const page = { id: "page-1" };
    const mod = await import("./pw-tools-core.snapshot.js");

    getPageForTargetId.mockResolvedValue(page);
    markBackendDomRefsOnPage.mockResolvedValue(new Set());

    await mod.storeAriaSnapshotRefsViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      nodes: [
        { ref: "ax1", role: "Button", name: "OK", backendDOMNodeId: 42, depth: 0 },
        { ref: "ax2", role: "Button", name: "OK", backendDOMNodeId: 84, depth: 0 },
      ],
    });

    expect(storeRoleRefsForTarget).toHaveBeenCalledWith({
      page,
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      refs: {
        ax1: { role: "button", name: "OK" },
        ax2: { role: "button", name: "OK", nth: 1 },
      },
      mode: "role",
    });
  });
});
