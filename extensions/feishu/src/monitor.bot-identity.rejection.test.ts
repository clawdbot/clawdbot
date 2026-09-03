import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime-api.js";
import { startBotIdentityRecovery } from "./monitor.bot-identity.js";

const fetchBotIdentityForMonitorMock = vi.hoisted(() => vi.fn());
const setFeishuBotIdentityStateMock = vi.hoisted(() => vi.fn());

vi.mock("./monitor.startup.js", () => ({
  fetchBotIdentityForMonitor: fetchBotIdentityForMonitorMock,
}));

vi.mock("./monitor.state.js", () => ({
  setFeishuBotIdentityState: setFeishuBotIdentityStateMock,
}));

beforeEach(() => {
  vi.useFakeTimers();
  fetchBotIdentityForMonitorMock.mockReset();
  setFeishuBotIdentityStateMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Feishu bot identity retry failures", () => {
  it("reports a rejected background retry without leaking an unhandled rejection", async () => {
    fetchBotIdentityForMonitorMock.mockRejectedValueOnce(new Error("probe exploded"));
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } satisfies RuntimeEnv;
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      startBotIdentityRecovery({
        account: {
          accountId: "person-2",
          appId: "cli_person_2",
          appSecret: "secret_person_2", // pragma: allowlist secret
        } as never,
        accountId: "person-2",
        runtime,
      });

      await vi.advanceTimersByTimeAsync(60_000);
      const nextTurn = new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      await vi.advanceTimersByTimeAsync(0);
      await nextTurn;

      expect(fetchBotIdentityForMonitorMock).toHaveBeenCalledTimes(1);
      expect(runtime.error).toHaveBeenCalledTimes(1);
      expect(runtime.error).toHaveBeenCalledWith(
        "feishu[person-2]: bot identity background retry failed unexpectedly: Error: probe exploded",
      );
      expect(setFeishuBotIdentityStateMock).not.toHaveBeenCalled();
      expect(unhandled).toStrictEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("stops an aborted retry without probing or reporting an error", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    } satisfies RuntimeEnv;
    const controller = new AbortController();

    startBotIdentityRecovery({
      account: {
        accountId: "person-2",
        appId: "cli_person_2",
        appSecret: "secret_person_2", // pragma: allowlist secret
      } as never,
      accountId: "person-2",
      runtime,
      abortSignal: controller.signal,
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchBotIdentityForMonitorMock).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(setFeishuBotIdentityStateMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
