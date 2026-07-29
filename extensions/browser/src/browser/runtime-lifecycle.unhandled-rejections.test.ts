// Browser tests cover runtime lifecycle.unhandled rejections plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUnhandledRejectionHandlers, registerUnhandledRejectionHandlerMock, resetHandlers } =
  vi.hoisted(() => {
    let handlers: Array<(reason: unknown) => boolean> = [];
    return {
      getUnhandledRejectionHandlers: () => handlers,
      registerUnhandledRejectionHandlerMock: vi.fn((handler: (reason: unknown) => boolean) => {
        handlers.push(handler);
        return () => {
          handlers = handlers.filter((candidate) => candidate !== handler);
        };
      }),
      resetHandlers: () => {
        handlers = [];
      },
    };
  });

const {
  startTrackedBrowserTabCleanupTimerMock,
  stopKnownBrowserProfilesMock,
  trackedTabCleanupMock,
} = vi.hoisted(() => {
  const trackedTabCleanupMockLocal = vi.fn();
  return {
    startTrackedBrowserTabCleanupTimerMock: vi.fn(() => trackedTabCleanupMockLocal),
    stopKnownBrowserProfilesMock: vi.fn(async () => {}),
    trackedTabCleanupMock: trackedTabCleanupMockLocal,
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  registerUnhandledRejectionHandler: registerUnhandledRejectionHandlerMock,
}));

vi.mock("./server-lifecycle.js", () => ({
  stopKnownBrowserProfiles: stopKnownBrowserProfilesMock,
}));

vi.mock("./session-tab-cleanup.js", () => ({
  startTrackedBrowserTabCleanupTimer: startTrackedBrowserTabCleanupTimerMock,
}));

const { createBrowserRuntimeState, stopBrowserRuntime } = await import("./runtime-lifecycle.js");

beforeEach(() => {
  resetHandlers();
  registerUnhandledRejectionHandlerMock.mockClear();
  startTrackedBrowserTabCleanupTimerMock.mockClear();
  stopKnownBrowserProfilesMock.mockClear();
  trackedTabCleanupMock.mockClear();
});

describe("browser unhandled rejection lifecycle", () => {
  it("matches direct and nested Playwright dialog-race protocol errors", async () => {
    const state = await createBrowserRuntimeState({
      resolved: { profiles: {} } as never,
      port: 18791,
      onWarn: vi.fn(),
    });
    const handler = getUnhandledRejectionHandlers()[0];
    const direct = Object.assign(
      new Error("Protocol error (Page.handleJavaScriptDialog): No dialog is showing"),
      { method: "Page.handleJavaScriptDialog" },
    );
    const nested = new Error("browser action failed", {
      cause: Object.assign(new Error("No dialog is showing"), {
        method: "Page.handleJavaScriptDialog",
      }),
    });
    const wrapped = {
      error: new Error("Protocol error (Dialog.handleJavaScriptDialog): No dialog is showing"),
    };

    expect(handler?.(direct)).toBe(true);
    expect(handler?.(nested)).toBe(true);
    expect(handler?.(wrapped)).toBe(true);
    await stopBrowserRuntime({
      current: state,
      getState: () => state,
      clearState: vi.fn(),
      onWarn: vi.fn(),
    });
  });

  it("keeps non-dialog and non-race Playwright errors unhandled", async () => {
    const state = await createBrowserRuntimeState({
      resolved: { profiles: {} } as never,
      port: 18791,
      onWarn: vi.fn(),
    });
    const handler = getUnhandledRejectionHandlers()[0];
    expect(
      handler?.(Object.assign(new Error("No dialog is showing"), { method: "Page.navigate" })),
    ).toBe(false);
    expect(
      handler?.(new Error("Protocol error (Page.handleJavaScriptDialog): Target closed")),
    ).toBe(false);
    expect(handler?.(new Error("No dialog is showing"))).toBe(false);
    await stopBrowserRuntime({
      current: state,
      getState: () => state,
      clearState: vi.fn(),
      onWarn: vi.fn(),
    });
  });

  it("registers during startup and unregisters during shutdown", async () => {
    stopKnownBrowserProfilesMock.mockImplementationOnce(async () => {
      expect(getUnhandledRejectionHandlers()).toHaveLength(1);
    });
    const state = await createBrowserRuntimeState({
      resolved: { profiles: {} } as never,
      port: 18791,
      onWarn: vi.fn(),
    });

    expect(registerUnhandledRejectionHandlerMock).toHaveBeenCalledTimes(1);
    expect(getUnhandledRejectionHandlers()).toHaveLength(1);
    expect(
      getUnhandledRejectionHandlers()[0]?.(
        new Error("Protocol error (Page.handleJavaScriptDialog): No dialog is showing"),
      ),
    ).toBe(true);

    const clearState = vi.fn();
    await stopBrowserRuntime({
      current: state,
      getState: () => state,
      clearState,
      onWarn: vi.fn(),
    });

    expect(trackedTabCleanupMock).toHaveBeenCalledTimes(1);
    expect(stopKnownBrowserProfilesMock).toHaveBeenCalledTimes(1);
    expect(clearState).toHaveBeenCalledTimes(1);
    expect(getUnhandledRejectionHandlers()).toStrictEqual([]);
  });

  it("drains profiles when a custom tab-cleanup disposer throws synchronously", async () => {
    let releaseProfiles!: () => void;
    const profileGate = new Promise<void>((resolve) => {
      releaseProfiles = resolve;
    });
    let profilesDrained = false;
    stopKnownBrowserProfilesMock.mockImplementationOnce(async () => {
      await profileGate;
      profilesDrained = true;
    });
    const state = {
      port: 18_791,
      resolved: { profiles: {} },
      profiles: new Map(),
      stopTrackedTabCleanup: () => {
        throw new Error("tab cleanup failed");
      },
    } as never;
    const clearState = vi.fn();

    const stopping = stopBrowserRuntime({
      current: state,
      getState: () => state,
      clearState,
      onWarn: vi.fn(),
    });
    await Promise.resolve();
    expect(profilesDrained).toBe(false);
    releaseProfiles();

    await expect(stopping).rejects.toThrow("tab cleanup failed");
    expect(profilesDrained).toBe(true);
    expect(clearState).not.toHaveBeenCalled();
  });
});
