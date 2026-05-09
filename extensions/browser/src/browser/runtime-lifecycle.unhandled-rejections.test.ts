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
  ensureExtensionRelayForProfilesMock,
  getPwAiModuleMock,
  isPwAiLoadedMock,
  startTrackedBrowserTabCleanupTimerMock,
  stopKnownBrowserProfilesMock,
  trackedTabCleanupMock,
} = vi.hoisted(() => {
  const trackedTabCleanupMock = vi.fn();
  return {
    ensureExtensionRelayForProfilesMock: vi.fn(async () => {}),
    getPwAiModuleMock: vi.fn(),
    isPwAiLoadedMock: vi.fn(() => false),
    startTrackedBrowserTabCleanupTimerMock: vi.fn(() => trackedTabCleanupMock),
    stopKnownBrowserProfilesMock: vi.fn(async () => {}),
    trackedTabCleanupMock,
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  registerUnhandledRejectionHandler: registerUnhandledRejectionHandlerMock,
}));

vi.mock("./server-lifecycle.js", () => ({
  ensureExtensionRelayForProfiles: ensureExtensionRelayForProfilesMock,
  stopKnownBrowserProfiles: stopKnownBrowserProfilesMock,
}));

vi.mock("./session-tab-cleanup.js", () => ({
  startTrackedBrowserTabCleanupTimer: startTrackedBrowserTabCleanupTimerMock,
}));

vi.mock("./pw-ai-state.js", () => ({
  isPwAiLoaded: isPwAiLoadedMock,
}));

vi.mock("./pw-ai-module.js", () => ({
  getPwAiModule: getPwAiModuleMock,
}));

const { createBrowserRuntimeState, stopBrowserRuntime } = await import("./runtime-lifecycle.js");
const { isPlaywrightDialogRaceUnhandledRejection } = await import("./unhandled-rejections.js");

beforeEach(() => {
  resetHandlers();
  registerUnhandledRejectionHandlerMock.mockClear();
  ensureExtensionRelayForProfilesMock.mockClear();
  getPwAiModuleMock.mockClear();
  isPwAiLoadedMock.mockReset().mockReturnValue(false);
  startTrackedBrowserTabCleanupTimerMock.mockClear();
  stopKnownBrowserProfilesMock.mockClear();
  trackedTabCleanupMock.mockClear();
});

describe("browser unhandled rejection lifecycle", () => {
  it("matches direct and nested Playwright dialog-race protocol errors", () => {
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

    expect(isPlaywrightDialogRaceUnhandledRejection(direct)).toBe(true);
    expect(isPlaywrightDialogRaceUnhandledRejection(nested)).toBe(true);
    expect(isPlaywrightDialogRaceUnhandledRejection(wrapped)).toBe(true);
  });

  it("keeps non-dialog and non-race Playwright errors unhandled", () => {
    expect(
      isPlaywrightDialogRaceUnhandledRejection(
        Object.assign(new Error("No dialog is showing"), { method: "Page.navigate" }),
      ),
    ).toBe(false);
    expect(
      isPlaywrightDialogRaceUnhandledRejection(
        new Error("Protocol error (Page.handleJavaScriptDialog): Target closed"),
      ),
    ).toBe(false);
    expect(isPlaywrightDialogRaceUnhandledRejection(new Error("No dialog is showing"))).toBe(false);
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
});
