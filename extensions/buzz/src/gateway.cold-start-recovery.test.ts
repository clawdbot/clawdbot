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
import { openBuzzRecoveryWatermarkStore } from "./recovery-watermark.js";
import { setBuzzRuntime } from "./runtime.js";
import { resolveBuzzAccount } from "./types.js";

const BUZZ_MESSAGE_KIND = 9;
const BUZZ_ROOM_MEMBERSHIP_KIND = 39_002;
const ACCOUNT_ID = "default";
const CHANNEL_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
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

function postRoomMessage(text: string, createdAt: number): void {
  relayMocks.storedEvents.push(
    finalizeEvent(
      {
        kind: BUZZ_MESSAGE_KIND,
        content: text,
        created_at: createdAt,
        tags: [["h", CHANNEL_ID]],
      },
      SENDER_SECRET,
    ),
  );
}

function buildConfig(): OpenClawConfig {
  return {
    channels: {
      buzz: {
        relayUrl: "wss://buzz.example.com",
        privateKey: PRIVATE_KEY,
        groups: { [CHANNEL_ID]: {} },
      },
    },
  } as OpenClawConfig;
}

function startGatewayProcess(): { abort: AbortController; lifecycle: Promise<void> } {
  const cfg = buildConfig();
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
  params: { until?: () => boolean | Promise<boolean> } = {},
): Promise<void> {
  const gatewayProcess = startGatewayProcess();
  await waitForSettled(() => relayMocks.messageFilters.length > 0);
  if (params.until) {
    await waitForSettled(params.until);
  }
  gatewayProcess.abort.abort();
  await gatewayProcess.lifecycle;
}

function roomSubscriptionSince(): number {
  const filter = relayMocks.messageFilters.at(0);
  expect(filter?.since).toBeTypeOf("number");
  return filter?.since as number;
}

async function readWatermark(): Promise<number | undefined> {
  const store = openBuzzRecoveryWatermarkStore();
  return (await store?.lookup(ACCOUNT_ID))?.seconds;
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
  relayMocks.storedEvents = [
    {
      id: "membership-1",
      kind: BUZZ_ROOM_MEMBERSHIP_KIND,
      pubkey: RELAY_PUBLIC_KEY,
      created_at: START_SECONDS - 3_600,
      content: "",
      sig: "e".repeat(128),
      tags: [
        ["d", CHANNEL_ID],
        ["p", BOT_PUBLIC_KEY, "", "bot"],
        ["p", SENDER_PUBLIC_KEY, "", "member"],
      ],
    },
  ];
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
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ self: RELAY_PUBLIC_KEY, software: "https://github.com/block/buzz" }),
    })),
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
  it("resumes from the persisted watermark after a process restart", async () => {
    await runGatewayProcess();
    expect(roomSubscriptionSince()).toBe(START_SECONDS);

    openProcessBoundary();
    postRoomMessage("live-msg", START_SECONDS + 10);
    advanceSeconds(600);
    await runGatewayProcess({
      until: async () => (await readWatermark()) === START_SECONDS + 10,
    });

    openProcessBoundary();
    postRoomMessage("outage-msg", START_SECONDS + 3_610);
    advanceSeconds(7_200);
    await runGatewayProcess({ until: () => handled.includes("outage-msg") });
    expect(roomSubscriptionSince()).toBe(START_SECONDS + 10);
    expect(handled).toContain("outage-msg");
  });

  it("keeps the first-ever start at the current time", async () => {
    postRoomMessage("older-than-setup", START_SECONDS - 60);
    await runGatewayProcess();
    expect(roomSubscriptionSince()).toBe(START_SECONDS);
    expect(handled).toEqual([]);
  });

  it("clamps a stale watermark to the retention floor", async () => {
    await runGatewayProcess();

    openProcessBoundary();
    postRoomMessage("live-msg", START_SECONDS + 10);
    advanceSeconds(600);
    await runGatewayProcess({
      until: async () => (await readWatermark()) === START_SECONDS + 10,
    });

    openProcessBoundary();
    advanceSeconds(72 * 60 * 60);
    await runGatewayProcess();
    expect(roomSubscriptionSince()).toBe(nowSeconds() - LOOKBACK_SECONDS);
  });

  it("keeps the full backlog lookback on an in-process reconnect", async () => {
    relayMocks.dropSubscriptionReason = "relay dropped the subscription";
    const process = startGatewayProcess();
    await waitForSettled(() => relayMocks.messageFilters.length >= 2);
    expect(relayMocks.messageFilters.at(1)?.since).toBe(nowSeconds() - LOOKBACK_SECONDS);
    process.abort.abort();
    await process.lifecycle;
  });

  it("holds the watermark behind an unfinished older message", async () => {
    await runGatewayProcess();

    openProcessBoundary();
    postRoomMessage("older-msg", START_SECONDS + 100);
    postRoomMessage("newer-msg", START_SECONDS + 200);
    const older = gateHandler("older-msg");
    advanceSeconds(600);
    const gatewayProcess = startGatewayProcess();
    await waitForSettled(() => handled.includes("older-msg") && handled.includes("newer-msg"));
    await waitForSettled(async () => (await readWatermark()) === START_SECONDS + 100);

    older.settle();
    await waitForSettled(async () => (await readWatermark()) === START_SECONDS + 200);
    gatewayProcess.abort.abort();
    await gatewayProcess.lifecycle;

    openProcessBoundary();
    advanceSeconds(600);
    await runGatewayProcess();
    expect(roomSubscriptionSince()).toBe(START_SECONDS + 200);
  });

  it("never advances the watermark past locally observed time", async () => {
    await runGatewayProcess();

    openProcessBoundary();
    postRoomMessage("backlog-msg", START_SECONDS + 300);
    postRoomMessage("future-msg", START_SECONDS + 3_600);
    advanceSeconds(600);
    await runGatewayProcess({
      until: async () => (await readWatermark()) === START_SECONDS + 600,
    });
    expect(handled).toEqual(expect.arrayContaining(["backlog-msg", "future-msg"]));
    expect(await readWatermark()).toBeLessThanOrEqual(nowSeconds());

    openProcessBoundary();
    postRoomMessage("outage-msg", START_SECONDS + 900);
    advanceSeconds(6_600);
    await runGatewayProcess({ until: () => handled.includes("outage-msg") });
    expect(handled).toContain("outage-msg");
  });

  it("holds the watermark behind a message whose handling failed", async () => {
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
    await waitForSettled(async () => (await readWatermark()) === START_SECONDS + 100);
    gatewayProcess.abort.abort();
    await gatewayProcess.lifecycle;

    openProcessBoundary();
    advanceSeconds(600);
    await runGatewayProcess({ until: () => handled.includes("fail-msg") });
    expect(roomSubscriptionSince()).toBe(START_SECONDS + 100);
    expect(handled).toContain("fail-msg");
  });
});
