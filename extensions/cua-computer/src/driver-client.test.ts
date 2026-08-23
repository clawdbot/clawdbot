import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  create: vi.fn(),
  createConfigured: vi.fn(),
  createTrustedSession: vi.fn(),
  endSession: vi.fn(async () => ({})),
  getDesktopState: vi.fn(async () => ({})),
  isAvailable: vi.fn(() => true),
  startSession: vi.fn(async () => ({})),
  shutdown: vi.fn(async () => {}),
}));

const sdk = {
  CaptureScope: { Desktop: "desktop" },
  ClickButton: { Left: 0, Right: 1, Middle: 2 },
  CuaDriver: { create: mocks.create, createConfigured: mocks.createConfigured },
  DesktopScope: { Desktop: 0 },
  ScrollBy: { Line: 0 },
  ScrollDirection: { Up: 0, Down: 1, Left: 2, Right: 3 },
  SessionPermissionMode: { Unrestricted: "unrestricted" },
  createTrustedSession: mocks.createTrustedSession,
};

import { createCuaDriver } from "./driver-client.js";

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
      endSession: mocks.endSession,
      getDesktopState: mocks.getDesktopState,
      startSession: mocks.startSession,
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
