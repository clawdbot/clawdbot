import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveNestedAgentLaneForSession } from "../agents/lanes.js";
import type { OpenClawConfig } from "../config/config.js";
import { markCronJobActive, resetCronActiveJobsForTests } from "../cron/active-jobs.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import type { CommandLaneSnapshot } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { type HeartbeatDeps, runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import {
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  HEARTBEAT_SKIP_LANES_BUSY,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
} from "./heartbeat-wake.js";
import { resetSystemEventsForTest, enqueueSystemEvent } from "./system-events.js";

vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

let previousRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

const noopOutbound = {
  deliveryMode: "direct" as const,
  sendText: async () => ({ channel: "telegram" as const, messageId: "1", chatId: "1" }),
  sendMedia: async () => ({ channel: "telegram" as const, messageId: "1", chatId: "1" }),
};

beforeAll(() => {
  previousRegistry = getActivePluginRegistry();
  const telegramPlugin = createOutboundTestPlugin({ id: "telegram", outbound: noopOutbound });
  const registry = createTestRegistry([
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
  ]);
  setActivePluginRegistry(registry);
});

afterAll(() => {
  if (previousRegistry) {
    setActivePluginRegistry(previousRegistry);
  }
});

beforeEach(() => {
  resetSystemEventsForTest();
  resetCronActiveJobsForTests();
});

function createHeartbeatTelegramConfig(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        heartbeat: { every: "30m" },
        model: { primary: "test/model" },
      },
    },
    channels: {
      telegram: {
        enabled: true,
        token: "fake",
        allowFrom: ["123"],
      },
    },
  } as unknown as OpenClawConfig;
}

async function seedHeartbeatTelegramSession(storePath: string, cfg: OpenClawConfig) {
  return seedMainSessionStore(storePath, cfg, {
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: "123",
  });
}

function createBusyLaneSnapshot(lane: string): CommandLaneSnapshot {
  return {
    lane,
    activeCount: 1,
    queuedCount: 0,
    maxConcurrent: 1,
    draining: false,
    generation: 0,
  };
}

describe("heartbeat runner skips when target session lane is busy", () => {
  it("returns cron-in-progress when cron has an active job", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig();
      await seedHeartbeatTelegramSession(storePath, cfg);
      markCronJobActive("local-model-report");

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: vi.fn((_lane?: string) => 0),
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
        } as HeartbeatDeps,
      });

      expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("returns cron-in-progress when cron lanes have queued work", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig();
      await seedHeartbeatTelegramSession(storePath, cfg);

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: vi.fn((lane?: string) => (lane === CommandLane.Cron ? 1 : 0)),
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
        } as HeartbeatDeps,
      });

      expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("returns lanes-busy for opt-in broader busy-lane checks", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig();
      cfg.agents!.defaults!.heartbeat = { every: "30m", skipWhenBusy: true };
      await seedHeartbeatTelegramSession(storePath, cfg);

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: vi.fn((lane?: string) => (lane === CommandLane.Subagent ? 1 : 0)),
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
        } as HeartbeatDeps,
      });

      expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_LANES_BUSY });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("returns lanes-busy for opt-in work in any session-scoped nested lane", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig();
      cfg.agents!.defaults!.heartbeat = { every: "30m", skipWhenBusy: true };
      await seedHeartbeatTelegramSession(storePath, cfg);
      const nestedSessionLane = resolveNestedAgentLaneForSession("agent:other:telegram:123");

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: vi.fn((_lane?: string) => 0),
          getCommandLaneSnapshots: vi.fn(() => [createBusyLaneSnapshot(nestedSessionLane)]),
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
        } as HeartbeatDeps,
      });

      expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_LANES_BUSY });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("returns requests-in-flight when session lane has queued work", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig();
      const sessionKey = await seedHeartbeatTelegramSession(storePath, cfg);

      enqueueSystemEvent("Exec completed (test-id, code 0) :: test output", {
        sessionKey,
      });

      // main lane idle (0), session lane busy (1)
      const getQueueSize = vi.fn((lane?: string) => {
        if (!lane || lane === "main") {
          return 0;
        }
        if (lane.startsWith("session:")) {
          return 1;
        }
        return 0;
      });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize,
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
        } as HeartbeatDeps,
      });

      expect(result.status).toBe("skipped");
      if (result.status === "skipped") {
        expect(result.reason).toBe(HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT);
      }
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("does not defer on a recent heartbeat ack pending final delivery", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig();
      cfg.session = { store: storePath };
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "heartbeat",
        lastTo: "heartbeat",
        updatedAt: Date.now(),
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "HEARTBEAT_OK",
      });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: vi.fn((_lane?: string) => 0),
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
        } as HeartbeatDeps,
      });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps deferring recent pending delivery when ackMaxChars makes the remainder real content", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig();
      cfg.session = { store: storePath };
      cfg.agents!.defaults!.heartbeat = { every: "30m", ackMaxChars: 0 };
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "heartbeat",
        lastTo: "heartbeat",
        updatedAt: Date.now(),
        pendingFinalDelivery: true,
        pendingFinalDeliveryText: "HEARTBEAT_OK short",
      });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize: vi.fn((_lane?: string) => 0),
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
        } as HeartbeatDeps,
      });

      expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("proceeds normally when session lane is idle", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig();
      await seedHeartbeatTelegramSession(storePath, cfg);

      // Both lanes idle
      const getQueueSize = vi.fn((_lane?: string) => 0);

      replySpy.mockResolvedValue({
        text: "HEARTBEAT_OK",
      });

      const result = await runHeartbeatOnce({
        cfg,
        deps: {
          getQueueSize,
          nowMs: () => Date.now(),
          getReplyFromConfig: replySpy,
        } as HeartbeatDeps,
      });

      expect(replySpy).toHaveBeenCalled();
      expect(result.status).toBe("ran");
    });
  });
});
