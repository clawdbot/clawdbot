import { expect, vi } from "vitest";
import {
  createAutomaticSourceDeliveryContext,
  createDiscordDraftStream,
  createMockDraftStream,
  deliverDiscordReply,
  dispatchInboundMessageForTest as dispatchInboundMessage,
  runProcessDiscordMessage,
  sendMocksForTest as sendMocks,
} from "./message-handler.process.test-harness.js";
import type { DispatchInboundParams } from "./message-handler.process.test-harness.js";

export function getReactionEmojis(): string[] {
  return (
    sendMocks.reactMessageDiscord.mock.calls as unknown as Array<[unknown, unknown, string]>
  ).map((call) => call[2]);
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

type MockWithCalls = { mock: { calls: unknown[][] } };

export function firstMockCall(mock: MockWithCalls, label: string): unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`missing ${label} call`);
  }
  return call;
}

export function firstMockArg(mock: MockWithCalls, label: string) {
  return firstMockCall(mock, label)[0];
}

export function firstDispatchParams(): DispatchInboundParams {
  return firstMockArg(dispatchInboundMessage, "dispatchInboundMessage") as DispatchInboundParams;
}

export function expectRecordFields(
  record: Record<string, unknown>,
  fields: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

function expectAckReactionRuntimeOptions(
  options: unknown,
  params?: {
    accountId?: string;
    ackReaction?: string;
  },
) {
  const optionRecord = requireRecord(options, "reaction runtime options");
  requireRecord(optionRecord.rest, "reaction REST client");
  if (params?.accountId) {
    expect(optionRecord.accountId).toBe(params.accountId);
  }
  const messages: Record<string, unknown> = {};
  if (params?.ackReaction) {
    messages.ackReaction = params.ackReaction;
  }
  if (Object.keys(messages).length > 0) {
    const cfg = requireRecord(optionRecord.cfg, "reaction config");
    expectRecordFields(requireRecord(cfg.messages, "reaction message config"), messages);
  }
}

export function requireReactionCall(
  mock: typeof sendMocks.reactMessageDiscord | typeof sendMocks.removeReactionDiscord,
  index: number,
) {
  const call = mock.mock.calls[index] as unknown[] | undefined;
  if (!call) {
    throw new Error(`missing reaction call ${index + 1}`);
  }
  return call;
}

function expectReactionCallAt(
  mock: typeof sendMocks.reactMessageDiscord | typeof sendMocks.removeReactionDiscord,
  index: number,
  emoji: string,
  params?: {
    accountId?: string;
    ackReaction?: string;
    channelId?: string;
    messageId?: string;
  },
) {
  const call = requireReactionCall(mock, index);
  expect(call[0]).toBe(params?.channelId ?? "c1");
  expect(call[1]).toBe(params?.messageId ?? "m1");
  expect(call[2]).toBe(emoji);
  expectAckReactionRuntimeOptions(call[3], params);
}

export function expectReactionCallsContain(channelId: string, messageId: string, emoji: string) {
  const calls = sendMocks.reactMessageDiscord.mock.calls as unknown as Array<
    [string, string, string]
  >;
  const hasCall = calls.some(
    ([actualChannelId, actualMessageId, actualEmoji]) =>
      actualChannelId === channelId && actualMessageId === messageId && actualEmoji === emoji,
  );
  expect(hasCall).toBe(true);
}

export function expectReactAckCallAt(
  index: number,
  emoji: string,
  params?: {
    channelId?: string;
    messageId?: string;
    accountId?: string;
    ackReaction?: string;
  },
) {
  expectReactionCallAt(sendMocks.reactMessageDiscord, index, emoji, params);
}

export function createMockDraftStreamForTest() {
  const draftStream = createMockDraftStream();
  createDiscordDraftStream.mockReturnValueOnce(draftStream);
  return draftStream;
}

export function getDeliveredFinalTexts(): string[] {
  return deliverDiscordReply.mock.calls.flatMap((call) => {
    const params = requireRecord(call[0], "deliverDiscordReply params");
    if (params.kind !== "final") {
      return [];
    }
    return ((params as { replies?: Array<{ text?: string }> }).replies ?? []).flatMap((reply) =>
      typeof reply.text === "string" ? [reply.text] : [],
    );
  });
}

export function expectFinalWithProgressReceipt(answer: string, ...parts: string[]) {
  const text = getDeliveredFinalTexts()[0] ?? "";
  const receiptStart = text.lastIndexOf("\n-# ");
  expect(receiptStart).toBeGreaterThan(-1);
  expect(text.slice(0, receiptStart)).toBe(answer);
  const receipt = text.slice(receiptStart + 1);
  for (const part of parts) {
    expect(receipt).toContain(part);
  }
  expect(receipt).toContain("⏱️");
}

export function expectFreshFinalText(text: string) {
  const finalParams = deliverDiscordReply.mock.calls
    .map((call) => requireRecord(call[0], "deliverDiscordReply params"))
    .find((params) => params.kind === "final");
  expect(finalParams).toBeDefined();
  const replies = (finalParams as { replies?: Array<{ text?: string }> }).replies;
  expect(replies?.[0]?.text).toBe(text);
}

export function useProgressDraftStartDelay() {
  vi.useFakeTimers();
  return async () => {
    await vi.advanceTimersByTimeAsync(5_000);
  };
}

export async function runSingleChunkFinalScenario(discordConfig: Record<string, unknown>) {
  dispatchInboundMessage.mockImplementationOnce(async (params?: DispatchInboundParams) => {
    await params?.dispatcher.sendFinalReply({ text: "Hello\nWorld" });
    return { queuedFinal: true, counts: { final: 1, tool: 0, block: 0 } };
  });

  const ctx = await createAutomaticSourceDeliveryContext({
    discordConfig,
  });

  await runProcessDiscordMessage(ctx);
}

export async function createBlockModeContext(
  discordConfig: Record<string, unknown> = { streaming: { mode: "block" } },
) {
  return await createAutomaticSourceDeliveryContext({
    cfg: {
      messages: { ackReaction: "👀" },
      session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      channels: {
        discord: {
          streaming: {
            preview: { chunk: { minChars: 1, maxChars: 5, breakPreference: "newline" } },
          },
        },
      },
    },
    discordConfig,
  });
}
