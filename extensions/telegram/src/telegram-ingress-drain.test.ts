// Telegram ingress drain adapter: dispatch result propagation.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { describe, expect, it } from "vitest";
import { createTelegramIngressDrain } from "./telegram-ingress-drain.js";
import type { TelegramSpooledUpdatePayload } from "./telegram-ingress-spool.payload.js";

async function withTempState<T>(fn: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-telegram-ingress-drain-"));
  try {
    return await fn(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

const cfg = {
  channels: {
    telegram: {
      allowFrom: ["111"],
      dmPolicy: "allowlist",
    },
  },
} as OpenClawConfig;

function updatePayload(updateId: number): TelegramSpooledUpdatePayload {
  return {
    version: 1,
    updateId,
    receivedAt: updateId,
    update: {
      update_id: updateId,
      message: {
        text: "hello",
        from: { id: 111 },
        chat: { id: 111, type: "private" },
      },
    },
  };
}

describe("createTelegramIngressDrain", () => {
  it("propagates failed-retryable dispatch results as claim release (not tombstone)", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      await queue.enqueue("1", updatePayload(1), { laneKey: "dm:111" });

      const retryError = new Error("provider blip");
      const drain = createTelegramIngressDrain({
        queue,
        cfg,
        accountId: "default",
        dispatch: async () => ({ kind: "failed-retryable", error: retryError }),
      });

      await drain.drainOnce();
      await drain.waitForIdle();

      // Failed-retryable must release, not complete — re-enqueue is pending, not tombstone.
      const status = await queue.enqueue("1", updatePayload(1), { laneKey: "dm:111" });
      expect(status.kind).not.toBe("completed");
      expect(status.kind === "accepted" || status.kind === "pending").toBe(true);

      const pending = await queue.listPending({ limit: "all" });
      expect(pending.some((row) => row.id === "1")).toBe(true);

      drain.dispose();
    });
  });

  it("tombstones completed dispatch results", async () => {
    await withTempState(async (stateDir) => {
      const queue = createChannelIngressQueueForTests<TelegramSpooledUpdatePayload>({
        channelId: "telegram",
        accountId: "default",
        stateDir,
      });
      await queue.enqueue("2", updatePayload(2), { laneKey: "dm:111" });

      const drain = createTelegramIngressDrain({
        queue,
        cfg,
        accountId: "default",
        dispatch: async (_update, lifecycle) => {
          await lifecycle.onAdopted();
          return { kind: "completed" };
        },
      });

      await drain.drainOnce();
      await drain.waitForIdle();

      const status = await queue.enqueue("2", updatePayload(2), { laneKey: "dm:111" });
      expect(status.kind).toBe("completed");
      drain.dispose();
    });
  });
});
