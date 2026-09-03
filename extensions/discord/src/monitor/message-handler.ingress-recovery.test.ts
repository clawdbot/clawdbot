// Discord tests cover durable retry recovery through full handler replacement.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { APIMessage } from "discord-api-types/v10";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import {
  type ChannelIngressQueue,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
} from "openclaw/plugin-sdk/channel-outbound";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createDiscordIngressMonitor } from "./ingress.js";
import { createDiscordMessageHandler } from "./message-handler.js";
import { createDiscordHandlerParams } from "./message-handler.test-helpers.js";

type DiscordIngressPayload = {
  version: 1;
  receivedAt: number;
  rawMessage: APIMessage;
};

type DiscordQueue = ChannelIngressQueue<DiscordIngressPayload>;

function rawMessage(id: string, channelId = "lane-a"): APIMessage {
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
    timestamp: new Date(0).toISOString(),
    edited_timestamp: null,
    components: [],
    pinned: false,
    type: 0,
    tts: false,
  } as unknown as APIMessage;
}

async function withQueue(run: (queue: DiscordQueue) => Promise<void>): Promise<void> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-recovery-"));
  const stateDir = await fs.realpath(created);
  const queue = createChannelIngressQueueForTests<DiscordIngressPayload>({
    channelId: "discord",
    accountId: "default",
    stateDir,
  });
  try {
    await run(queue);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

async function seedPendingFailure(params: {
  queue: DiscordQueue;
  id: string;
  attempts: number;
  laneKey?: string;
}): Promise<void> {
  await params.queue.enqueue(
    params.id,
    { version: 1, receivedAt: 1, rawMessage: rawMessage(params.id) },
    { laneKey: params.laneKey ?? "channel:lane-a", receivedAt: 1 },
  );
  for (let attempt = 1; attempt <= params.attempts; attempt += 1) {
    const claim = await params.queue.claim(params.id, { ownerId: `seed-${attempt}` });
    if (!claim) {
      throw new Error(`Expected ${params.id} to be claimable for seed attempt ${attempt}`);
    }
    await params.queue.release(claim, {
      lastError: `prior genuine failure ${attempt}`,
      releasedAt: 10 + attempt,
    });
  }
}

async function retryFacts(queue: DiscordQueue, id: string) {
  const record = (await queue.listPending({ limit: "all" })).find((entry) => entry.id === id);
  if (!record) {
    throw new Error(`Expected pending Discord ingress row ${id}`);
  }
  return {
    attempts: record.attempts,
    lastAttemptAt: record.lastAttemptAt,
    lastError: record.lastError,
  };
}

function createHandler(params: {
  queue: DiscordQueue;
  preflight: (input: { data: { message?: { id?: string } } }) => Promise<null>;
  debounceMs?: number;
  beforeDispatch?: () => Promise<void>;
}) {
  const handlerParams = createDiscordHandlerParams();
  handlerParams.cfg.messages = { inbound: { debounceMs: params.debounceMs ?? 0 } };
  return createDiscordMessageHandler({
    ...handlerParams,
    client: {} as never,
    testing: {
      preflightDiscordMessage: params.preflight as never,
      createIngressMonitor: (monitorParams) =>
        createDiscordIngressMonitor({
          ...monitorParams,
          queue: params.queue,
          dispatch: params.beforeDispatch
            ? async (event, lifecycle) => {
                await params.beforeDispatch?.();
                return await monitorParams.dispatch(event, lifecycle);
              }
            : monitorParams.dispatch,
        }),
    },
  });
}

describe("Discord durable ingress replacement recovery", () => {
  it("terminally settles a preexisting exhausted poison row before its follower", async () => {
    await withQueue(async (queue) => {
      await seedPendingFailure({
        queue,
        id: "poison",
        attempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
      });
      await queue.enqueue(
        "follower",
        { version: 1, receivedAt: 2, rawMessage: rawMessage("follower") },
        { laneKey: "channel:lane-a", receivedAt: 2 },
      );
      const dispatched: string[] = [];
      const handler = createHandler({
        queue,
        preflight: vi.fn(async ({ data }) => {
          const id = data.message?.id ?? "unknown";
          dispatched.push(id);
          if (id === "poison") {
            throw new Error("recovered poison failure");
          }
          return null;
        }),
      });
      try {
        await vi.waitFor(async () => {
          await expect(queue.enqueue("poison", {} as DiscordIngressPayload)).resolves.toMatchObject(
            { kind: "failed", record: { reason: "retry-limit-exceeded" } },
          );
          await expect(
            queue.enqueue("follower", {} as DiscordIngressPayload),
          ).resolves.toMatchObject({ kind: "completed" });
        });
        expect(dispatched).toEqual(["poison", "follower"]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        expect(await queue.listClaims()).toEqual([]);
      } finally {
        await handler.deactivate();
      }
    });
  });

  it("preserves retry facts across every Discord cancellation route and replacement", async () => {
    await withQueue(async (queue) => {
      await seedPendingFailure({
        queue,
        id: "poison",
        attempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS - 1,
      });
      await queue.enqueue(
        "follower",
        { version: 1, receivedAt: 2, rawMessage: rawMessage("follower") },
        { laneKey: "channel:lane-a", receivedAt: 2 },
      );
      const expectedFacts = await retryFacts(queue, "poison");

      const dispatchEntered = createDeferred<void>();
      const releaseDispatch = createDeferred<void>();
      const beforeDispatch = async () => {
        dispatchEntered.resolve();
        await releaseDispatch.promise;
      };
      const beforeDispatchPreflight = vi.fn(async () => null);
      const beforeDispatchHandler = createHandler({
        queue,
        preflight: beforeDispatchPreflight,
        beforeDispatch,
      });
      await dispatchEntered.promise;
      const beforeDispatchStop = beforeDispatchHandler.deactivate();
      await Promise.resolve();
      releaseDispatch.resolve();
      await beforeDispatchStop;
      expect(beforeDispatchPreflight).not.toHaveBeenCalled();
      expect(await retryFacts(queue, "poison")).toEqual(expectedFacts);

      const bufferedPreflight = vi.fn(async () => null);
      const bufferedHandler = createHandler({
        queue,
        preflight: bufferedPreflight,
        debounceMs: 60_000,
      });
      await vi.waitFor(async () => expect(await queue.listClaims()).toHaveLength(1));
      await bufferedHandler.deactivate();
      expect(bufferedPreflight).not.toHaveBeenCalled();
      expect(await retryFacts(queue, "poison")).toEqual(expectedFacts);

      const preflightEntered = createDeferred<void>();
      const releasePreflight = createDeferred<void>();
      const activePreflight = vi.fn(async () => {
        preflightEntered.resolve();
        await releasePreflight.promise;
        return null;
      });
      const activeHandler = createHandler({ queue, preflight: activePreflight });
      await preflightEntered.promise;
      const activeStop = activeHandler.deactivate();
      await Promise.resolve();
      releasePreflight.resolve();
      await activeStop;
      expect(activePreflight).toHaveBeenCalledTimes(1);
      expect(await retryFacts(queue, "poison")).toEqual(expectedFacts);

      const finalDispatches: string[] = [];
      const replacement = createHandler({
        queue,
        preflight: vi.fn(async ({ data }) => {
          const id = data.message?.id ?? "unknown";
          finalDispatches.push(id);
          if (id === "poison") {
            throw new Error("final genuine failure");
          }
          return null;
        }),
      });
      try {
        await vi.waitFor(async () => {
          await expect(queue.enqueue("poison", {} as DiscordIngressPayload)).resolves.toMatchObject(
            { kind: "failed", record: { reason: "retry-limit-exceeded" } },
          );
          await expect(
            queue.enqueue("follower", {} as DiscordIngressPayload),
          ).resolves.toMatchObject({ kind: "completed" });
        });
        expect(finalDispatches).toEqual(["poison", "follower"]);
      } finally {
        await replacement.deactivate();
      }
    });
  });
});
