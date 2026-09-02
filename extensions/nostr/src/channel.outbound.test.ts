import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
// Nostr tests cover channel.outbound plugin behavior.
import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-outbound";
import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import { nostrPlugin } from "./channel.js";
import { nostrOutboundAdapter, startNostrGatewayAccount } from "./gateway.js";
import { setNostrRuntime } from "./runtime.js";
import { TEST_RESOLVED_PRIVATE_KEY, buildResolvedNostrAccount } from "./test-fixtures.js";

const mocks = vi.hoisted(() => ({
  normalizePubkey: vi.fn((value: string) => `normalized-${value.toLowerCase()}`),
  startNostrBus: vi.fn(),
}));

vi.mock("./nostr-bus.js", () => ({
  DEFAULT_RELAYS: ["wss://relay.example.com"],
  startNostrBus: mocks.startNostrBus,
}));

vi.mock("./nostr-key-utils.js", () => ({
  getPublicKeyFromPrivate: vi.fn(() => "pubkey"),
  normalizePubkey: mocks.normalizePubkey,
}));

function createCfg() {
  return {
    channels: {
      nostr: {
        privateKey: TEST_RESOLVED_PRIVATE_KEY, // pragma: allowlist secret
      },
    },
  };
}

function installOutboundRuntime(convertMarkdownTables = vi.fn((text: string) => text)) {
  const resolveMarkdownTableMode = vi.fn(() => "off");
  setNostrRuntime({
    channel: {
      text: {
        resolveMarkdownTableMode,
        convertMarkdownTables,
      },
    },
    reply: {},
  } as unknown as PluginRuntime);
  return { resolveMarkdownTableMode, convertMarkdownTables };
}

async function startOutboundAccount(accountId?: string) {
  const sendDm = vi.fn(async () => "a".repeat(64));
  const bus = {
    sendDm,
    close: vi.fn(async () => {}),
    getMetrics: vi.fn(() => ({ counters: {} })),
    publishProfile: vi.fn(),
    getProfileState: vi.fn(async () => null),
  };
  mocks.startNostrBus.mockResolvedValueOnce(bus as unknown);
  const abort = new AbortController();
  const context = createStartAccountContext({
    account: buildResolvedNostrAccount(accountId ? { accountId } : undefined),
    abortSignal: abort.signal,
  });
  context.channelRuntime = {
    inbound: { buildContext: buildChannelInboundEventContext },
  } as never;
  const task = startNostrGatewayAccount(context);
  await vi.waitFor(() => {
    expect(mocks.startNostrBus).toHaveBeenCalledTimes(1);
  });
  const cleanup = {
    stop: async () => {
      abort.abort();
      await task;
    },
  };

  return { cleanup, sendDm };
}

describe("nostr outbound cfg threading", () => {
  afterEach(() => {
    mocks.normalizePubkey.mockClear();
    mocks.startNostrBus.mockReset();
  });

  it.each([
    {
      name: "strips an internal tool-failure banner",
      text: "Done.\n⚠️ 🛠️ `search repos (agent)` failed",
      expected: "Done.",
    },
    {
      name: "strips internal tool-call XML",
      text: '<tool_call>{"name":"read","arguments":{"path":"private"}}</tool_call>Done.',
      expected: "Done.",
    },
    {
      name: "strips multiline tool-response scaffolding",
      text: [
        "Before",
        "<function_response>",
        "private output",
        "</function_response>",
        "After",
      ].join("\n"),
      expected: "Before\n\nAfter",
    },
    {
      name: "suppresses an internal-trace-only reply",
      text: "⚠️ 🛠️ `search repos (agent)` failed",
      expected: "",
    },
    {
      name: "preserves ordinary visible prose",
      text: "The relay has two active subscriptions.",
      expected: "The relay has two active subscriptions.",
    },
  ])("$name through the Nostr outbound sanitizer", ({ text, expected }) => {
    const sanitizeText = nostrPlugin.outbound?.sanitizeText;
    expect(sanitizeText).toBeTypeOf("function");
    if (!sanitizeText) {
      throw new Error("Expected Nostr outbound assistant-visible text sanitizer");
    }
    expect(sanitizeText({ text, payload: { text } })).toBe(expected);
  });

  it.each([
    {
      name: "preserves a short reply as one encrypted message",
      text: "Hello from Nostr.",
      expectedChunkCount: 1,
      joinWith: "",
    },
    {
      name: "splits long replies at word boundaries",
      text: `${"word ".repeat(1_200)}final`,
      expectedChunkCount: 2,
      joinWith: " ",
    },
    {
      name: "preserves newline-delimited reply order",
      text: `${"line\n".repeat(1_200)}final`,
      expectedChunkCount: 2,
      joinWith: "\n",
    },
    {
      name: "hard-splits an uninterrupted oversized reply",
      text: "x".repeat(8_001),
      expectedChunkCount: 3,
      joinWith: "",
    },
    {
      name: "preserves Unicode when an odd prefix shifts the chunk boundary",
      text: `a${"😀".repeat(2_500)}`,
      expectedChunkCount: 2,
      joinWith: "",
    },
  ])("$name", ({ text, expectedChunkCount, joinWith }) => {
    const outbound = nostrPlugin.outbound;
    const textChunkLimit = outbound?.textChunkLimit;
    expect(textChunkLimit).toBe(4_000);
    expect(outbound?.chunker).toBeTypeOf("function");
    if (!outbound?.chunker || textChunkLimit === undefined) {
      throw new Error("Expected Nostr outbound text chunking");
    }

    const chunks = outbound.chunker(text, textChunkLimit);
    expect(chunks).toHaveLength(expectedChunkCount);
    expect(chunks.every((chunk) => chunk.length <= textChunkLimit)).toBe(true);
    expect(chunks.join(joinWith)).toBe(text);
  });

  it("converts tables before projecting markdown to Nostr plain text", async () => {
    const { resolveMarkdownTableMode, convertMarkdownTables } = installOutboundRuntime(
      vi.fn((text: string) => (text === "***" ? text : "**Table:** [docs](https://example.com)")),
    );
    const { cleanup, sendDm } = await startOutboundAccount();

    const cfg = createCfg();
    await nostrOutboundAdapter.sendText({
      cfg: cfg as OpenClawConfig,
      to: "NPUB123",
      text: "|a|b|",
      accountId: "default",
    });

    expect(resolveMarkdownTableMode).toHaveBeenCalledWith({
      cfg,
      channel: "nostr",
      accountId: "default",
    });
    expect(convertMarkdownTables).toHaveBeenCalledWith("|a|b|", "off");
    expect(mocks.normalizePubkey).toHaveBeenCalledWith("NPUB123");
    expect(sendDm).toHaveBeenCalledWith("normalized-npub123", "Table: docs (https://example.com)");
    await expect(
      nostrOutboundAdapter.sendText({
        cfg: cfg as OpenClawConfig,
        to: "NPUB123",
        text: "***",
        accountId: "default",
      }),
    ).rejects.toThrow("requires non-empty text");

    await cleanup.stop();
  });

  it("uses the configured defaultAccount when accountId is omitted", async () => {
    const { resolveMarkdownTableMode } = installOutboundRuntime();
    const { cleanup, sendDm } = await startOutboundAccount("work");

    const cfg = {
      channels: {
        nostr: {
          privateKey: TEST_RESOLVED_PRIVATE_KEY, // pragma: allowlist secret
          defaultAccount: "work",
        },
      },
    };

    await nostrOutboundAdapter.sendText({
      cfg: cfg as OpenClawConfig,
      to: "NPUB123",
      text: "hello",
    });

    expect(resolveMarkdownTableMode).toHaveBeenCalledWith({
      cfg,
      channel: "nostr",
      accountId: "work",
    });
    expect(sendDm).toHaveBeenCalledWith("normalized-npub123", "hello");

    await cleanup.stop();
  });

  it("returns the relay-confirmed event id in the delivery receipt", async () => {
    installOutboundRuntime();
    const { cleanup, sendDm } = await startOutboundAccount();
    const eventId = "b".repeat(64);
    sendDm.mockResolvedValueOnce(eventId);

    const result = await nostrOutboundAdapter.sendText({
      cfg: createCfg() as OpenClawConfig,
      to: "NPUB123",
      text: "hello",
      accountId: "default",
    });

    expect(result.messageId).toBe(eventId);

    await cleanup.stop();
  });

  it("recognizes uppercase npub targets", () => {
    expect(nostrPlugin.messaging?.targetResolver?.looksLikeId?.("NPUB1XYZ123")).toBe(true);
  });

  it("backs declared message adapter capabilities with outbound sends", async () => {
    installOutboundRuntime();
    const { cleanup, sendDm } = await startOutboundAccount();
    const adapter = nostrPlugin.message;
    if (!adapter?.send?.text) {
      throw new Error("expected Nostr message adapter with text sender");
    }
    const sendText = adapter.send.text;
    expect(adapter.send.media).toBeUndefined();

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "nostrMessageAdapter",
      adapter,
      proofs: {
        text: async () => {
          const result = await sendText({
            cfg: createCfg() as OpenClawConfig,
            to: "NPUB123",
            text: "hello",
            accountId: "default",
          });
          expect(sendDm).toHaveBeenCalledWith("normalized-npub123", "hello");
          expect(result.receipt.parts[0]?.kind).toBe("text");
        },
        messageSendingHooks: () => {
          expect(sendText).toBeTypeOf("function");
        },
      },
    });

    await cleanup.stop();
  });
});
