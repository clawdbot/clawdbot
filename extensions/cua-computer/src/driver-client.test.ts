import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callTool: vi.fn(async () => ({})),
  click: vi.fn(async () => ({})),
  close: vi.fn(),
  create: vi.fn(),
  createConfigured: vi.fn(),
  createDesktopTarget: vi.fn(({ displayId }: { displayId: string }) => ({
    tag: "Desktop",
    inner: { displayId },
  })),
  createTrustedSession: vi.fn(),
  drag: vi.fn(async () => ({})),
  endSession: vi.fn(async () => ({})),
  escalateSession: vi.fn(async () => ({
    session: "openclaw-test",
    captureScope: "desktop",
    effectiveScope: "desktop",
    desktopUnlocked: true,
  })),
  getCursorPosition: vi.fn(async () => ({})),
  getDesktopState: vi.fn(async () => ({})),
  getSessionState: vi.fn(async () => ({
    session: "openclaw-test",
    captureScope: "desktop",
    effectiveScope: "desktop",
    desktopUnlocked: true,
  })),
  isAvailable: vi.fn(() => true),
  moveCursor: vi.fn(async () => ({})),
  pressKey: vi.fn(async () => ({})),
  scroll: vi.fn(async () => ({})),
  startSession: vi.fn(async () => ({})),
  shutdown: vi.fn(async () => {}),
  typeText: vi.fn(async () => ({})),
}));

const sdk = {
  ActionTarget: { Desktop: { new: mocks.createDesktopTarget } },
  ClickButton: { Left: 0, Right: 1, Middle: 2 },
  CuaDriver: { create: mocks.create, createConfigured: mocks.createConfigured },
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
      callTool: mocks.callTool,
      click: mocks.click,
      close: mocks.close,
      drag: mocks.drag,
      endSession: mocks.endSession,
      escalateSession: mocks.escalateSession,
      getCursorPosition: mocks.getCursorPosition,
      getDesktopState: mocks.getDesktopState,
      getSessionState: mocks.getSessionState,
      moveCursor: mocks.moveCursor,
      pressKey: mocks.pressKey,
      scroll: mocks.scroll,
      startSession: mocks.startSession,
      typeText: mocks.typeText,
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

  it("uses configured creation with one trusted lifecycle session", async () => {
    const driver = createCuaDriver({ loadSdk: () => sdk as never });

    expect(driver.isAvailable()).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.createConfigured).toHaveBeenCalledWith({
      claudeCodeCompatibility: false,
      authorization,
    });
    expect(mocks.createTrustedSession).toHaveBeenCalledOnce();
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

  it("starts the shared lifecycle session once before using driver tools", async () => {
    const driver = createCuaDriver({ loadSdk: () => sdk as never });

    await Promise.all([driver.getDesktopState(), driver.callTool("list_windows", {})]);
    const sessionOptions = mocks.createTrustedSession.mock.calls[0]?.[1];

    expect(mocks.startSession).toHaveBeenCalledOnce();
    expect(mocks.startSession).toHaveBeenCalledWith(
      { session: sessionOptions.publicSession },
      undefined,
    );
    expect(mocks.getDesktopState).toHaveBeenCalledOnce();
    expect(mocks.callTool).toHaveBeenCalledWith(
      "list_windows",
      JSON.stringify({ session: sessionOptions.publicSession }),
      undefined,
    );

    await driver.dispose();
    expect(mocks.endSession).toHaveBeenCalledOnce();
    expect(mocks.endSession).toHaveBeenCalledWith({ session: sessionOptions.publicSession });
  });

  it("targets desktop input while keeping the global cursor read untargeted", async () => {
    const driver = createCuaDriver({ loadSdk: () => sdk as never });

    await driver.click({ x: 20, y: 30, button: ClickButton.Left, count: 1 });
    await driver.drag({ fromX: 1, fromY: 2, toX: 3, toY: 4, durationMs: 5n });
    await driver.moveCursor({ x: 6, y: 7 });
    await driver.scroll({ x: 8, y: 9, direction: ScrollDirection.Down, amount: 3n });
    await driver.typeText("hello");
    await driver.pressKey({ key: "a", modifiers: ["cmd"] });
    await driver.getCursorPosition();
    await driver.escalateScope(EscalationReason.Other);

    const sessionOptions = mocks.createTrustedSession.mock.calls[0]?.[1];
    const target = { tag: "Desktop", inner: { displayId: "primary" } };
    expect(mocks.createDesktopTarget).toHaveBeenCalledOnce();
    expect(mocks.createDesktopTarget).toHaveBeenCalledWith({ displayId: "primary" });
    expect(mocks.click).toHaveBeenCalledWith(
      { x: 20, y: 30, button: ClickButton.Left, count: 1, target },
      undefined,
    );
    expect(mocks.drag).toHaveBeenCalledWith(
      { fromX: 1, fromY: 2, toX: 3, toY: 4, durationMs: 5n, target },
      undefined,
    );
    expect(mocks.moveCursor).toHaveBeenCalledWith({ x: 6, y: 7, target }, undefined);
    expect(mocks.scroll).toHaveBeenCalledWith(
      {
        x: 8,
        y: 9,
        direction: ScrollDirection.Down,
        amount: 3n,
        by: 0,
        target,
      },
      undefined,
    );
    expect(mocks.typeText).toHaveBeenCalledWith({ text: "hello", target }, undefined);
    expect(mocks.pressKey).toHaveBeenCalledWith(
      { key: "a", modifiers: ["cmd"], target },
      undefined,
    );
    expect(mocks.getCursorPosition).toHaveBeenCalledWith(
      { session: sessionOptions.publicSession },
      undefined,
    );
    expect(mocks.getSessionState).toHaveBeenCalledWith(
      { session: sessionOptions.publicSession },
      undefined,
    );
    expect(mocks.escalateSession).not.toHaveBeenCalled();

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
