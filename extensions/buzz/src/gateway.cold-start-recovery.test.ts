import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelGatewayContext } from "../runtime-api.js";
import type { BuzzBus } from "./buzz-bus.js";
import type { BuzzInboundMessage } from "./message-event.js";
import type { ResolvedBuzzAccount } from "./types.js";

const coldStartMocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  busSendText: vi.fn(async () => "event-id"),
  sendBuzzTextOneShot: vi.fn(async () => "standalone-event-id"),
  startBuzzBus: vi.fn(),
  onMessage: undefined as
    | ((message: BuzzInboundMessage, bus: BuzzBus, signal?: AbortSignal) => Promise<void>)
    | undefined,
}));

vi.mock("./buzz-bus.js", () => ({
  sendBuzzTextOneShot: coldStartMocks.sendBuzzTextOneShot,
  startBuzzBus: coldStartMocks.startBuzzBus,
}));

vi.mock("./inbound.js", () => ({
  handleBuzzInbound: vi.fn(async () => {}),
}));

import { startBuzzGatewayAccount } from "./gateway.js";
import { setBuzzRuntime } from "./runtime.js";
import { resolveBuzzAccount } from "./types.js";

const CHANNEL_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const PRIVATE_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const LOOKBACK_SECONDS = 24 * 60 * 60;

let tempDir: string | undefined;
let previousStateDir: string | undefined;
let currentNowMs = 0;

function nowSeconds(): number {
  return Math.floor(currentNowMs / 1000);
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

function installRuntime() {
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
}

async function runGatewayProcess(params: {
  deliver?: BuzzInboundMessage;
}): Promise<{ since: number }> {
  const cfg = buildConfig();
  const account = resolveBuzzAccount({ cfg });
  const abortController = new AbortController();
  const ctx = {
    cfg,
    accountId: account.accountId,
    account,
    runtime: {},
    abortSignal: abortController.signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getStatus: vi.fn(),
    setStatus: vi.fn(),
  } as unknown as ChannelGatewayContext<ResolvedBuzzAccount>;

  const lifecycle = startBuzzGatewayAccount(ctx);
  await vi.waitFor(() => expect(coldStartMocks.startBuzzBus).toHaveBeenCalledOnce());
  const since = coldStartMocks.startBuzzBus.mock.calls[0]?.[0].since as number;
  if (params.deliver) {
    await coldStartMocks.onMessage?.(
      params.deliver,
      {
        publicKey: "a".repeat(64),
        sendText: coldStartMocks.busSendText,
        close: coldStartMocks.close,
      },
      abortController.signal,
    );
  }
  abortController.abort();
  await lifecycle;
  return { since };
}

function buildMessage(createdAt: number): BuzzInboundMessage {
  return {
    id: `event-${createdAt}`,
    senderPubkey: "b".repeat(64),
    text: "outage message",
    channelId: CHANNEL_ID,
    createdAt,
    mentionedPubkeys: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentNowMs = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => currentNowMs);
  previousStateDir = process.env.OPENCLAW_STATE_DIR;
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-buzz-coldstart-"));
  process.env.OPENCLAW_STATE_DIR = tempDir;
  coldStartMocks.onMessage = undefined;
  installRuntime();
  coldStartMocks.startBuzzBus.mockImplementation(
    async (options: {
      onMessage: (message: BuzzInboundMessage, bus: BuzzBus, signal?: AbortSignal) => Promise<void>;
    }): Promise<BuzzBus> => {
      coldStartMocks.onMessage = options.onMessage;
      return {
        publicKey: "a".repeat(64),
        sendText: coldStartMocks.busSendText,
        close: coldStartMocks.close,
      };
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  tempDir = undefined;
});

describe("Buzz gateway cold-start recovery", () => {
  it("replays downtime messages after a process restart", async () => {
    const startedAt = nowSeconds();
    const first = await runGatewayProcess({});
    expect(first.since).toBe(startedAt);

    const admittedAt = startedAt + 10;
    coldStartMocks.startBuzzBus.mockClear();
    await runGatewayProcess({ deliver: buildMessage(admittedAt) });

    const outageAt = admittedAt + 60 * 60;
    currentNowMs += 2 * 60 * 60 * 1_000;
    coldStartMocks.startBuzzBus.mockClear();
    const restarted = await runGatewayProcess({});
    expect(restarted.since).toBe(admittedAt);
    expect(restarted.since).toBeLessThanOrEqual(outageAt);
  });

  it("keeps the first-ever start at the current time", async () => {
    const startedAt = nowSeconds();
    const first = await runGatewayProcess({});
    expect(first.since).toBe(startedAt);
  });

  it("clamps a stale watermark to the retention floor", async () => {
    const startedAt = nowSeconds();
    await runGatewayProcess({});
    coldStartMocks.startBuzzBus.mockClear();
    await runGatewayProcess({ deliver: buildMessage(startedAt + 10) });

    currentNowMs += 72 * 60 * 60 * 1_000;
    coldStartMocks.startBuzzBus.mockClear();
    const restarted = await runGatewayProcess({});
    expect(restarted.since).toBe(nowSeconds() - LOOKBACK_SECONDS);
  });

  it("keeps the full backlog lookback on an in-process reconnect", async () => {
    const cfg = buildConfig();
    const account = resolveBuzzAccount({ cfg });
    const abortController = new AbortController();
    let reportFatal: ((error: Error) => void) | undefined;
    coldStartMocks.startBuzzBus.mockImplementation(
      async (options: {
        onMessage: (message: BuzzInboundMessage, bus: BuzzBus) => Promise<void>;
        onFatalError?: (error: Error) => void;
      }): Promise<BuzzBus> => {
        coldStartMocks.onMessage = options.onMessage;
        reportFatal = options.onFatalError;
        return {
          publicKey: "a".repeat(64),
          sendText: coldStartMocks.busSendText,
          close: coldStartMocks.close,
        };
      },
    );
    const ctx = {
      cfg,
      accountId: account.accountId,
      account,
      runtime: {},
      abortSignal: abortController.signal,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getStatus: vi.fn(),
      setStatus: vi.fn(),
    } as unknown as ChannelGatewayContext<ResolvedBuzzAccount>;

    const lifecycle = startBuzzGatewayAccount(ctx);
    await vi.waitFor(() => expect(coldStartMocks.startBuzzBus).toHaveBeenCalledOnce());
    reportFatal?.(new Error("relay failed"));
    await vi.waitFor(() => expect(coldStartMocks.startBuzzBus).toHaveBeenCalledTimes(2), {
      timeout: 5_000,
    });
    const reconnectSince = coldStartMocks.startBuzzBus.mock.calls[1]?.[0].since as number;
    expect(reconnectSince).toBe(nowSeconds() - LOOKBACK_SECONDS);

    abortController.abort();
    await lifecycle;
  });
});
