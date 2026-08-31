// Channels dead-letter command tests exercise the operator-visible recovery path.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChannelIngressQueue } from "../../channels/message/ingress-queue.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import type { RuntimeEnv } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  channelsDeadLettersListCommand,
  channelsDeadLettersResubmitCommand,
} from "./dead-letters.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

async function withTempState(run: (stateDir: string) => Promise<void>): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-channel-dead-letters-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  try {
    await run(stateDir);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  } as unknown as RuntimeEnv;
}

describe("channel dead-letter commands", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    closeOpenClawStateDatabaseForTest();
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  it("lists retained failures as JSON", async () => {
    await withTempState(async () => {
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "telegram",
        accountId: "ops",
      });
      await queue.enqueue("event-1", { text: "recover me" });
      const claim = await queue.claim("event-1", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.fail(claim, { reason: "handler-error", failedAt: 20 });
      const runtime = createRuntime();

      await channelsDeadLettersListCommand(
        { channel: "telegram", account: "ops", json: true },
        runtime,
      );

      const output = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
        deadLetters: Array<{ id: string; payload?: unknown; reason: string }>;
      };
      expect(output.deadLetters).toEqual([
        expect.objectContaining({
          id: "event-1",
          payload: { text: "recover me" },
          reason: "handler-error",
        }),
      ]);
    });
  });

  it("resubmits through the queue API and reports completed events as terminal", async () => {
    await withTempState(async () => {
      const queue = createChannelIngressQueue<{ text: string }>({ channelId: "line" });
      await queue.enqueue("event-1", { text: "once" });
      const claim = await queue.claim("event-1", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.fail(claim, { reason: "handler-error", failedAt: 20 });
      const runtime = createRuntime();

      await channelsDeadLettersResubmitCommand("event-1", { channel: "line" }, runtime);
      const replay = await queue.claimNext({ ownerId: "replay-worker" });
      expect(replay).toMatchObject({ id: "event-1", payload: { text: "once" } });
      if (!replay) {
        throw new Error("Expected a resubmitted ingress event");
      }
      await queue.complete(replay, { completedAt: 40 });

      await expect(
        channelsDeadLettersResubmitCommand("event-1", { channel: "line" }, runtime),
      ).rejects.toThrow("is completed and cannot be resubmitted");
    });
  });

  it("reads the queue of the plugin that owns the channel, not the channel id", async () => {
    await withTempState(async () => {
      // An installed plugin whose package id is not the channel it serves: the runtime
      // stores its rows under the plugin id, so an operator naming the channel must
      // still reach them.
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "@vendor/external-chat-plugin",
            plugin: { id: "external-chat", meta: { aliases: [] } },
            source: "test",
          },
        ]),
      );
      const queue = createChannelIngressQueue<{ text: string }>({
        channelId: "@vendor/external-chat-plugin",
        accountId: "default",
      });
      await queue.enqueue("event-1", { text: "recover me" });
      const claim = await queue.claim("event-1", { ownerId: "worker" });
      if (!claim) {
        throw new Error("Expected a claimed ingress event");
      }
      await queue.fail(claim, { reason: "handler-error", failedAt: 20 });
      const runtime = createRuntime();

      await channelsDeadLettersListCommand({ channel: "external-chat", json: true }, runtime);

      const output = JSON.parse(String(vi.mocked(runtime.log).mock.calls[0]?.[0])) as {
        channelId: string;
        deadLetters: Array<{ id: string }>;
      };
      // The operator asked about the channel, so the report still names the channel.
      expect(output.channelId).toBe("external-chat");
      expect(output.deadLetters).toEqual([expect.objectContaining({ id: "event-1" })]);

      await channelsDeadLettersResubmitCommand("event-1", { channel: "external-chat" }, runtime);
      expect(await queue.claimNext({ ownerId: "replay-worker" })).toMatchObject({
        id: "event-1",
      });
    });
  });
});
