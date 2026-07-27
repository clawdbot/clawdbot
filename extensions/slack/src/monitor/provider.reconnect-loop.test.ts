// Slack tests cover provider reconnect loop behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSlackClient, getSlackTestState, resetSlackTestState } from "../monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./provider.js");
const slackTestState = getSlackTestState();

describe("slack socket reconnect loop", () => {
  beforeEach(() => {
    resetSlackTestState();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    ["network error", () => new Error("ECONNRESET")],
    [
      "Slack Web API request error",
      () =>
        Object.assign(new Error("Slack Web API request error"), {
          code: "slack_webapi_request_error",
          original: new Error("ECONNRESET"),
        }),
    ],
    [
      "Slack Web API HTTP error",
      () =>
        Object.assign(new Error("Slack Web API HTTP error"), {
          code: "slack_webapi_http_error",
          statusCode: 503,
          statusMessage: "Service Unavailable",
        }),
    ],
  ])(
    "continues after thirteen consecutive recoverable %s failures",
    async (_label, createError) => {
      const controller = new AbortController();
      const runtimeError = vi.fn();
      let attempts = 0;
      slackTestState.appStartMock.mockImplementation(async () => {
        attempts += 1;
        if (attempts <= 13) {
          throw createError();
        }
        controller.abort();
      });

      const run = monitorSlackProvider({
        botToken: "bot-token",
        appToken: "app-token",
        abortSignal: controller.signal,
        config: slackTestState.config,
        runtime: {
          log: vi.fn(),
          error: runtimeError,
          exit: vi.fn(),
        },
      });

      await vi.runAllTimersAsync();
      await expect(run).resolves.toBeUndefined();

      expect(slackTestState.appStartMock).toHaveBeenCalledTimes(14);
      expect(runtimeError).toHaveBeenCalledWith(expect.stringContaining("retry 13/∞"));
    },
  );

  it("includes the configured Socket Mode logger context in start retry diagnostics", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const controller = new AbortController();
    const runtimeError = vi.fn();
    let attempts = 0;
    slackTestState.appStartMock.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        slackTestState.socketModeLogger?.error("failed to retrieve WSS URL", {
          data: { error: "missing_scope", needed: "connections:write" },
        });
        throw new Error();
      }
      controller.abort();
    });

    const run = monitorSlackProvider({
      botToken: "bot-token",
      appToken: "app-token",
      abortSignal: controller.signal,
      config: slackTestState.config,
      runtime: {
        log: vi.fn(),
        error: runtimeError,
        exit: vi.fn(),
      },
    });

    await vi.runAllTimersAsync();
    await expect(run).resolves.toBeUndefined();

    expect(runtimeError).toHaveBeenCalledWith(
      expect.stringContaining(
        "last SDK log: socket-mode:socket-mode failed to retrieve WSS URL slack error: missing_scope; needed: connections:write",
      ),
    );
  });

  it("keeps degraded identity health after a recoverable reconnect", async () => {
    getSlackClient().auth.test.mockResolvedValueOnce({
      app_id: "A1",
      user_id: "UUSER",
      team_id: "T1",
      is_enterprise_install: false,
    });
    const controller = new AbortController();
    const setStatus = vi.fn();
    let attempts = 0;
    let resolveSecondStart: (() => void) | undefined;
    const secondStart = new Promise<void>((resolve) => {
      resolveSecondStart = resolve;
    });
    slackTestState.appStartMock.mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("ECONNRESET");
      }
      resolveSecondStart?.();
    });

    const run = monitorSlackProvider({
      botToken: "bot",
      appToken: "app",
      abortSignal: controller.signal,
      config: slackTestState.config,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
      },
      setStatus,
    });

    await vi.runOnlyPendingTimersAsync();
    await secondStart;
    await Promise.resolve();
    await Promise.resolve();

    expect(setStatus).toHaveBeenCalledWith({
      connected: true,
      lastConnectedAt: expect.any(Number),
      healthState: "degraded",
      lastError: expect.stringContaining("without bot_id"),
    });
    controller.abort();
    await expect(run).resolves.toBeUndefined();
  });
});
