import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartAccountContext } from "../../../test/helpers/plugins/start-account-context.js";
import type { PluginRuntime } from "../runtime-api.js";
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
  const sendDm = vi.fn(async () => {});
  const bus = {
    sendDm,
    close: vi.fn(),
    getMetrics: vi.fn(() => ({ counters: {} })),
    publishProfile: vi.fn(),
    getProfileState: vi.fn(async () => null),
  };
  mocks.startNostrBus.mockResolvedValueOnce(bus as unknown);

  const cleanup = (await startNostrGatewayAccount(
    createStartAccountContext({
      account: buildResolvedNostrAccount(accountId ? { accountId } : undefined),
    }),
  )) as { stop: () => void };

  return { cleanup, sendDm };
}

describe("nostr outbound cfg threading", () => {
  afterEach(() => {
    mocks.normalizePubkey.mockClear();
    mocks.startNostrBus.mockReset();
  });

  it("uses resolved cfg when converting markdown tables before send", async () => {
    const { resolveMarkdownTableMode, convertMarkdownTables } = installOutboundRuntime(
      vi.fn((text: string) => `converted:${text}`),
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
    expect(sendDm).toHaveBeenCalledWith("normalized-npub123", "converted:|a|b|");

    cleanup.stop();
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

    cleanup.stop();
  });
});
