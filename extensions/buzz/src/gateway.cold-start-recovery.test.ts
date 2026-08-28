import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { finalizeEvent, getPublicKey, type Event, type Filter } from "nostr-tools";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelGatewayContext } from "../runtime-api.js";
import type { BuzzInboundMessage } from "./message-event.js";
import type { ResolvedBuzzAccount } from "./types.js";

const relayMocks = vi.hoisted(() => ({
  connect: vi.fn<() => Promise<void>>(),
  auth: vi.fn<() => Promise<string>>(),
  publish: vi.fn<(event: Event) => Promise<string>>(),
  send: vi.fn<(message: string) => Promise<void>>(),
  close: vi.fn(),
  connected: true,
  storedEvents: [] as Event[],
  messageFilters: [] as Filter[],
  dropSubscriptionReason: undefined as string | undefined,
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
  return filter.limit === undefined ? matched : matched.slice(0, filter.limit);
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
        let carriesMessages = false;
        for (const filter of filters) {
          if (filter.kinds?.includes(9)) {
            relayMocks.messageFilters.push(filter);
            carriesMessages = true;
          }
          for (const event of selectRelayEvents(filter)) {
            handlers.onevent(event);
          }
        }
        handlers.oneose?.();
        if (carriesMessages && relayMocks.dropSubscriptionReason) {
          const reason = relayMocks.dropSubscriptionReason;
          relayMocks.dropSubscriptionReason = undefined;
          queueMicrotask(() => {
            handlers.onclose(reason);
          });
        }
        return {
          id: `sub:${relayMocks.messageFilters.length}`,
          close: vi.fn(),
          closed: false,
        };
      }
    },
  };
});

const inboundMocks = vi.hoisted(() => ({
  handleBuzzInbound: vi.fn(),
}));

vi.mock("./inbound.js", () => ({
  handleBuzzInbound: inboundMocks.handleBuzzInbound,
}));

import { startBuzzGatewayAccount } from "./gateway.js";
import { openBuzzRecoveryWatermarkStore, resolveBuzzRecoverySince } from "./recovery-watermark.js";
import { setBuzzRuntime } from "./runtime.js";
import { BUZZ_MAX_CONFIGURED_ROOMS } from "./subscription-budget.js";
import { resolveBuzzAccount } from "./types.js";

const BUZZ_MESSAGE_KIND = 9;
const BUZZ_ROOM_MEMBERSHIP_KIND = 39_002;
const ACCOUNT_ID = "default";
const SECOND_ACCOUNT_ID = "second";
const CHANNEL_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const SECOND_CHANNEL_ID = "1b8f5c33-9a21-4d0e-8f77-2b6c1d4e5a90";
const PRIVATE_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const SENDER_PRIVATE_KEY = "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20";
const SENDER_SECRET = Uint8Array.from(Buffer.from(SENDER_PRIVATE_KEY, "hex"));
const BOT_PUBLIC_KEY = getPublicKey(Uint8Array.from(Buffer.from(PRIVATE_KEY, "hex")));
const SENDER_PUBLIC_KEY = getPublicKey(SENDER_SECRET);
const RELAY_PUBLIC_KEY = "f".repeat(64);
const LOOKBACK_SECONDS = 24 * 60 * 60;
const START_SECONDS = 1_800_000_000;

let tempDir: string | undefined;
let previousStateDir: string | undefined;
let currentNowMs = START_SECONDS * 1_000;
let handled: string[] = [];
let gates = new Map<string, Promise<void>>();

function nowSeconds(): number {
  return Math.floor(currentNowMs / 1000);
}

function advanceSeconds(seconds: number): void {
  currentNowMs += seconds * 1_000;
}

function gateHandler(text: string): { settle: () => void; fail: (error: Error) => void } {
  let settle = () => {};
  let fail = (_error: Error) => {};
  gates.set(
    text,
    new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    }),
  );
  return { settle, fail };
}

function postRoomMessage(text: string, createdAt: number, channelId = CHANNEL_ID): void {
  relayMocks.storedEvents.push(
    finalizeEvent(
      {
        kind: BUZZ_MESSAGE_KIND,
        content: text,
        created_at: createdAt,
        tags: [["h", channelId]],
      },
      SENDER_SECRET,
    ),
  );
}

function publishRoomMembership(channelId: string): void {
  relayMocks.storedEvents.push({
    id: `membership-${channelId}`,
    kind: BUZZ_ROOM_MEMBERSHIP_KIND,
    pubkey: RELAY_PUBLIC_KEY,
    created_at: START_SECONDS - 3_600,
    content: "",
    sig: "e".repeat(128),
    tags: [
      ["d", channelId],
      ["p", BOT_PUBLIC_KEY, "", "bot"],
      ["p", SENDER_PUBLIC_KEY, "", "member"],
    ],
  });
}

function buildConfig(channelIds: string[]): OpenClawConfig {
  return {
    channels: {
      buzz: {
        relayUrl: "wss://buzz.example.com",
        privateKey: PRIVATE_KEY,
        groups: Object.fromEntries(channelIds.map((channelId) => [channelId, {}])),
      },
    },
  } as OpenClawConfig;
}

function startGatewayProcess(channelIds: string[] = [CHANNEL_ID]): {
  abort: AbortController;
  lifecycle: Promise<void>;
} {
  const cfg = buildConfig(channelIds);
  const account = resolveBuzzAccount({ cfg });
  const abort = new AbortController();
  const ctx = {
    cfg,
    accountId: account.accountId,
    account,
    runtime: {},
    abortSignal: abort.signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getStatus: vi.fn(),
    setStatus: vi.fn(),
  } as unknown as ChannelGatewayContext<ResolvedBuzzAccount>;
  return { abort, lifecycle: startBuzzGatewayAccount(ctx) };
}

async function waitForSettled(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error("timed out waiting for the Buzz gateway to settle");
}

async function runGatewayProcess(
  params: { until?: () => boolean | Promise<boolean>; channelIds?: string[] } = {},
): Promise<void> {
  const channelIds = params.channelIds ?? [CHANNEL_ID];
  const gatewayProcess = startGatewayProcess(channelIds);
  try {
    await waitForSettled(() => relayMocks.messageFilters.length >= channelIds.length);
    if (params.until) {
      await waitForSettled(params.until);
    }
  } finally {
    gatewayProcess.abort.abort();
    await gatewayProcess.lifecycle;
  }
}

function roomSubscriptionSince(channelId = CHANNEL_ID): number {
  const filter = relayMocks.messageFilters.find((entry) =>
    (entry["#h"] as string[] | undefined)?.includes(channelId),
  );
  expect(filter?.since).toBeTypeOf("number");
  return filter?.since as number;
}

async function readWatermark(channelId = CHANNEL_ID): Promise<number | undefined> {
  const store = openBuzzRecoveryWatermarkStore({ accountId: ACCOUNT_ID });
  return (await store.lookup(`room:${channelId}`))?.seconds;
}

function openProcessBoundary(): void {
  relayMocks.messageFilters.length = 0;
  handled = [];
  gates = new Map();
}

beforeEach(() => {
  vi.clearAllMocks();
  currentNowMs = START_SECONDS * 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => currentNowMs);
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  // openclaw-temp-dir: allow extension tests cannot import root test helpers.
  tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-buzz-coldstart-"));
  process.env.OPENCLAW_STATE_DIR = tempDir;
  handled = [];
  gates = new Map();
  relayMocks.messageFilters.length = 0;
  relayMocks.dropSubscriptionReason = undefined;
  relayMocks.connected = true;
  relayMocks.connect.mockResolvedValue();
  relayMocks.auth.mockResolvedValue("ok");
  relayMocks.publish.mockResolvedValue("");
  relayMocks.send.mockResolvedValue();
  relayMocks.storedEvents = [];
  publishRoomMembership(CHANNEL_ID);
  publishRoomMembership(SECOND_CHANNEL_ID);
  inboundMocks.handleBuzzInbound.mockImplementation(
    async ({ message }: { message: BuzzInboundMessage }) => {
      handled.push(message.text);
      await gates.get(message.text);
    },
  );
  setBuzzRuntime({
    agent: { resolveAgentIdentity: vi.fn().mockReturnValue(undefined) },
    channel: {
      routing: { resolveAgentRoute: vi.fn().mockReturnValue({ agentId: "main" }) },
      text: {
        resolveMarkdownTableMode: () => "preserve",
        convertMarkdownTables: (text: string) => text,
      },
    },
    state: {
      openKeyedStore: <T>(options: Parameters<typeof createPluginStateKeyedStoreForTests>[1]) =>
        createPluginStateKeyedStoreForTests<T>("buzz", options),
    },
  } as never);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ self: RELAY_PUBLIC_KEY, software: "https://github.com/block/buzz" }),
    ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetPluginStateStoreForTests();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = undefined;
});

describe("Buzz gateway cold-start recovery", () => {
  it("recovers downtime messages from the persisted room activation floor", async () => {
    await runGatewayProcess();
    expect(roomSubscriptionSince()).toBe(START_SECONDS);

    openProcessBoundary();
    postRoomMessage("live-msg", START_SECONDS + 10);
    advanceSeconds(600);
    await runGatewayProcess({ until: () => handled.includes("live-msg") });

    openProcessBoundary();
    postRoomMessage("outage-msg", START_SECONDS + 3_610);
    advanceSeconds(7_200);
    await runGatewayProcess({ until: () => handled.includes("outage-msg") });
    expect(roomSubscriptionSince()).toBe(START_SECONDS);
    expect(handled).toContain("outage-msg");
    expect(handled).not.toContain("live-msg");
  });

  it("keeps an account with no cursor at the current time on its first start", async () => {
    postRoomMessage("existing-room-history", START_SECONDS - 60);
    await runGatewayProcess();
    expect(roomSubscriptionSince()).toBe(START_SECONDS);
    expect(handled).not.toContain("existing-room-history");
    expect(await readWatermark()).toBe(START_SECONDS);
  });

  it("keeps recovery capacity available when configured rooms change", async () => {
    const store = openBuzzRecoveryWatermarkStore({ accountId: ACCOUNT_ID });
    const channelIds = Array.from(
      { length: BUZZ_MAX_CONFIGURED_ROOMS },
      (_value, index) => `room-${index}`,
    );
    const sinceByRoom = await resolveBuzzRecoverySince({
      store,
      channelIds,
      nowSeconds: START_SECONDS,
      lookbackSeconds: LOOKBACK_SECONDS,
    });

    expect(sinceByRoom.size).toBe(BUZZ_MAX_CONFIGURED_ROOMS);
    const lastChannelId = channelIds.at(-1) as string;
    expect(await store.lookup(`room:${lastChannelId}`)).toEqual({
      seconds: START_SECONDS,
    });

    const removedChannelId = channelIds[0] as string;
    const retainedChannelId = channelIds[1] as string;
    const replacementChannelId = "replacement-room";
    const rotatedRooms = [...channelIds.slice(1), replacementChannelId];
    const rotatedSinceByRoom = await resolveBuzzRecoverySince({
      store,
      channelIds: rotatedRooms,
      nowSeconds: START_SECONDS + 60,
      lookbackSeconds: LOOKBACK_SECONDS,
    });

    expect(await store.lookup(`room:${removedChannelId}`)).toBeUndefined();
    expect(rotatedSinceByRoom.get(retainedChannelId)).toBe(START_SECONDS);
    expect(await store.lookup(`room:${replacementChannelId}`)).toEqual({
      seconds: START_SECONDS + 60,
    });
  });

  it("rejects recovery when an existing room cursor cannot be read", async () => {
    const store = openBuzzRecoveryWatermarkStore({ accountId: ACCOUNT_ID });
    await store.register(`room:${SECOND_CHANNEL_ID}`, { seconds: START_SECONDS - 60 });
    vi.spyOn(store, "lookup").mockRejectedValueOnce(new Error("first room cursor unavailable"));
    await expect(
      resolveBuzzRecoverySince({
        store,
        channelIds: [CHANNEL_ID, SECOND_CHANNEL_ID],
        nowSeconds: START_SECONDS,
        lookbackSeconds: LOOKBACK_SECONDS,
      }),
    ).rejects.toThrow("first room cursor unavailable");
  });

  it("rejects recovery when a persisted room activation floor is invalid", async () => {
    const store = openBuzzRecoveryWatermarkStore({ accountId: ACCOUNT_ID });
    await store.register(`room:${CHANNEL_ID}`, { seconds: "corrupt" } as never);

    await expect(
      resolveBuzzRecoverySince({
        store,
        channelIds: [CHANNEL_ID],
        nowSeconds: START_SECONDS,
        lookbackSeconds: LOOKBACK_SECONDS,
      }),
    ).rejects.toThrow(`Invalid Buzz recovery watermark for room ${CHANNEL_ID}`);
  });

  it("recovers a later-arriving room message with an older sender timestamp", async () => {
    await runGatewayProcess();

    openProcessBoundary();
    postRoomMessage("newer-msg", START_SECONDS + 200);
    advanceSeconds(600);
    await runGatewayProcess({ until: () => handled.includes("newer-msg") });

    openProcessBoundary();
    postRoomMessage("older-late-msg", START_SECONDS + 100);
    advanceSeconds(600);
    await runGatewayProcess({ until: () => handled.includes("older-late-msg") });

    expect(handled).toContain("older-late-msg");
    expect(roomSubscriptionSince()).toBeLessThanOrEqual(START_SECONDS + 100);
  });

  it("keeps every supported room for a second account after the first one saturates", async () => {
    const saturate = async (accountId: string) => {
      const channelIds = Array.from(
        { length: BUZZ_MAX_CONFIGURED_ROOMS },
        (_value, index) => `${accountId}-room-${index}`,
      );
      const store = openBuzzRecoveryWatermarkStore({ accountId });
      const sinceByRoom = await resolveBuzzRecoverySince({
        store,
        channelIds,
        nowSeconds: START_SECONDS,
        lookbackSeconds: LOOKBACK_SECONDS,
      });
      return { store, sinceByRoom, lastChannelId: channelIds.at(-1) as string };
    };

    const first = await saturate(ACCOUNT_ID);
    const second = await saturate(SECOND_ACCOUNT_ID);

    expect(first.sinceByRoom.size).toBe(BUZZ_MAX_CONFIGURED_ROOMS);
    expect(second.sinceByRoom.size).toBe(BUZZ_MAX_CONFIGURED_ROOMS);
    expect(await first.store.lookup(`room:${first.lastChannelId}`)).toEqual({
      seconds: START_SECONDS,
    });
    expect(await second.store.lookup(`room:${second.lastChannelId}`)).toEqual({
      seconds: START_SECONDS,
    });
  });

  it("keeps room activation floors scoped to their account", async () => {
    const firstStore = openBuzzRecoveryWatermarkStore({ accountId: ACCOUNT_ID });
    const secondStore = openBuzzRecoveryWatermarkStore({ accountId: SECOND_ACCOUNT_ID });
    await resolveBuzzRecoverySince({
      store: firstStore,
      channelIds: [CHANNEL_ID],
      nowSeconds: START_SECONDS,
      lookbackSeconds: LOOKBACK_SECONDS,
    });
    await resolveBuzzRecoverySince({
      store: secondStore,
      channelIds: [CHANNEL_ID],
      nowSeconds: START_SECONDS + 500,
      lookbackSeconds: LOOKBACK_SECONDS,
    });

    expect(await firstStore.lookup(`room:${CHANNEL_ID}`)).toEqual({ seconds: START_SECONDS });
    expect(await secondStore.lookup(`room:${CHANNEL_ID}`)).toEqual({
      seconds: START_SECONDS + 500,
    });
  });

  it("keeps a room configured after the first start at the current time", async () => {
    await runGatewayProcess();

    openProcessBoundary();
    postRoomMessage("before-second-room-setup", START_SECONDS + 60, SECOND_CHANNEL_ID);
    advanceSeconds(600);
    await runGatewayProcess({ channelIds: [CHANNEL_ID, SECOND_CHANNEL_ID] });
    expect(roomSubscriptionSince(SECOND_CHANNEL_ID)).toBe(nowSeconds());
    expect(handled).not.toContain("before-second-room-setup");
    expect(roomSubscriptionSince(CHANNEL_ID)).toBe(START_SECONDS);
  });

  it("recovers a replay message still queued when the process stops", async () => {
    await runGatewayProcess();

    openProcessBoundary();
    const queuedText = "queued-msg";
    postRoomMessage(queuedText, START_SECONDS + 100);
    gateHandler(queuedText);
    const settlers = [];
    for (let index = 0; index < 8; index += 1) {
      const text = `running-msg-${index}`;
      postRoomMessage(text, START_SECONDS + 200 + index);
      settlers.push(gateHandler(text));
    }
    advanceSeconds(600);
    const gatewayProcess = startGatewayProcess();
    await waitForSettled(() => handled.length === 8);
    expect(handled).not.toContain(queuedText);
    for (const settler of settlers) {
      settler.settle();
    }
    gatewayProcess.abort.abort();
    await gatewayProcess.lifecycle;
    expect(await readWatermark()).toBe(START_SECONDS);

    openProcessBoundary();
    advanceSeconds(600);
    await runGatewayProcess({ until: () => handled.includes(queuedText) });
    expect(handled).toContain(queuedText);
  });

  it("clamps a stale room activation floor to the existing recovery lookback", async () => {
    await runGatewayProcess();

    openProcessBoundary();
    postRoomMessage("live-msg", START_SECONDS + 10);
    advanceSeconds(600);
    await runGatewayProcess({ until: () => handled.includes("live-msg") });

    openProcessBoundary();
    advanceSeconds(72 * 60 * 60);
    await runGatewayProcess();
    expect(roomSubscriptionSince()).toBe(nowSeconds() - LOOKBACK_SECONDS);
  });

  it("keeps pre-activation history excluded when the same process reconnects", async () => {
    postRoomMessage("before-activation", START_SECONDS - 60);
    relayMocks.connect.mockImplementationOnce(async () => {});
    relayMocks.connect.mockImplementationOnce(async () => {
      postRoomMessage("after-reconnect", START_SECONDS + 1);
    });
    relayMocks.dropSubscriptionReason = "relay dropped the subscription";
    const process = startGatewayProcess();
    try {
      await waitForSettled(() => handled.includes("after-reconnect"));
      expect(handled).not.toContain("before-activation");
      expect(relayMocks.messageFilters.at(1)?.since).toBe(START_SECONDS);
    } finally {
      process.abort.abort();
      await process.lifecycle;
    }
  });

  it("recovers downtime messages after a sender supplies a future timestamp", async () => {
    await runGatewayProcess();

    openProcessBoundary();
    postRoomMessage("backlog-msg", START_SECONDS + 300);
    postRoomMessage("future-msg", START_SECONDS + 3_600);
    advanceSeconds(600);
    await runGatewayProcess({
      until: () => handled.includes("backlog-msg") && handled.includes("future-msg"),
    });
    expect(handled).toEqual(expect.arrayContaining(["backlog-msg", "future-msg"]));
    expect(await readWatermark()).toBe(START_SECONDS);

    openProcessBoundary();
    postRoomMessage("outage-msg", START_SECONDS + 900);
    advanceSeconds(6_600);
    await runGatewayProcess({ until: () => handled.includes("outage-msg") });
    expect(handled).toContain("outage-msg");
  });

  it("retries a previously failed room message after a process restart", async () => {
    await runGatewayProcess();

    openProcessBoundary();
    postRoomMessage("fail-msg", START_SECONDS + 100);
    postRoomMessage("ok-msg", START_SECONDS + 200);
    const failing = gateHandler("fail-msg");
    const succeeding = gateHandler("ok-msg");
    advanceSeconds(600);
    const gatewayProcess = startGatewayProcess();
    await waitForSettled(() => handled.includes("fail-msg") && handled.includes("ok-msg"));
    failing.fail(new Error("agent dispatch failed"));
    succeeding.settle();
    gatewayProcess.abort.abort();
    await gatewayProcess.lifecycle;

    openProcessBoundary();
    advanceSeconds(600);
    await runGatewayProcess({ until: () => handled.includes("fail-msg") });
    expect(roomSubscriptionSince()).toBe(START_SECONDS);
    expect(handled).toContain("fail-msg");
  });
});
