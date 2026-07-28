// Zalo tests share isolated durable-ingress state and Bot API envelopes.
import fs from "node:fs/promises";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { expect, vi } from "vitest";
import type { zaloWebhookIngressRuntime } from "./webhook-spool.js";

type CreateZaloWebhookIngress = (typeof zaloWebhookIngressRuntime)["createZaloWebhookIngress"];

type ZaloWebhookTestQueue = NonNullable<Parameters<CreateZaloWebhookIngress>[0]["queue"]>;
export type ZaloWebhookTestPayload = Parameters<ZaloWebhookTestQueue["enqueue"]>[1];

export function createZaloWebhookTestEvent(params?: {
  messageId?: string;
  userId?: string;
  chatId?: string;
  text?: string;
  date?: number;
}) {
  return {
    event_name: "message.text.received" as const,
    message: {
      message_id: params?.messageId ?? "message-1",
      from: { id: params?.userId ?? "user-1", name: "Test User" },
      chat: { id: params?.chatId ?? "chat-1", chat_type: "PRIVATE" as const },
      date: params?.date ?? Date.now(),
      text: params?.text ?? "hello",
    },
  };
}

export async function withZaloWebhookTestQueue<T>(
  fn: (queue: ZaloWebhookTestQueue) => Promise<T>,
): Promise<T> {
  const createdDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-zalo-ingress-"),
  );
  const stateDir = await fs.realpath(createdDir);
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const queue = createChannelIngressQueueForTests<ZaloWebhookTestPayload>({
    channelId: "zalo",
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

export async function waitForZaloWebhookVerdict(
  queue: ZaloWebhookTestQueue,
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
