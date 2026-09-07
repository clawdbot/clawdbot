// Shared fixtures for the Buzz inbound tests. They live here so inbound.test.ts
// and inbound.reply-quote.test.ts each stay under the max-lines ratchet.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { vi } from "vitest";
import type { BuzzBus } from "./buzz-bus.js";
import { BuzzDirectoryState } from "./directory-state.js";
import { handleBuzzInbound as handleBuzzInboundWithHistory } from "./inbound.js";
import { BUZZ_NORMAL_MESSAGE_KIND, type BuzzInboundMessage } from "./message-event.js";
import type { ResolvedBuzzAccount } from "./types.js";

export const ROOM_ID = "b25b8e40-eb1a-43a4-b56b-30a4e16df586";
export const BOT_PUBLIC_KEY = "a".repeat(64);
export const SENDER_PUBLIC_KEY = "b".repeat(64);
export const OTHER_PUBLIC_KEY = "c".repeat(64);
// Reply markers must be real 32-byte hex ids; the lookup rejects anything else.
export const PARENT_EVENT_ID = "d".repeat(64);

export function handleBuzzInbound(
  params: Omit<Parameters<typeof handleBuzzInboundWithHistory>[0], "historyMap"> & {
    historyMap?: Map<string, HistoryEntry[]>;
  },
) {
  return handleBuzzInboundWithHistory({ ...params, historyMap: params.historyMap ?? new Map() });
}
export function createAccount(
  configOverrides: Partial<ResolvedBuzzAccount["config"]> = {},
): ResolvedBuzzAccount {
  return {
    accountId: "default",
    name: "OpenClaw",
    enabled: true,
    configured: true,
    relayUrl: "ws://127.0.0.1:3000",
    privateKey: "1".repeat(64),
    authTag: "",
    publicKey: BOT_PUBLIC_KEY,
    config: {
      groupPolicy: "open",
      groups: {
        [ROOM_ID]: {
          requireMention: true,
        },
      },
      ...configOverrides,
    },
  };
}
export function createMessage(overrides: Partial<BuzzInboundMessage> = {}): BuzzInboundMessage {
  return {
    id: "event-1",
    kind: BUZZ_NORMAL_MESSAGE_KIND,
    senderPubkey: SENDER_PUBLIC_KEY,
    text: "hello",
    channelId: ROOM_ID,
    createdAt: 1_777_000_000,
    mentionedPubkeys: [],
    ...overrides,
  };
}
export function createLifecycle() {
  const signal = new AbortController().signal;
  return { signal, assertCurrent: () => signal.throwIfAborted() };
}
export function createBus(): BuzzBus {
  return {
    publicKey: BOT_PUBLIC_KEY,
    directory: new BuzzDirectoryState({
      publicKey: BOT_PUBLIC_KEY,
      fallbackProfileName: "OpenClaw",
      channelIds: [ROOM_ID],
    }),
    refreshDirectory: vi.fn(async () => {}),
    sendText: vi.fn(async () => "reply-event-1"),
    sendTyping: vi.fn(async () => undefined),
    fetchMessageById: vi.fn(async () => null),
    close: vi.fn(async () => undefined),
  };
}
export function firstDispatch(
  runtime: ReturnType<typeof createPluginRuntimeMock>,
): Parameters<typeof runtime.channel.inbound.dispatch>[0] {
  const call = vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0];
  if (!call) {
    throw new Error("expected Buzz inbound dispatch");
  }
  return call[0];
}
export function createHistoryParams(historyLimit = 2, roles = new Map<string, string>()) {
  const bus = createBus();
  bus.directory.replaceMemberships(
    new Map([
      [
        ROOM_ID,
        {
          roomId: ROOM_ID,
          createdAt: 1_777_000_000,
          eventId: "membership-history",
          publisherPublicKey: OTHER_PUBLIC_KEY,
          members: new Set([BOT_PUBLIC_KEY, SENDER_PUBLIC_KEY, OTHER_PUBLIC_KEY]),
          roles,
        },
      ],
    ]),
  );
  return {
    account: createAccount({ historyLimit }),
    cfg: {} satisfies OpenClawConfig,
    bus,
    ...createLifecycle(),
    historyMap: new Map<string, HistoryEntry[]>(),
  };
}
