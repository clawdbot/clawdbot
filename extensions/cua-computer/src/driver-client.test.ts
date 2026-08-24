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
  getSessionState: vi.fn(async () => ({
    session: "openclaw-test",
    captureScope: "desktop",
    effectiveScope: "desktop",
    desktopUnlocked: true,
  })),
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

import {
  ClickButton,
  createCuaDriver,
  EscalationReason,
  ScrollDirection,
} from "./driver-client.js";

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
      getSessionState: mocks.getSessionState,
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

  it("uses configured creation and fixed window and desktop sessions", async () => {
    const driver = createCuaDriver({ loadSdk: () => sdk as never });

    expect(driver.isAvailable()).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.createConfigured).toHaveBeenCalledWith({
      claudeCodeCompatibility: false,
      authorization,
    });
    expect(mocks.createTrustedSession).toHaveBeenCalledTimes(2);
    for (const [, options] of mocks.createTrustedSession.mock.calls) {
      expect(options).toEqual(
        expect.objectContaining({
          publicSession: expect.stringMatching(/^openclaw-(window|desktop)-/),
          mode: "unrestricted",
          ttlSeconds: authorization.maxSessionTtlSeconds,
          idleTtlSeconds: authorization.maxIdleTtlSeconds,
        }),
      );
    }

    await driver.dispose();
    await driver.dispose();
    expect(mocks.close).toHaveBeenCalledTimes(2);
    expect(mocks.shutdown).toHaveBeenCalledOnce();
  });

  it("starts the fixed desktop capture session once before using driver tools", async () => {
    const driver = createCuaDriver({ loadSdk: () => sdk as never });

    await Promise.all([driver.getDesktopState(), driver.getDesktopState()]);
    const sessionOptions = mocks.createTrustedSession.mock.calls.find(([, options]) =>
      options.publicSession.startsWith("openclaw-desktop-"),
    )?.[1];

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

  it("keeps the window session immutable across desktop actions and escalation", async () => {
    const driver = createCuaDriver({ loadSdk: () => sdk as never });

    await driver.getDesktopState();
    await driver.callTool("list_windows", {});
    await driver.callDesktopTool("get_cursor_position", {});
    await driver.escalateScope(EscalationReason.Other);
    await driver.callTool("list_windows", {});
    const windowOptions = mocks.createTrustedSession.mock.calls.find(([, options]) =>
      options.publicSession.startsWith("openclaw-window-"),
    )?.[1];
    const desktopOptions = mocks.createTrustedSession.mock.calls.find(([, options]) =>
      options.publicSession.startsWith("openclaw-desktop-"),
    )?.[1];
    expect(mocks.startSession).toHaveBeenCalledWith(
      { session: windowOptions.publicSession, captureScope: "window" },
      undefined,
    );
    expect(mocks.startSession).toHaveBeenCalledWith(
      { session: desktopOptions.publicSession, captureScope: "desktop" },
      undefined,
    );
    expect(mocks.callTool).toHaveBeenCalledTimes(3);
    expect(mocks.callTool).toHaveBeenNthCalledWith(
      1,
      "list_windows",
      JSON.stringify({ session: windowOptions.publicSession }),
      undefined,
    );
    expect(mocks.callTool).toHaveBeenCalledWith(
      "get_cursor_position",
      JSON.stringify({ session: desktopOptions.publicSession }),
      undefined,
    );
    expect(mocks.getSessionState).toHaveBeenCalledWith(
      { session: desktopOptions.publicSession },
      undefined,
    );
    expect(mocks.escalateSession).not.toHaveBeenCalled();
    expect(mocks.callTool).toHaveBeenNthCalledWith(
      3,
      "list_windows",
      JSON.stringify({ session: windowOptions.publicSession }),
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
