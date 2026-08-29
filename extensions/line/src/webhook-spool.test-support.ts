// Line test helpers shared by the durable spool and upgrade-migration suites.
import fs from "node:fs/promises";
import path from "node:path";
import type { webhook } from "@line/bot-sdk";
import type { ChannelIngressQueue } from "openclaw/plugin-sdk/channel-outbound";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests as createChannelIngressQueue,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { expect, vi } from "vitest";

export type SpoolPayload = {
  version: number;
  rawEvent: string;
  destination: string;
};

/** Row shape written by the pre-drain (#109655) spool worker; only seeded by upgrade tests. */
type LegacySpoolPayload = {
  version: number;
  destination: string;
  event: webhook.Event;
};

export const runtime = (): RuntimeEnv => ({ error: vi.fn(), exit: vi.fn(), log: vi.fn() });

export function createEvent(params: {
  webhookEventId: string;
  messageId?: string;
  userId?: string;
  text?: string;
  /** Marks the event as one part of a LINE multi-image send. */
  imageSet?: { id: string; index: number; total: number };
}): webhook.Event {
  const message: webhook.MessageEvent["message"] = params.imageSet
    ? {
        id: params.messageId ?? `message-${params.webhookEventId}`,
        type: "image",
        contentProvider: { type: "line" },
        imageSet: params.imageSet,
        quoteToken: "test-quote-token-placeholder",
      }
    : {
        id: params.messageId ?? `message-${params.webhookEventId}`,
        type: "text",
        text: params.text ?? "hello",
        quoteToken: "test-quote-token-placeholder",
      };
  const event: webhook.MessageEvent = {
    type: "message",
    message,
    replyToken: "test-reply-token",
    timestamp: Date.now(),
    source: { type: "user", userId: params.userId ?? "user-1" },
    mode: "active",
    webhookEventId: params.webhookEventId,
    deliveryContext: { isRedelivery: false },
  };
  return event;
}

export function callback(event: webhook.Event): webhook.CallbackRequest {
  return { destination: "destination-1", events: [event] };
}

export function payloadFor(event: webhook.Event): SpoolPayload {
  return { version: 1, rawEvent: JSON.stringify(event), destination: "destination-1" };
}

export async function withQueue<T>(
  fn: (
    queue: ChannelIngressQueue<SpoolPayload>,
    legacySeed: ChannelIngressQueue<LegacySpoolPayload>,
  ) => Promise<T>,
): Promise<T> {
  const createdDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-line-spool-"),
  );
  const stateDir = await fs.realpath(createdDir);
  const queue = createChannelIngressQueue<SpoolPayload>({
    channelId: "line",
    accountId: "default",
    stateDir,
  });
  // A second wrapper over the same store, typed as the pre-drain row shape, so
  // upgrade tests can seed legacy rows without casting the canonical queue.
  const legacySeed = createChannelIngressQueue<LegacySpoolPayload>({
    channelId: "line",
    accountId: "default",
    stateDir,
  });
  try {
    return await fn(queue, legacySeed);
  } finally {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}

export async function waitForVerdict(
  queue: ChannelIngressQueue<SpoolPayload>,
  eventId: string,
  expected: "completed" | "failed",
): Promise<void> {
  await vi.waitFor(
    async () => {
      const verdict = await queue.enqueue(eventId, {
        version: 1,
        rawEvent: "{}",
        destination: "",
      });
      expect(verdict.kind).toBe(expected);
    },
    { timeout: 4_000 },
  );
}
