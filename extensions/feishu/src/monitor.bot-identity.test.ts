// Feishu tests cover background bot identity recovery behavior.
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

describe("Feishu bot identity recovery", () => {
  it("bypasses cache and stops only after a provider-verified refresh", async () => {
    fetchBotIdentityForMonitorMock
      .mockResolvedValueOnce({ botOpenId: "ou_cached", source: "cache" })
      .mockResolvedValueOnce({
        botOpenId: "ou_provider",
        botName: "OpenClaw QA",
        source: "provider",
      });
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
    } as unknown as RuntimeEnv;

    startBotIdentityRecovery({
      account: {
        accountId: "person-2",
        appId: "cli_person_2",
        appSecret: "secret_person_2", // pragma: allowlist secret
      } as never,
      accountId: "person-2",
      runtime,
      currentSource: "cache",
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchBotIdentityForMonitorMock).toHaveBeenCalledTimes(1);
    expect(fetchBotIdentityForMonitorMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ allowCachedFallback: false }),
    );
    expect(runtime.log).not.toHaveBeenCalledWith(
      expect.stringContaining("recovered via background retry"),
    );
    expect(setFeishuBotIdentityStateMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120_000);
    expect(fetchBotIdentityForMonitorMock).toHaveBeenCalledTimes(2);
    expect(runtime.log).toHaveBeenCalledWith(
      "feishu[person-2]: bot open_id recovered via background retry: ou_provider",
    );
    expect(setFeishuBotIdentityStateMock).toHaveBeenCalledTimes(1);
    expect(setFeishuBotIdentityStateMock).toHaveBeenLastCalledWith("person-2", {
      botOpenId: "ou_provider",
      botName: "OpenClaw QA",
    });
  });
});
