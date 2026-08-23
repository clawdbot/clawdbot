import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";

async function withTelegramCrablineTransport(
  run: (transport: Awaited<ReturnType<typeof createQaCrablineTransportAdapter>>) => Promise<void>,
) {
  await withTempDir("qa-crabline-transport-", async (outputDir) => {
    const transport = await createQaCrablineTransportAdapter({
      outputDir,
      selection: {
        capabilityMatrixPath: "crabline-fake-provider-capabilities.json",
        channel: "telegram",
        channelDriver: "crabline",
        smokeArtifactPath: "crabline-fake-provider-smoke.json",
      },
      state: createQaBusState(),
    });
    try {
      await run(transport);
    } finally {
      await transport.cleanup?.();
    }
  });
}

describe("Crabline transport readiness", () => {
  it("waits for the selected account to finish its channel readiness lifecycle", async () => {
    await withTelegramCrablineTransport(async (transport) => {
      const statuses = [
        { accountId: "other", connected: true, lifecycle: "ready", running: true },
        {
          accountId: transport.accountId,
          connected: false,
          lifecycle: "starting",
          running: true,
        },
        {
          accountId: transport.accountId,
          connected: true,
          lifecycle: "starting",
          running: true,
        },
        {
          accountId: transport.accountId,
          connected: true,
          lifecycle: "blocked",
          running: true,
        },
        {
          accountId: transport.accountId,
          connected: true,
          lifecycle: "ready",
          restartPending: false,
          running: true,
        },
      ];
      const call = vi.fn(async () => ({ channelAccounts: { telegram: [statuses.shift()] } }));

      await transport.waitReady({ gateway: { call }, timeoutMs: 2_000, pollIntervalMs: 1 });
      expect(call).toHaveBeenCalledTimes(5);
    });
  });

  it("rejects a ready channel account belonging to another Crabline identity", async () => {
    await withTelegramCrablineTransport(async (transport) => {
      const call = vi.fn().mockResolvedValue({
        channelAccounts: {
          telegram: [{ accountId: "other", connected: true, lifecycle: "ready", running: true }],
        },
      });

      await expect(
        transport.waitReady({ gateway: { call }, timeoutMs: 5, pollIntervalMs: 1 }),
      ).rejects.toThrow('telegram account "default" not reported; available accounts: other');
    });
  });
});
