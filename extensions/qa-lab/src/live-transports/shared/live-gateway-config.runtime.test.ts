import { afterEach, describe, expect, it, vi } from "vitest";
import {
  patchLiveQaGatewayConfig,
  readLiveQaGatewayConfig,
} from "./live-gateway-config.runtime.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("live QA gateway config", () => {
  it("requires both config and hash from config.get", async () => {
    const gateway = { call: vi.fn().mockResolvedValue({ config: {} }) };

    await expect(readLiveQaGatewayConfig(gateway)).rejects.toThrow(
      "requires config.get config and hash",
    );
  });

  it("re-reads the config once after a stale patch", async () => {
    const waitForConfigRestartSettle = vi.fn();
    const call = vi
      .fn()
      .mockResolvedValueOnce({ config: { channels: {} }, hash: "old" })
      .mockRejectedValueOnce(new Error("config changed since last load"))
      .mockResolvedValueOnce({ config: { channels: {} }, hash: "current" })
      .mockResolvedValueOnce({ hash: "applied" })
      .mockResolvedValueOnce({
        hash: "applied",
        configRevisionHash: "applied",
        appliedConfigHash: "applied",
      });

    await patchLiveQaGatewayConfig({
      gateway: { call },
      patch: { channels: { slack: { enabled: true } } },
      replacePaths: ["channels.slack"],
      timeoutMs: 45_000,
      waitForConfigRestartSettle,
    });

    expect(call).toHaveBeenNthCalledWith(
      4,
      "config.patch",
      {
        raw: JSON.stringify({ channels: { slack: { enabled: true } } }, null, 2),
        baseHash: "current",
        replacePaths: ["channels.slack"],
        restartDelayMs: 0,
      },
      { timeoutMs: 60_000 },
    );
    expect(waitForConfigRestartSettle).toHaveBeenCalledWith({
      restartDelayMs: 0,
      timeoutMs: 45_000,
    });
  });

  it("waits for the active Gateway to apply the persisted config revision", async () => {
    vi.useFakeTimers();
    const waitForConfigRestartSettle = vi.fn();
    const call = vi
      .fn()
      .mockResolvedValueOnce({ config: { channels: {} }, hash: "current" })
      .mockResolvedValueOnce({ hash: "next" })
      .mockResolvedValueOnce({
        hash: "next",
        configRevisionHash: "current",
        appliedConfigHash: "current",
      })
      .mockResolvedValueOnce({
        hash: "next",
        configRevisionHash: "next",
        appliedConfigHash: "next",
      });

    const patching = patchLiveQaGatewayConfig({
      gateway: { call },
      patch: { channels: { slack: { enabled: true } } },
      timeoutMs: 45_000,
      waitForConfigRestartSettle,
    });

    await vi.advanceTimersByTimeAsync(250);
    await patching;

    expect(call).toHaveBeenCalledTimes(4);
    expect(waitForConfigRestartSettle).toHaveBeenCalledTimes(1);
  });

  it("does not wait for a no-op config patch", async () => {
    const waitForConfigRestartSettle = vi.fn();
    const call = vi
      .fn()
      .mockResolvedValueOnce({ config: { channels: {} }, hash: "current" })
      .mockResolvedValueOnce({ noop: true });

    await patchLiveQaGatewayConfig({
      gateway: { call },
      patch: { channels: { discord: { enabled: true } } },
      timeoutMs: 45_000,
      waitForConfigRestartSettle,
    });

    expect(waitForConfigRestartSettle).not.toHaveBeenCalled();
  });
});
