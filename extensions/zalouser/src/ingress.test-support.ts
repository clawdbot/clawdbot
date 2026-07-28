// Zalouser tests share isolated durable-ingress state and raw zca-js envelopes.
import fs from "node:fs/promises";
import path from "node:path";
import {
  closeOpenClawStateDatabaseForTest,
  createChannelIngressQueueForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { expect, vi } from "vitest";
import type { createZalouserIngressMonitor } from "./ingress.js";
import type { ZaloInboundMessage } from "./types.js";
import type { Message } from "./zca-client.js";
import { ThreadType } from "./zca-constants.js";

type CreateZalouserIngressMonitor = typeof createZalouserIngressMonitor;
type ZalouserTestQueue = NonNullable<Parameters<CreateZalouserIngressMonitor>[0]["queue"]>;
export type ZalouserTestIngressPayload = Parameters<ZalouserTestQueue["enqueue"]>[1];

export function createRawZalouserMessage(params?: {
  msgId?: string;
  cliMsgId?: string;
  senderId?: string;
  threadId?: string;
  content?: string;
  timestamp?: string;
  isGroup?: boolean;
}): Message {
  const isGroup = params?.isGroup ?? false;
  const senderId = params?.senderId ?? "sender-1";
  const threadId = params?.threadId ?? (isGroup ? "group-1" : senderId);
  return {
    type: isGroup ? ThreadType.Group : ThreadType.User,
    threadId,
    isSelf: false,
    data: {
      msgId: params?.msgId ?? "message-1",
      cliMsgId: params?.cliMsgId ?? "client-1",
      uidFrom: senderId,
      idTo: isGroup ? threadId : "owner-1",
      dName: "Test Sender",
      content: params?.content ?? "hello",
      ts: params?.timestamp ?? "1764000000000",
    },
  };
}

export function createRawZalouserMessageFromNormalized(message: ZaloInboundMessage): Message {
  const raw = createRawZalouserMessage({
    msgId: message.msgId,
    cliMsgId: message.cliMsgId,
    senderId: message.senderId,
    threadId: message.threadId,
    content: message.content,
    timestamp: String(message.timestampMs),
    isGroup: message.isGroup,
  });
  raw.data.testNormalizedMessage = message;
  return raw;
}

export async function withZalouserIngressTestQueue<T>(
  fn: (queue: ZalouserTestQueue) => Promise<T>,
): Promise<T> {
  const createdDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-zalouser-ingress-"),
  );
  const stateDir = await fs.realpath(createdDir);
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const queue = createChannelIngressQueueForTests<ZalouserTestIngressPayload>({
    channelId: "zalouser",
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

export async function waitForZalouserIngressVerdict(
  queue: ZalouserTestQueue,
  eventId: string,
  expected: "completed" | "failed",
): Promise<void> {
  await vi.waitFor(
    async () => {
      const verdict = await queue.enqueue(eventId, {
        version: 1,
        receivedAt: 0,
        rawMessage: "{}",
      });
      expect(verdict.kind).toBe(expected);
    },
    { timeout: 5_000 },
  );
}
