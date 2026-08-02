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

vi.mock("@trycua/cua-driver", () => ({
  CaptureScope: { Desktop: "desktop" },
  ClickButton: { Left: 0, Right: 1, Middle: 2 },
  CuaDriver: { create: mocks.create, createConfigured: mocks.createConfigured },
  DesktopScope: { Desktop: 0 },
  ScrollBy: { Line: 0 },
  ScrollDirection: { Up: 0, Down: 1, Left: 2, Right: 3 },
  SessionPermissionMode: { Unrestricted: "unrestricted" },
  createTrustedSession: mocks.createTrustedSession,
}));

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
    const driver = createCuaDriver();

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
    const driver = createCuaDriver();
    const sessionOptions = mocks.createTrustedSession.mock.calls[0]?.[1];

    await Promise.all([driver.getDesktopState(), driver.getDesktopState()]);

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
});
