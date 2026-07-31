import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeEvent, getPublicKey, type Event, type Filter } from "nostr-tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const relayMocks = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<void>>(),
  auth: vi.fn<() => Promise<string>>(),
  publish: vi.fn<(event: Event) => Promise<string>>(),
  send: vi.fn<(message: string) => Promise<void>>(),
  close: vi.fn(),
  connected: true,
  storedEvents: [] as Event[],
  historyRequests: [] as Filter[],
  historySubscriptionCloses: 0,
  closeHistoryPagesReason: undefined as string | undefined,
  overReturnHistoryPages: false,
  stallHistoryPages: false,
}));

function matchesRelayFilter(event: Event, filter: Filter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) {
    return false;
  }
  if (filter.authors && !filter.authors.includes(event.pubkey)) {
    return false;
  }
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values)) {
      continue;
    }
    const tagName = key.slice(1);
    const tagValues = event.tags.filter((tag) => tag[0] === tagName).map((tag) => tag[1] ?? "");
    if (!tagValues.some((value) => (values as string[]).includes(value))) {
      return false;
    }
  }
  if (filter.since !== undefined && event.created_at < filter.since) {
    return false;
  }
  if (filter.until !== undefined && event.created_at > filter.until) {
    return false;
  }
  return true;
}

function selectRelayEvents(filter: Filter): Event[] {
  const matched = relayMocks.storedEvents
    .filter((event) => matchesRelayFilter(event, filter))
    .toSorted((left, right) => right.created_at - left.created_at);
  return filter.limit === undefined ||
    (relayMocks.overReturnHistoryPages && filter.until !== undefined)
    ? matched
    : matched.slice(0, filter.limit);
}

vi.mock("nostr-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("nostr-tools")>();
  return {
    ...actual,
    Relay: class {
      onauth?: (template: unknown) => Promise<unknown>;
      idleSince: number | undefined;
      ongoingOperations = 0;
      get connected() {
        return relayMocks.connected;
      }
      connect = relayMocks.connect;
      auth = relayMocks.auth;
      publish = relayMocks.publish;
      send = relayMocks.send;
      close = relayMocks.close;
      scheduleIdleClose = vi.fn();

      prepareSubscription(
        filters: Filter[],
        handlers: {
          onevent: (event: Event) => void;
          oneose?: () => void;
          onclose: (reason: string) => void;
        },
      ) {
        let isHistoryPage = false;
        for (const filter of filters) {
          if (filter.kinds?.includes(9)) {
            relayMocks.historyRequests.push(filter);
            isHistoryPage ||= filter.until !== undefined;
          }
          for (const event of selectRelayEvents(filter)) {
            handlers.onevent(event);
          }
          if (relayMocks.closeHistoryPagesReason && isHistoryPage) {
            queueMicrotask(() => {
              handlers.onclose(relayMocks.closeHistoryPagesReason ?? "relay closed");
            });
            return {
              id: `sub:${relayMocks.historyRequests.length}`,
              close: vi.fn(),
              closed: false,
            };
          }
          if (relayMocks.stallHistoryPages && isHistoryPage) {
            return {
              id: `sub:${relayMocks.historyRequests.length}`,
              close: vi.fn(),
              closed: false,
            };
          }
        }
        handlers.oneose?.();
        return {
          id: `sub:${relayMocks.historyRequests.length}`,
          close: vi.fn(() => {
            if (isHistoryPage) {
              relayMocks.historySubscriptionCloses += 1;
            }
          }),
          closed: false,
        };
      }
    },
  };
});

import { startBuzzBus } from "./buzz-bus.js";

const BUZZ_NORMAL_MESSAGE_KIND = 9;
const BUZZ_ROOM_MEMBERSHIP_KIND = 39_002;
const PRIVATE_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const SENDER_PRIVATE_KEY = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const SENDER_SECRET = Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex"));
const ACCOUNT_ID = "default";
const CHANNEL_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const BOT_PUBLIC_KEY = getPublicKey(Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")));
const SENDER_PUBLIC_KEY = getPublicKey(SENDER_SECRET);
const RELAY_PUBLIC_KEY = "f".repeat(64);
const HISTORY_LIMIT = 100;
const BASE_TIMESTAMP = 1_700_000_000;
const tempDirs = new Set<string>();
let previousStateDir: string | undefined;

function buildMessageEvent(index: number, createdAt: number): Event {
  return finalizeEvent(
    {
      kind: BUZZ_NORMAL_MESSAGE_KIND,
      content: `offline-message-${String(index).padStart(3, "0")}`,
      created_at: createdAt,
      tags: [["h", CHANNEL_ID]],
    },
    SENDER_SECRET,
  );
}

function seedOfflineBacklog(count: number, createdAt: (index: number) => number): void {
  for (let index = 0; index < count; index += 1) {
    relayMocks.storedEvents.push(buildMessageEvent(index, createdAt(index)));
  }
}

async function waitForSettled(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe("Buzz reconnect history catch-up", () => {
  beforeEach(() => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    // openclaw-temp-dir: allow extension tests cannot import root test helpers.
    const stateDir = mkdtempSync(path.join(tmpdir(), "openclaw-buzz-catchup-"));
    tempDirs.add(stateDir);
    process.env.OPENCLAW_STATE_DIR = stateDir;
    vi.clearAllMocks();
    relayMocks.historyRequests.length = 0;
    relayMocks.historySubscriptionCloses = 0;
    relayMocks.closeHistoryPagesReason = undefined;
    relayMocks.overReturnHistoryPages = false;
    relayMocks.stallHistoryPages = false;
    relayMocks.storedEvents = [
      {
        id: "membership-1",
        kind: BUZZ_ROOM_MEMBERSHIP_KIND,
        pubkey: RELAY_PUBLIC_KEY,
        created_at: BASE_TIMESTAMP - 3_600,
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
    relayMocks.auth.mockResolvedValue("ok");
    relayMocks.publish.mockResolvedValue("");
    relayMocks.send.mockResolvedValue();
    relayMocks.connected = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          self: RELAY_PUBLIC_KEY,
          software: "https://github.com/block/buzz",
        }),
      })),
    );
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.clear();
    vi.useRealTimers();
  });

  it("delivers backlog older than the per-room history limit", async () => {
    seedOfflineBacklog(HISTORY_LIMIT + 1, (index) => BASE_TIMESTAMP + index);
    const received: string[] = [];

    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      since: BASE_TIMESTAMP - 60,
      onMessage: async (message) => {
        received.push(message.text);
      },
    });
    await waitForSettled(() => received.length >= HISTORY_LIMIT + 1);
    await bus.close();

    expect(new Set(received).size).toBe(HISTORY_LIMIT + 1);
    expect(received).toContain("offline-message-000");
    expect(received.length).toBe(HISTORY_LIMIT + 1);
    expect(relayMocks.historySubscriptionCloses).toBe(1);
  });

  it("pages a backlog spanning several history windows", async () => {
    const backlogSize = 250;
    seedOfflineBacklog(backlogSize, (index) => BASE_TIMESTAMP + index);
    const received: string[] = [];

    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      since: BASE_TIMESTAMP - 60,
      onMessage: async (message) => {
        received.push(message.text);
      },
    });
    await waitForSettled(() => received.length >= backlogSize);
    await bus.close();

    expect(new Set(received).size).toBe(backlogSize);
    expect(received).toContain("offline-message-000");
    expect(relayMocks.historyRequests.length).toBeGreaterThan(1);
  });

  it("drains a backlog that exceeds one page at the same timestamp", async () => {
    seedOfflineBacklog(HISTORY_LIMIT + 1, () => BASE_TIMESTAMP);
    const historyErrors: string[] = [];
    const received: string[] = [];

    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      since: BASE_TIMESTAMP - 60,
      onMessage: async (message) => {
        received.push(message.text);
      },
      onHistoryError: (error) => {
        historyErrors.push(error.message);
      },
    });
    await waitForSettled(() => received.length >= HISTORY_LIMIT + 1);
    await bus.close();

    expect(historyErrors).toEqual([]);
    expect(new Set(received).size).toBe(HISTORY_LIMIT + 1);
    expect(received.length).toBe(HISTORY_LIMIT + 1);
    expect(relayMocks.historyRequests.some((filter) => filter.limit === undefined)).toBe(true);
  });

  it("bounds a catch-up page when the relay ignores its history limit", async () => {
    seedOfflineBacklog(250, (index) => BASE_TIMESTAMP + index);
    relayMocks.overReturnHistoryPages = true;
    const historyErrors: string[] = [];
    const received: string[] = [];

    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      since: BASE_TIMESTAMP - 60,
      onMessage: async (message) => {
        received.push(message.text);
      },
      onHistoryError: (error) => {
        historyErrors.push(error.message);
      },
    });
    await waitForSettled(() => received.length >= 250);
    await bus.close();

    expect(historyErrors).toEqual([]);
    expect(new Set(received).size).toBe(250);
    expect(received.length).toBe(250);
    expect(relayMocks.historySubscriptionCloses).toBe(2);
  });

  it("bisects an overfull relay range until every bounded page fits", async () => {
    const backlogSize = 1_300;
    seedOfflineBacklog(backlogSize, (index) => BASE_TIMESTAMP + index);
    relayMocks.overReturnHistoryPages = true;
    const historyErrors: string[] = [];
    const received: string[] = [];

    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      since: BASE_TIMESTAMP - 60,
      onMessage: async (message) => {
        received.push(message.text);
      },
      onHistoryError: (error) => {
        historyErrors.push(error.message);
      },
    });
    await waitForSettled(() => received.length >= backlogSize);
    await bus.close();

    expect(historyErrors).toEqual([]);
    expect(new Set(received).size).toBe(backlogSize);
    expect(received.length).toBe(backlogSize);
    expect(
      relayMocks.historyRequests.filter((filter) => filter.limit === undefined).length,
    ).toBeGreaterThan(2);
  });

  it("fails the bus when a catch-up subscription never reaches EOSE", async () => {
    vi.useFakeTimers();
    seedOfflineBacklog(HISTORY_LIMIT + 1, (index) => BASE_TIMESTAMP + index);
    relayMocks.stallHistoryPages = true;
    const fatalErrors: string[] = [];

    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      since: BASE_TIMESTAMP - 60,
      onMessage: async () => {},
      onFatalError: (error) => {
        fatalErrors.push(error.message);
      },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await bus.close();

    expect(fatalErrors).toEqual([`Timed out loading Buzz room history for ${CHANNEL_ID}`]);
    expect(relayMocks.close).toHaveBeenCalled();
    expect(relayMocks.historySubscriptionCloses).toBe(0);
  });

  it("fails the bus when a catch-up subscription closes unexpectedly", async () => {
    seedOfflineBacklog(HISTORY_LIMIT + 1, (index) => BASE_TIMESTAMP + index);
    relayMocks.closeHistoryPagesReason = "relay rejected subscription";
    const fatalErrors: string[] = [];

    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      since: BASE_TIMESTAMP - 60,
      onMessage: async () => {},
      onFatalError: (error) => {
        fatalErrors.push(error.message);
      },
    });
    await waitForSettled(() => fatalErrors.length > 0);
    await bus.close();

    expect(fatalErrors).toEqual([
      `Buzz room history query closed for ${CHANNEL_ID}: relay rejected subscription`,
    ]);
    expect(relayMocks.close).toHaveBeenCalled();
  });

  it("stops an active history query quietly when the bus closes", async () => {
    seedOfflineBacklog(250, (index) => BASE_TIMESTAMP + index);
    relayMocks.stallHistoryPages = true;
    const fatalErrors: string[] = [];
    const historyErrors: string[] = [];
    const received: string[] = [];

    const bus = await startBuzzBus({
      accountId: ACCOUNT_ID,
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      channelIds: [CHANNEL_ID],
      since: BASE_TIMESTAMP - 60,
      onMessage: async (message) => {
        received.push(message.text);
      },
      onFatalError: (error) => {
        fatalErrors.push(error.message);
      },
      onHistoryError: (error) => {
        historyErrors.push(error.message);
      },
    });
    await waitForSettled(() => relayMocks.historyRequests.length > 1);
    await bus.close();
    const requestsAtClose = relayMocks.historyRequests.length;
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });

    expect(relayMocks.historyRequests.length).toBe(requestsAtClose);
    expect(received.length).toBeLessThan(250);
    expect(fatalErrors).toEqual([]);
    expect(historyErrors).toEqual([]);
  });
});
