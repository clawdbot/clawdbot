import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from "openclaw/plugin-sdk/approval-handler-adapter-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { msteamsPlugin } from "./channel.js";

const monitorMSTeamsProviderMock = vi.hoisted(() => vi.fn());

vi.mock("./index.js", () => ({
  monitorMSTeamsProvider: monitorMSTeamsProviderMock,
}));

describe("msteams approval runtime startup", () => {
  afterEach(() => {
    monitorMSTeamsProviderMock.mockReset();
  });

  it("registers before monitor startup only when native delivery is enabled", async () => {
    monitorMSTeamsProviderMock.mockResolvedValue({ app: null, shutdown: async () => {} });
    const register = vi.fn(() => ({ dispose: vi.fn() }));
    const controller = new AbortController();
    const cfg: OpenClawConfig = {
      approvals: { exec: { enabled: true } },
      channels: {
        msteams: {
          appId: "app-id",
          appPassword: "secret",
          tenantId: "tenant-id",
          allowFrom: ["40a1a0ed-4ff2-4164-a219-55518990c197"],
        },
      },
    };
    const startAccount = async (config: OpenClawConfig) =>
      await msteamsPlugin.gateway?.startAccount?.({
        cfg: config,
        accountId: "default",
        account: msteamsPlugin.config.resolveAccount(config, "default"),
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        abortSignal: controller.signal,
        getStatus: () => ({ accountId: "default" }),
        setStatus: vi.fn(),
        channelRuntime: {
          runtimeContexts: {
            register,
            get: () => undefined,
            watch: () => () => {},
          },
        },
      });

    try {
      await startAccount(cfg);

      expect(register).toHaveBeenCalledWith({
        channelId: "msteams",
        accountId: "default",
        capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
        context: {},
        abortSignal: controller.signal,
      });
      expect(register.mock.invocationCallOrder[0]).toBeLessThan(
        monitorMSTeamsProviderMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );

      await startAccount({ ...cfg, approvals: { exec: { enabled: false } } });

      expect(register).toHaveBeenCalledOnce();
      expect(monitorMSTeamsProviderMock).toHaveBeenCalledTimes(2);
    } finally {
      controller.abort();
    }
  });
});
