// Discord tests cover durable gateway-message admission and replay recovery.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChannelType, type APIMessage } from "discord-api-types/v10";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDiscordIngressMonitor, type DiscordIngressLifecycle } from "./ingress.js";

type DiscordTestMessage = APIMessage & { channel_type?: number; guild_id?: string };

type DiscordIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: DiscordTestMessage;
  channelKind?: "non-thread" | "thread";
};

const FROZEN_NOW = Date.parse("2026-08-20T03:00:00.000Z");
const STALE_AT = FROZEN_NOW - 16 * 60 * 1_000;
const BOT_USER_ID = "bot-1";
const GUILD_ID = "guild-1";

function createRawMessage(
  id: string,
  channelId = "channel-1",
  overrides: Partial<DiscordTestMessage> = {},
): DiscordTestMessage {
  return {
    id,
    channel_id: channelId,
    content: "hello",
    author: {
      id: "user-1",
      username: "alice",
      discriminator: "0",
      avatar: null,
    },
    attachments: [],
    embeds: [],
    mentions: [],
    mention_roles: [],
    mention_everyone: false,
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    components: [],
    pinned: false,
    type: 0,
    tts: false,
    ...overrides,
  } as unknown as APIMessage;
}

function runtime(): Pick<RuntimeEnv, "error" | "log"> {
  return { error: vi.fn(), log: vi.fn() };
}

function payloadFor(rawMessage: APIMessage): DiscordIngressPayload {
  return { version: 1, receivedAt: Date.now(), rawMessage };
}

function createPolicyMonitor(params: {
  queue: ChannelIngressQueue<DiscordIngressPayload>;
  dispatch: Parameters<typeof createDiscordIngressMonitor>[0]["dispatch"];
}) {
  return createDiscordIngressMonitor({
    accountId: "default",
    client: {} as never,
    runtime: runtime(),
    queue: params.queue,
    now: () => FROZEN_NOW,
    botUserId: BOT_USER_ID,
    guildEntries: { [GUILD_ID]: {} },
    dispatch: params.dispatch,
  });
}

async function withQueue<T>(
  fn: (queue: ChannelIngressQueue<DiscordIngressPayload>) => Promise<T>,
): Promise<T> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-ingress-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<DiscordIngressPayload>({
    channelId: "discord",
    accountId: "default",
    stateDir,
  });
  try {
    return await fn(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

type DiscordIngressMonitor = ReturnType<typeof createDiscordIngressMonitor>;

async function stopAll(monitors: DiscordIngressMonitor[]): Promise<void> {
  await Promise.allSettled(monitors.map((monitor) => monitor.stop()));
}

describe("Discord durable ingress", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("does not normalize or dispatch before the durable append completes", async () => {
    await withQueue(async (queue) => {
      const appendGate = createDeferred<void>();
      const enqueue = vi.fn(async (...args: Parameters<typeof queue.enqueue>) => {
        await appendGate.promise;
        return await queue.enqueue(...args);
      });
      const gatedQueue: ChannelIngressQueue<DiscordIngressPayload> = { ...queue, enqueue };
      const dispatch = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue: gatedQueue,
        dispatch,
      });
      monitor.start();
      try {
        const accepted = monitor.accept(createRawMessage("1001"));
        await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1));

        expect(dispatch).not.toHaveBeenCalled();

        appendGate.resolve();
        await accepted;
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      } finally {
        await monitor.stop();
      }
    });
  });

  it("rejects unstable message identity before durable allocation", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn();
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue,
        dispatch,
      });
      monitor.start();
      try {
        const missingMessageId = { ...createRawMessage("missing"), id: undefined };
        const missingChannelId = { ...createRawMessage("missing"), channel_id: undefined };

        await expect(monitor.accept(missingMessageId as never)).rejects.toThrow("snowflake");
        await expect(monitor.accept(missingChannelId as never)).rejects.toThrow("channel_id");
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(dispatch).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    });
  });

  it("recovers a claimed row with a fresh drain and dispatches it exactly once", async () => {
    await withQueue(async (queue) => {
      const monitors: DiscordIngressMonitor[] = [];
      const firstDispatch = vi.fn(async () => ({ kind: "deferred" as const }));
      const first = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue,
        dispatch: firstDispatch,
      });
      monitors.push(first);
      first.start();
      try {
        await first.accept(createRawMessage("1002"));
        await vi.waitFor(() => expect(firstDispatch).toHaveBeenCalledTimes(1));
        await first.stop();

        const recoveredDispatch = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
          await lifecycle.onAdopted();
        });
        const recovered = createDiscordIngressMonitor({
          accountId: "default",
          client: {} as never,
          runtime: runtime(),
          queue,
          dispatch: recoveredDispatch,
        });
        monitors.push(recovered);
        recovered.start();

        await vi.waitFor(() => expect(recoveredDispatch).toHaveBeenCalledTimes(1));
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
        expect(recoveredDispatch).toHaveBeenCalledTimes(1);
      } finally {
        await stopAll(monitors);
      }
    });
  });

  it("rejects a duplicate after completion", async () => {
    await withQueue(async (queue) => {
      const dispatch = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue,
        dispatch,
      });
      monitor.start();
      try {
        const rawMessage = createRawMessage("1003");
        await monitor.accept(rawMessage);
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
        await vi.waitFor(async () => {
          const verdict = await queue.enqueue("1003", payloadFor(rawMessage));
          expect(verdict.kind).toBe("completed");
        });

        await monitor.accept(rawMessage);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("matches the old guard for duplicate MESSAGE_CREATE delivery during RESUME", async () => {
    await withQueue(async (queue) => {
      let lifecycle: DiscordIngressLifecycle | undefined;
      const dispatch = vi.fn(async (_event, claimedLifecycle: DiscordIngressLifecycle) => {
        lifecycle = claimedLifecycle;
        return { kind: "deferred" as const };
      });
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue,
        dispatch,
      });
      monitor.start();
      try {
        const replayed = createRawMessage("1004");
        await Promise.all([monitor.accept(replayed), monitor.accept(replayed)]);
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

        await lifecycle?.onAdopted();
        await vi.waitFor(async () => {
          const verdict = await queue.enqueue("1004", payloadFor(replayed));
          expect(verdict.kind).toBe("completed");
        });
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("dead-letters a permanent Discord authentication failure", async () => {
    await withQueue(async (queue) => {
      const monitor = createDiscordIngressMonitor({
        accountId: "default",
        client: {} as never,
        runtime: runtime(),
        queue,
        dispatch: async () => {
          throw Object.assign(new Error("unauthorized"), { status: 401 });
        },
      });
      monitor.start();
      try {
        const rawMessage = createRawMessage("1005");
        await monitor.accept(rawMessage);
        await vi.waitFor(async () => {
          const verdict = await queue.enqueue("1005", payloadFor(rawMessage));
          expect(verdict.kind).toBe("failed");
        });
      } finally {
        await monitor.stop();
      }
    });
  });

  it.each([
    { channelType: ChannelType.GuildText, expected: "non-thread" },
    { channelType: ChannelType.PublicThread, expected: "thread" },
  ])("persists channel kind $expected at durable admission", async ({ channelType, expected }) => {
    await withQueue(async (queue) => {
      const monitor = createPolicyMonitor({ queue, dispatch: vi.fn() });
      try {
        await monitor.accept(
          createRawMessage("kind", "channel-1", {
            guild_id: GUILD_ID,
            channel_type: channelType,
          }),
        );
        expect(await queue.listPending({ limit: "all" })).toMatchObject([
          { id: "kind", payload: { channelKind: expected } },
        ]);
      } finally {
        await monitor.stop();
      }
    });
  });

  it("fences stale ambient backlog before claim and keeps the disposition across restart", async () => {
    await withQueue(async (queue) => {
      const rawMessage = createRawMessage("stale", "channel-1", {
        guild_id: GUILD_ID,
        channel_type: ChannelType.GuildText,
        timestamp: new Date(STALE_AT).toISOString(),
      });
      await queue.enqueue(
        "stale",
        {
          version: 1,
          receivedAt: STALE_AT,
          rawMessage,
          channelKind: "non-thread",
        },
        { laneKey: "channel:channel-1", receivedAt: STALE_AT },
      );
      const firstDispatch = vi.fn();
      const first = createPolicyMonitor({ queue, dispatch: firstDispatch });
      first.start();
      await vi.waitFor(async () => {
        expect(await queue.listFailed?.({ limit: "all" })).toMatchObject([
          { id: "stale", reason: "stale-ambient-backlog" },
        ]);
      });
      await first.stop();

      const replayDispatch = vi.fn();
      const replay = createPolicyMonitor({ queue, dispatch: replayDispatch });
      replay.start();
      try {
        await replay.stop();
        expect(firstDispatch).not.toHaveBeenCalled();
        expect(replayDispatch).not.toHaveBeenCalled();
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
      } finally {
        await replay.stop();
      }
    });
  });

  it.each([
    {
      name: "current ambient work",
      receivedAt: FROZEN_NOW,
      rawMessage: createRawMessage("current", "channel-1", {
        guild_id: GUILD_ID,
        channel_type: ChannelType.GuildText,
        timestamp: new Date(FROZEN_NOW).toISOString(),
      }),
      channelKind: "non-thread" as const,
    },
    {
      name: "direct work",
      receivedAt: STALE_AT,
      rawMessage: createRawMessage("direct", "channel-1", {
        channel_type: ChannelType.DM,
        timestamp: new Date(STALE_AT).toISOString(),
      }),
      channelKind: "non-thread" as const,
    },
    {
      name: "explicitly mentioned work",
      receivedAt: STALE_AT,
      rawMessage: createRawMessage("mentioned", "channel-1", {
        guild_id: GUILD_ID,
        channel_type: ChannelType.GuildText,
        mentions: [
          {
            id: BOT_USER_ID,
            username: "openclaw",
            global_name: null,
            discriminator: "0",
            avatar: null,
          },
        ],
        timestamp: new Date(STALE_AT).toISOString(),
      }),
      channelKind: "non-thread" as const,
    },
    {
      name: "thread work",
      receivedAt: STALE_AT,
      rawMessage: createRawMessage("thread", "channel-1", {
        guild_id: GUILD_ID,
        channel_type: ChannelType.PublicThread,
        timestamp: new Date(STALE_AT).toISOString(),
      }),
      channelKind: "thread" as const,
    },
  ])("keeps $name claimable", async ({ receivedAt, rawMessage, channelKind }) => {
    await withQueue(async (queue) => {
      await queue.enqueue(
        rawMessage.id,
        { version: 1, receivedAt, rawMessage, channelKind },
        { laneKey: `channel:${rawMessage.channel_id}`, receivedAt },
      );
      const dispatch = vi.fn(async (_event, lifecycle: DiscordIngressLifecycle) => {
        await lifecycle.onAdopted();
      });
      const monitor = createPolicyMonitor({ queue, dispatch });
      monitor.start();
      try {
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
        expect(await queue.listFailed?.({ limit: "all" })).toEqual([]);
      } finally {
        await monitor.stop();
      }
    });
  });
});
