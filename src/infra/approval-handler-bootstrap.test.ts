import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeChannel } from "../plugins/runtime/runtime-channel.js";
import { startChannelApprovalHandlerBootstrap } from "./approval-handler-bootstrap.js";
import { createApprovalNativeRuntimeAdapterStubs } from "./approval-handler.test-helpers.js";
import { ExecApprovalChannelRuntimeTerminalStartError } from "./exec-approval-channel-runtime.js";

const { createChannelApprovalHandlerFromCapability } = vi.hoisted(() => ({
  createChannelApprovalHandlerFromCapability: vi.fn(),
}));

vi.mock("./approval-handler-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./approval-handler-runtime.js")>(
    "./approval-handler-runtime.js",
  );
  return {
    ...actual,
    createChannelApprovalHandlerFromCapability,
  };
});

describe("startChannelApprovalHandlerBootstrap", () => {
  beforeEach(() => {
    createChannelApprovalHandlerFromCapability.mockReset();
    vi.useRealTimers();
  });

  const flushTransitions = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  const createApprovalPlugin = () =>
    ({
      id: "slack",
      meta: { label: "Slack" },
      approvalCapability: {
        nativeRuntime: createApprovalNativeRuntimeAdapterStubs(),
      },
    }) as never;

  const startTestBootstrap = (params: {
    channelRuntime: ReturnType<typeof createRuntimeChannel>;
    logger?: unknown;
  }) =>
    startChannelApprovalHandlerBootstrap({
      plugin: createApprovalPlugin(),
      cfg: {} as never,
      accountId: "default",
      channelRuntime: params.channelRuntime,
      logger: params.logger as never,
    });

  const registerApprovalContext = (
    channelRuntime: ReturnType<typeof createRuntimeChannel>,
    app: unknown = { ok: true },
  ) =>
    channelRuntime.runtimeContexts.register({
      channelId: "slack",
      accountId: "default",
      capability: "approval.native",
      context: { app },
    });

  it("starts and stops the shared approval handler from runtime context registration", async () => {
    const channelRuntime = createRuntimeChannel();
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    createChannelApprovalHandlerFromCapability.mockResolvedValue({
      start,
      stop,
    });

    const cleanup = await startTestBootstrap({ channelRuntime });

    const lease = registerApprovalContext(channelRuntime);
    await flushTransitions();

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);

    lease.dispose();
    await flushTransitions();

    expect(stop).toHaveBeenCalledTimes(1);

    await cleanup();
  });

  it("starts immediately when the runtime context was already registered", async () => {
    const channelRuntime = createRuntimeChannel();
    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    createChannelApprovalHandlerFromCapability.mockResolvedValue({
      start,
      stop,
    });

    const lease = registerApprovalContext(channelRuntime);

    const cleanup = await startTestBootstrap({ channelRuntime });
    await flushTransitions();

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);

    await cleanup();
    expect(stop).toHaveBeenCalledTimes(1);
    lease.dispose();
  });

  it("does not block bootstrap return on an existing runtime context", async () => {
    const channelRuntime = createRuntimeChannel();
    createChannelApprovalHandlerFromCapability.mockReturnValue(new Promise(() => {}));
    registerApprovalContext(channelRuntime);

    const result = await Promise.race([
      startTestBootstrap({ channelRuntime }).then((cleanup) => ({ cleanup })),
      new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50)),
    ]);

    expect(result).not.toBe("timeout");
    if (result !== "timeout") {
      await result.cleanup();
    }
  });

  it("does not start a handler after the runtime context is unregistered mid-boot", async () => {
    const channelRuntime = createRuntimeChannel();
    let resolveRuntime:
      | ((value: { start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }) => void)
      | undefined;
    const runtimePromise = new Promise<{
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
    }>((resolve) => {
      resolveRuntime = resolve;
    });
    createChannelApprovalHandlerFromCapability.mockReturnValue(runtimePromise);

    const cleanup = await startTestBootstrap({ channelRuntime });

    const lease = registerApprovalContext(channelRuntime);
    await flushTransitions();

    const start = vi.fn().mockResolvedValue(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);

    lease.dispose();
    resolveRuntime?.({ start, stop });
    await flushTransitions();

    expect(start).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);

    await cleanup();
  });

  it("restarts the shared approval handler when the runtime context is replaced", async () => {
    const channelRuntime = createRuntimeChannel();
    const startFirst = vi.fn().mockResolvedValue(undefined);
    const stopFirst = vi.fn().mockResolvedValue(undefined);
    const startSecond = vi.fn().mockResolvedValue(undefined);
    const stopSecond = vi.fn().mockResolvedValue(undefined);
    createChannelApprovalHandlerFromCapability
      .mockResolvedValueOnce({
        start: startFirst,
        stop: stopFirst,
      })
      .mockResolvedValueOnce({
        start: startSecond,
        stop: stopSecond,
      });

    const cleanup = await startTestBootstrap({ channelRuntime });

    const firstLease = registerApprovalContext(channelRuntime, { ok: "first" });
    await flushTransitions();

    const secondLease = registerApprovalContext(channelRuntime, { ok: "second" });
    await flushTransitions();

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledTimes(2);
    expect(startFirst).toHaveBeenCalledTimes(1);
    expect(stopFirst).toHaveBeenCalledTimes(1);
    expect(startSecond).toHaveBeenCalledTimes(1);

    secondLease.dispose();
    await flushTransitions();

    expect(stopSecond).toHaveBeenCalledTimes(1);

    firstLease.dispose();
    await cleanup();
  });

  it("retries registered-context startup failures until the handler starts", async () => {
    vi.useFakeTimers();
    const channelRuntime = createRuntimeChannel();
    const start = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      isVerboseEnabled: vi.fn().mockReturnValue(false),
      verbose: vi.fn(),
    };
    createChannelApprovalHandlerFromCapability
      .mockResolvedValueOnce({ start, stop })
      .mockResolvedValueOnce({ start, stop });

    const cleanup = await startTestBootstrap({ channelRuntime, logger });

    registerApprovalContext(channelRuntime);
    await flushTransitions();

    expect(start).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushTransitions();

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      "failed to start native approval handler: Error: boom",
    );

    await cleanup();
  });

  it("defers retryable gateway readiness startup failures without terminal error logs", async () => {
    vi.useFakeTimers();
    const channelRuntime = createRuntimeChannel();
    const readinessError = new Error("gateway event loop readiness timeout");
    const start = vi.fn().mockRejectedValueOnce(readinessError).mockResolvedValueOnce(undefined);
    const stop = vi.fn().mockResolvedValue(undefined);
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      isVerboseEnabled: vi.fn().mockReturnValue(false),
      verbose: vi.fn(),
    };
    createChannelApprovalHandlerFromCapability
      .mockResolvedValueOnce({ start, stop })
      .mockResolvedValueOnce({ start, stop });

    const cleanup = await startTestBootstrap({ channelRuntime, logger });

    registerApprovalContext(channelRuntime);
    await flushTransitions();

    expect(start).toHaveBeenCalledTimes(1);
    await flushTransitions();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      "native approval handler deferred until gateway readiness recovers: gateway readiness unavailable before approval handler start",
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await flushTransitions();

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledTimes(2);

    await cleanup();
  });

  it("does not retry terminal native approval startup failures", async () => {
    vi.useFakeTimers();
    const channelRuntime = createRuntimeChannel();
    const terminalError = new ExecApprovalChannelRuntimeTerminalStartError({
      code: 1008,
      reason: "pairing required",
      detailCode: "PAIRING_REQUIRED",
    });
    const start = vi.fn().mockRejectedValue(terminalError);
    const stop = vi.fn().mockResolvedValue(undefined);
    const logger = {
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      child: vi.fn(),
      isEnabled: vi.fn().mockReturnValue(true),
      isVerboseEnabled: vi.fn().mockReturnValue(false),
      verbose: vi.fn(),
    };
    createChannelApprovalHandlerFromCapability.mockResolvedValue({ start, stop });

    const cleanup = await startTestBootstrap({ channelRuntime, logger });

    registerApprovalContext(channelRuntime);
    await flushTransitions();
    await vi.advanceTimersByTimeAsync(3_000);
    await flushTransitions();

    expect(createChannelApprovalHandlerFromCapability).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      `native approval handler disabled: ${String(terminalError)}`,
    );

    await cleanup();
  });

  it("does not let a stale retry stop a newer active handler", async () => {
    vi.useFakeTimers();
    const channelRuntime = createRuntimeChannel();
    const firstStart = vi.fn().mockRejectedValueOnce(new Error("boom"));
    const firstStop = vi.fn().mockResolvedValue(undefined);
    const secondStart = vi.fn().mockResolvedValue(undefined);
    const secondStop = vi.fn().mockResolvedValue(undefined);
    createChannelApprovalHandlerFromCapability
      .mockResolvedValueOnce({ start: firstStart, stop: firstStop })
      .mockResolvedValueOnce({ start: secondStart, stop: secondStop })
      .mockResolvedValueOnce({ start: secondStart, stop: secondStop });

    const cleanup = await startTestBootstrap({ channelRuntime });

    registerApprovalContext(channelRuntime, { ok: "first" });
    await flushTransitions();
    expect(firstStart).toHaveBeenCalledTimes(1);

    registerApprovalContext(channelRuntime, { ok: "second" });
    await flushTransitions();
    expect(secondStart).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushTransitions();

    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(secondStart).toHaveBeenCalledTimes(1);
    expect(secondStop).not.toHaveBeenCalled();

    await cleanup();
  });
});
