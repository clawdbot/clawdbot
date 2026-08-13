// Twitch tests share isolated durable-ingress state and raw chat envelopes.
import fs from "node:fs/promises";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { expect, vi } from "vitest";
import { createTwitchIngress } from "./twitch-ingress.js";
import type { TwitchChatMessage } from "./types.js";

type TwitchIngressTestQueue = NonNullable<Parameters<typeof createTwitchIngress>[0]["queue"]>;
export type TwitchIngressTestPayload = Parameters<TwitchIngressTestQueue["enqueue"]>[1];

export function createTwitchIngressTestMessage(
  params: Partial<TwitchChatMessage> = {},
): TwitchChatMessage {
  return {
    id: params.id ?? "message-1",
    username: params.username ?? "viewer",
    userId: params.userId ?? "viewer-1",
    displayName: params.displayName ?? "Viewer",
    message: params.message ?? "hello bot",
    channel: params.channel ?? "#TestChannel",
    timestamp: params.timestamp ?? 1_721_300_000_000,
    isMod: params.isMod ?? false,
    isOwner: params.isOwner ?? false,
    isVip: params.isVip ?? false,
    isSub: params.isSub ?? false,
    chatType: "group",
  };
}

export async function withTwitchIngressTestQueue<T>(
  fn: (queue: TwitchIngressTestQueue) => Promise<T>,
): Promise<T> {
  const createdDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-twitch-ingress-"),
  );
  const stateDir = await fs.realpath(createdDir);
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const queue = createChannelIngressQueueForTests<TwitchIngressTestPayload>({
    channelId: "twitch",
    accountId: "default",
    stateDir,
  });
  try {
    return await fn(queue);
  } finally {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

export async function waitForTwitchIngressVerdict(
  queue: TwitchIngressTestQueue,
  eventId: string,
  expected: "completed" | "failed",
): Promise<void> {
  await vi.waitFor(
    async () => {
      const verdict = await queue.enqueue(eventId, { version: 1, rawEvent: "{}" });
      expect(verdict.kind).toBe(expected);
    },
    { timeout: 5_000 },
  );
}
