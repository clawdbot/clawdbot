import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  callTool: vi.fn(async () => ({})),
  create: vi.fn(),
  createConfigured: vi.fn(),
  createTrustedSession: vi.fn(),
  endSession: vi.fn(async () => ({})),
  escalateSession: vi.fn(async () => ({
    session: "openclaw-test",
    captureScope: "desktop",
    effectiveScope: "desktop",
    desktopUnlocked: true,
  })),
  getDesktopState: vi.fn(async () => ({})),
  isAvailable: vi.fn(() => true),
  startSession: vi.fn(async () => ({})),
  shutdown: vi.fn(async () => {}),
}));

const sdk = {
  CaptureScope: { Window: "window", Desktop: "desktop" },
  ClickButton: { Left: 0, Right: 1, Middle: 2 },
  CuaDriver: { create: mocks.create, createConfigured: mocks.createConfigured },
  DesktopScope: { Desktop: 0 },
  EscalationReason: { Other: "other" },
  ScrollBy: { Line: 0 },
  ScrollDirection: { Up: 0, Down: 1, Left: 2, Right: 3 },
  SessionPermissionMode: { Unrestricted: "unrestricted" },
  createTrustedSession: mocks.createTrustedSession,
};

import { ClickButton, createCuaDriver, ScrollDirection } from "./driver-client.js";

const authorization = {
  allowedModes: ["unrestricted"],
  compatibilityMode: "unrestricted",
  unrestrictedAcknowledged: true,
  maxSessionTtlSeconds: 3_600n,
  maxIdleTtlSeconds: 300n,
};

describe("CUA Driver direct session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createConfigured.mockReturnValue({
      isAvailable: mocks.isAvailable,
      shutdown: mocks.shutdown,
    });
    mocks.createTrustedSession.mockReturnValue({
      close: mocks.close,
      callTool: mocks.callTool,
      endSession: mocks.endSession,
      escalateSession: mocks.escalateSession,
      getDesktopState: mocks.getDesktopState,
      startSession: mocks.startSession,
    });
  });

  it("matches the installed CUA Driver desktop input enum contract", async () => {
    const driverSdk = await import("@trycua/cua-driver");

    expect(ClickButton).toEqual({
      Left: driverSdk.ClickButton.Left,
      Right: driverSdk.ClickButton.Right,
      Middle: driverSdk.ClickButton.Middle,
    });
    expect(ScrollDirection).toEqual({
      Up: driverSdk.ScrollDirection.Up,
      Down: driverSdk.ScrollDirection.Down,
      Left: driverSdk.ScrollDirection.Left,
      Right: driverSdk.ScrollDirection.Right,
    });
  });

  it("uses configured creation and one fixed trusted OpenClaw session", async () => {
    const driver = createCuaDriver({ loadSdk: () => sdk as never });

    expect(driver.isAvailable()).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.createConfigured).toHaveBeenCalledWith({
      claudeCodeCompatibility: false,
      authorization,
    });
    expect(mocks.createTrustedSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        publicSession: expect.stringMatching(/^openclaw-/),
        mode: "unrestricted",
        ttlSeconds: authorization.maxSessionTtlSeconds,
        idleTtlSeconds: authorization.maxIdleTtlSeconds,
      }),
    );

    await driver.dispose();
    await driver.dispose();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(mocks.shutdown).toHaveBeenCalledOnce();
  });

  it("starts the fixed desktop capture session once before using driver tools", async () => {
    const driver = createCuaDriver({ loadSdk: () => sdk as never });

    await Promise.all([driver.getDesktopState(), driver.getDesktopState()]);
    const sessionOptions = mocks.createTrustedSession.mock.calls[0]?.[1];

    expect(mocks.startSession).toHaveBeenCalledOnce();
    expect(mocks.startSession).toHaveBeenCalledWith(
      {
        session: sessionOptions.publicSession,
        captureScope: "desktop",
      },
      undefined,
    );
    expect(mocks.getDesktopState).toHaveBeenCalledTimes(2);

    await driver.dispose();
    expect(mocks.endSession).toHaveBeenCalledWith({ session: sessionOptions.publicSession });
  });

  it("starts window-scoped generic tools and widens only for an explicit desktop call", async () => {
    const driver = createCuaDriver({ loadSdk: () => sdk as never });

    await driver.callTool("list_windows", {});
    const sessionOptions = mocks.createTrustedSession.mock.calls[0]?.[1];
    expect(mocks.startSession).toHaveBeenCalledWith(
      { session: sessionOptions.publicSession, captureScope: "window" },
      undefined,
    );
    expect(mocks.callTool).toHaveBeenCalledWith(
      "list_windows",
      JSON.stringify({ session: sessionOptions.publicSession }),
      undefined,
    );

    await driver.getDesktopState();
    expect(mocks.escalateSession).toHaveBeenCalledWith(
      {
        session: sessionOptions.publicSession,
        reason: "other",
        detail: "explicit desktop-scope OpenClaw action",
      },
      undefined,
    );
    await driver.dispose();
  });

  it("passes browser tools through the same window-scoped direct SDK session", async () => {
    const driver = createCuaDriver({ loadSdk: () => sdk as never });

    await driver.callTool("browser_navigate", {
      target_id: "target-1",
      tab_id: "tab-1",
      url: "https://example.com/",
    });
    const sessionOptions = mocks.createTrustedSession.mock.calls[0]?.[1];

    expect(mocks.startSession).toHaveBeenCalledWith(
      { session: sessionOptions.publicSession, captureScope: "window" },
      undefined,
    );
    expect(mocks.callTool).toHaveBeenCalledWith(
      "browser_navigate",
      JSON.stringify({
        target_id: "target-1",
        tab_id: "tab-1",
        url: "https://example.com/",
        session: sessionOptions.publicSession,
      }),
      undefined,
    );
    await driver.dispose();
  });

  it("keeps a missing native desktop library behind command availability", async () => {
    const loadSdk = vi.fn(() => {
      throw new Error("libX11.so.6: cannot open shared object file");
    });
    const driver = createCuaDriver({ loadSdk });

    expect(loadSdk).not.toHaveBeenCalled();
    expect(driver.isAvailable()).toBe(false);
    expect(loadSdk).toHaveBeenCalledOnce();
    await expect(driver.getScreenSize()).rejects.toThrow(
      "COMPUTER_DRIVER_UNAVAILABLE: failed to load CUA Driver SDK: libX11.so.6",
    );

    driver.resetAvailabilityCache();
    expect(driver.isAvailable()).toBe(false);
    expect(loadSdk).toHaveBeenCalledTimes(2);
    await driver.dispose();
  });

  it("loads an ESM driver asynchronously and exposes it on a later availability probe", async () => {
    let resolveSdk: ((value: typeof sdk) => void) | undefined;
    const sdkPromise = new Promise<typeof sdk>((resolve) => {
      resolveSdk = resolve;
    });
    const loadSdk = vi.fn(() => sdkPromise as never);
    const driver = createCuaDriver({ loadSdk });

    expect(driver.isAvailable()).toBe(false);
    expect(loadSdk).toHaveBeenCalledOnce();

    resolveSdk?.(sdk);
    await vi.waitFor(() => expect(driver.isAvailable()).toBe(true));
    await driver.getDesktopState();

    expect(loadSdk).toHaveBeenCalledOnce();
    expect(mocks.createConfigured).toHaveBeenCalledOnce();
    expect(mocks.getDesktopState).toHaveBeenCalledOnce();
    await driver.dispose();
  });

  it("retries an asynchronous ESM import failure after the availability cache resets", async () => {
    let attempt = 0;
    const loadSdk = vi.fn(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("native module is temporarily unavailable"))
        : Promise.resolve(sdk as never);
    });
    const driver = createCuaDriver({ loadSdk });

    expect(driver.isAvailable()).toBe(false);
    await expect(driver.getDesktopState()).rejects.toThrow(
      "COMPUTER_DRIVER_UNAVAILABLE: failed to load CUA Driver SDK: native module is temporarily unavailable",
    );

    driver.resetAvailabilityCache();
    expect(driver.isAvailable()).toBe(false);
    await vi.waitFor(() => expect(driver.isAvailable()).toBe(true));

    expect(loadSdk).toHaveBeenCalledTimes(2);
    await driver.dispose();
  });
});
