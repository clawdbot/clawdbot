import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PageState } from "./pw-session-contracts.js";

const stateMocks = vi.hoisted(() => ({
  ensurePageState: vi.fn(),
  getPageForTargetId: vi.fn(),
  devices: {
    "iPhone 14": {
      userAgent: "iphone-14-user-agent",
      viewport: { width: 390, height: 664 },
      screen: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      defaultBrowserType: "webkit",
    },
    "Desktop Chrome": {
      userAgent: "desktop-chrome-user-agent",
      viewport: { width: 1280, height: 720 },
      screen: { width: 1920, height: 1080 },
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
      defaultBrowserType: "chromium",
    },
    "iPhone 14 landscape": {
      userAgent: "iphone-14-user-agent",
      viewport: { width: 750, height: 340 },
      screen: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      defaultBrowserType: "webkit",
    },
  },
}));

vi.mock("./playwright-core.runtime.js", () => ({
  getPlaywrightCore: () => ({ devices: stateMocks.devices }),
}));

vi.mock("./pw-session.js", () => ({
  ensurePageState: stateMocks.ensurePageState,
  getPageForTargetId: stateMocks.getPageForTargetId,
}));

import {
  setDeviceViaPlaywright,
  setLocaleViaPlaywright,
  setTimezoneViaPlaywright,
} from "./pw-tools-core.state.js";

function createPage() {
  const send = vi.fn(async (_method: string, _params?: Record<string, unknown>) => ({}));
  const detach = vi.fn(async () => {});
  const newCDPSession = vi.fn(async () => ({ send, detach }));
  let viewport: { width: number; height: number } | null = null;
  const setViewportSize = vi.fn(async (value: { width: number; height: number }) => {
    viewport = value;
  });
  const page = {
    context: () => ({ newCDPSession }),
    setViewportSize,
    viewportSize: () => viewport,
  };
  return { page, send, detach, newCDPSession, setViewportSize };
}

describe("setDeviceViaPlaywright", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateMocks.ensurePageState.mockReturnValue({});
  });

  it("keeps one page-scoped CDP session attached for persistent emulation", async () => {
    const fixture = createPage();
    stateMocks.getPageForTargetId.mockResolvedValue(fixture.page);

    await setTimezoneViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      timezoneId: "America/New_York",
    });
    await setLocaleViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      locale: "en-GB",
    });

    expect(fixture.newCDPSession).toHaveBeenCalledTimes(1);
    expect(fixture.detach).not.toHaveBeenCalled();
    expect(fixture.send.mock.calls).toEqual([
      ["Emulation.setTimezoneOverride", { timezoneId: "America/New_York" }],
      ["Emulation.setLocaleOverride", { locale: "en-GB" }],
    ]);
  });

  it("fully replaces iPhone 14 emulation with Desktop Chrome", async () => {
    const fixture = createPage();
    stateMocks.getPageForTargetId.mockResolvedValue(fixture.page);

    await setDeviceViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      name: "iPhone 14",
    });
    await setDeviceViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      name: "Desktop Chrome",
    });

    expect(fixture.setViewportSize.mock.calls).toEqual([
      [{ width: 390, height: 664 }],
      [{ width: 1280, height: 720 }],
    ]);
    expect(fixture.send.mock.calls).toEqual([
      ["Emulation.setUserAgentOverride", { userAgent: "iphone-14-user-agent" }],
      [
        "Emulation.setDeviceMetricsOverride",
        {
          mobile: true,
          width: 390,
          height: 664,
          deviceScaleFactor: 3,
          screenWidth: 390,
          screenHeight: 844,
          screenOrientation: { angle: 0, type: "portraitPrimary" },
        },
      ],
      ["Emulation.setTouchEmulationEnabled", { enabled: true }],
      ["Emulation.clearDeviceMetricsOverride"],
      ["Emulation.setUserAgentOverride", { userAgent: "desktop-chrome-user-agent" }],
      [
        "Emulation.setDeviceMetricsOverride",
        {
          mobile: false,
          width: 1280,
          height: 720,
          deviceScaleFactor: 1,
          screenWidth: 1920,
          screenHeight: 1080,
          screenOrientation: { angle: 0, type: "landscapePrimary" },
        },
      ],
      ["Emulation.setTouchEmulationEnabled", { enabled: false }],
    ]);
    expect(fixture.newCDPSession).toHaveBeenCalledTimes(1);
    expect(fixture.detach).not.toHaveBeenCalled();
  });

  it("derives mobile orientation from the effective screen instead of the viewport", async () => {
    const fixture = createPage();
    stateMocks.getPageForTargetId.mockResolvedValue(fixture.page);

    await setDeviceViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      name: "iPhone 14 landscape",
    });

    expect(fixture.send).toHaveBeenNthCalledWith(2, "Emulation.setDeviceMetricsOverride", {
      mobile: true,
      width: 750,
      height: 340,
      deviceScaleFactor: 3,
      screenWidth: 390,
      screenHeight: 844,
      screenOrientation: { angle: 0, type: "portraitPrimary" },
    });
  });

  it("keeps the successful Playwright viewport when a later device override fails", async () => {
    const fixture = createPage();
    const state: Partial<PageState> = {};
    stateMocks.ensurePageState.mockReturnValue(state);
    stateMocks.getPageForTargetId.mockResolvedValue(fixture.page);
    const target = { cdpUrl: "http://127.0.0.1:9222", targetId: "tab-1" };
    await setDeviceViaPlaywright({ ...target, name: "iPhone 14" });
    fixture.send.mockImplementation(async (method) => {
      if (method === "Emulation.setDeviceMetricsOverride") {
        throw new Error("metrics override failed");
      }
      return {};
    });

    await expect(setDeviceViaPlaywright({ ...target, name: "Desktop Chrome" })).rejects.toThrow(
      "metrics override failed",
    );

    expect(fixture.page.viewportSize()).toEqual({ width: 1280, height: 720 });
    expect(state.emulation?.metricsOwner).toBeUndefined();
    expect(state.emulation?.touch?.enabled).toBe(true);
  });

  it("serializes overlapping descriptor transitions on the same page", async () => {
    let releaseFirstUserAgent!: () => void;
    const firstUserAgentBlocked = new Promise<void>((resolve) => {
      releaseFirstUserAgent = resolve;
    });
    const fixture = createPage();
    fixture.send.mockImplementation(async (method, params) => {
      if (
        method === "Emulation.setUserAgentOverride" &&
        params?.userAgent === "iphone-14-user-agent"
      ) {
        await firstUserAgentBlocked;
      }
      return {};
    });
    stateMocks.getPageForTargetId.mockResolvedValue(fixture.page);

    const phone = setDeviceViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      name: "iPhone 14",
    });
    await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(1));
    const desktop = setDeviceViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      name: "Desktop Chrome",
    });

    await Promise.resolve();
    const viewportCallsWhileFirstDescriptorBlocked = fixture.setViewportSize.mock.calls.length;
    const cdpCallsWhileFirstDescriptorBlocked = fixture.send.mock.calls.length;

    releaseFirstUserAgent();
    await Promise.all([phone, desktop]);
    expect(viewportCallsWhileFirstDescriptorBlocked).toBe(1);
    expect(cdpCallsWhileFirstDescriptorBlocked).toBe(1);
    expect(fixture.send.mock.calls.map(([method]) => method)).toEqual([
      "Emulation.setUserAgentOverride",
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
      "Emulation.clearDeviceMetricsOverride",
      "Emulation.setUserAgentOverride",
      "Emulation.setDeviceMetricsOverride",
      "Emulation.setTouchEmulationEnabled",
    ]);
  });

  it("skips an aborted descriptor while it is waiting for the page", async () => {
    let releaseFirstUserAgent!: () => void;
    const firstUserAgentBlocked = new Promise<void>((resolve) => {
      releaseFirstUserAgent = resolve;
    });
    const fixture = createPage();
    fixture.send.mockImplementation(async (method, params) => {
      if (
        method === "Emulation.setUserAgentOverride" &&
        params?.userAgent === "iphone-14-user-agent"
      ) {
        await firstUserAgentBlocked;
      }
      return {};
    });
    stateMocks.getPageForTargetId.mockResolvedValue(fixture.page);

    const phone = setDeviceViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      name: "iPhone 14",
    });
    await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledTimes(1));
    const controller = new AbortController();
    const desktop = setDeviceViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
      name: "Desktop Chrome",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(stateMocks.ensurePageState).toHaveBeenCalledTimes(2));
    controller.abort(new Error("request closed"));

    releaseFirstUserAgent();
    await phone;
    await expect(desktop).rejects.toThrow("request closed");
    expect(fixture.setViewportSize).toHaveBeenCalledTimes(1);
    expect(fixture.send).toHaveBeenCalledTimes(3);
  });
});
