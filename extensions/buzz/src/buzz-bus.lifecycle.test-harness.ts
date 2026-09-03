import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeEvent, getPublicKey, type Event } from "nostr-tools";
import { afterEach, beforeEach, vi } from "vitest";
import { sendBuzzTextOneShot, startBuzzBus, type BuzzBus } from "./buzz-bus.js";
import { relayMocks } from "./buzz-bus.test-helpers.js";

const PRIVATE_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const SENDER_PRIVATE_KEY = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const ACCOUNT_ID = "default";
const CHANNEL_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const BOT_PUBLIC_KEY = getPublicKey(Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")));
const SENDER_PUBLIC_KEY = getPublicKey(Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex")));
const SENDER_SECRET_KEY = Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex"));
const RELAY_PUBLIC_KEY = "f".repeat(64);
const tempDirs = new Set<string>();
let previousStateDir: string | undefined;
let stateDir: string;

function startTestBus(
  overrides: Partial<Parameters<typeof startBuzzBus>[0]> = {},
): Promise<BuzzBus> {
  return startBuzzBus({
    accountId: ACCOUNT_ID,
    relayUrl: "wss://buzz.example.com",
    privateKey: PRIVATE_KEY,
    channelIds: [CHANNEL_ID],
    onMessage: async () => {},
    ...overrides,
  });
}

function sendTestTextOneShot(
  overrides: Partial<Parameters<typeof sendBuzzTextOneShot>[0]> = {},
): Promise<string> {
  return sendBuzzTextOneShot({
    relayUrl: "wss://buzz.example.com",
    privateKey: PRIVATE_KEY,
    channelId: CHANNEL_ID,
    text: "hello",
    ...overrides,
  });
}

function signSenderEvent(template: Parameters<typeof finalizeEvent>[0]): Event {
  return finalizeEvent(template, SENDER_SECRET_KEY);
}

function subscriptionIncludesKind(
  subscription: (typeof relayMocks.subscriptions)[number],
  kind: number,
): boolean {
  return subscription.filters.some((filter) => filter.kinds?.includes(kind));
}

export function useBuzzBusLifecycleFixture() {
  beforeEach(() => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    // openclaw-temp-dir: allow extension tests cannot import root test helpers.
    stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-buzz-dedupe-"));
    tempDirs.add(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    vi.clearAllMocks();
    relayMocks.subscriptions.length = 0;
    relayMocks.profileEvents = [];
    relayMocks.roomMetadataEvents = [];
    relayMocks.roomHistoryEvents = [];
    relayMocks.beforeRoomHistoryEvent = undefined;
    relayMocks.membershipEvents = [
      {
        id: "membership-1",
        kind: 39002,
        pubkey: RELAY_PUBLIC_KEY,
        created_at: 1_700_000_000,
        content: "",
        sig: "e".repeat(128),
        tags: [
          ["d", CHANNEL_ID],
          ["p", BOT_PUBLIC_KEY, "", "bot"],
          ["p", SENDER_PUBLIC_KEY, "", "member"],
        ],
      },
    ];
    relayMocks.connect.mockResolvedValue();
    relayMocks.auth.mockRejectedValue(new Error("auth rejected"));
    relayMocks.publish.mockResolvedValue("");
    relayMocks.send.mockResolvedValue();
    relayMocks.connected = true;
    relayMocks.stallProfileQueryEose = false;
    relayMocks.stallRoomEoseChannelId = undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          self: RELAY_PUBLIC_KEY,
          software: "https://github.com/block/buzz",
        }),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });
  return {
    PRIVATE_KEY,
    ACCOUNT_ID,
    CHANNEL_ID,
    BOT_PUBLIC_KEY,
    SENDER_PUBLIC_KEY,
    RELAY_PUBLIC_KEY,
    startTestBus,
    sendTestTextOneShot,
    signSenderEvent,
    subscriptionIncludesKind,
  };
}
