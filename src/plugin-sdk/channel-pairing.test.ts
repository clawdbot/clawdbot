/**
 * Tests channel pairing helpers and pairing reply behavior.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import {
  createChannelPairingChallengeIssuer,
  createChannelPairingController,
} from "./channel-pairing.js";

function createReplyCollector() {
  const replies: string[] = [];
  return {
    replies,
    sendPairingReply: vi.fn(async (text: string) => {
      replies.push(text);
    }),
  };
}

afterEach(() => {
  resetGlobalHookRunner();
});

describe("createChannelPairingController", () => {
  it("scopes store access and issues pairing challenges through the scoped store", async () => {
    const readAllowFromStore = vi.fn(async () => ["alice"]);
    const upsertPairingRequest = vi.fn(async () => ({ code: "123456", created: true }));
    const { replies, sendPairingReply } = createReplyCollector();
    const runtime = {
      channel: {
        pairing: {
          readAllowFromStore,
          upsertPairingRequest,
        },
      },
    } as unknown as PluginRuntime;

    const pairing = createChannelPairingController({
      core: runtime,
      channel: "googlechat",
      accountId: "Primary",
    });

    await expect(pairing.readAllowFromStore()).resolves.toEqual(["alice"]);
    await pairing.issueChallenge({
      senderId: "user-1",
      senderIdLine: "Your id: user-1",
      sendPairingReply,
    });

    expect(readAllowFromStore).toHaveBeenCalledWith({
      channel: "googlechat",
      accountId: "primary",
    });
    expect(upsertPairingRequest).toHaveBeenCalledWith({
      channel: "googlechat",
      accountId: "primary",
      id: "user-1",
      meta: undefined,
    });
    expect(sendPairingReply).toHaveBeenCalledTimes(1);
    expect(replies[0]).toContain("123456");
  });

  it("passes the scoped account id to channel_pairing_requested hooks", async () => {
    const handler = vi.fn(async () => {});
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "channel_pairing_requested", handler }]),
    );
    const runtime = {
      channel: {
        pairing: {
          readAllowFromStore: vi.fn(async () => []),
          upsertPairingRequest: vi.fn(async () => ({ code: "ACCT1234", created: true })),
        },
      },
    } as unknown as PluginRuntime;

    const pairing = createChannelPairingController({
      core: runtime,
      channel: "googlechat",
      accountId: "Primary",
    });

    await pairing.issueChallenge({
      senderId: "user-1",
      senderIdLine: "Your id: user-1",
      sendPairingReply: async () => {},
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "googlechat",
        accountId: "primary",
        senderId: "user-1",
        code: "ACCT1234",
      }),
      expect.objectContaining({
        channelId: "googlechat",
        accountId: "primary",
        senderId: "user-1",
      }),
    );
  });
});

describe("createChannelPairingChallengeIssuer", () => {
  it("binds a channel and scoped pairing store to challenge issuance", async () => {
    const upsertPairingRequest = vi.fn(async () => ({ code: "654321", created: true }));
    const { replies, sendPairingReply } = createReplyCollector();
    const issueChallenge = createChannelPairingChallengeIssuer({
      channel: "quietchat",
      upsertPairingRequest,
    });

    await issueChallenge({
      senderId: "user-2",
      senderIdLine: "Your id: user-2",
      sendPairingReply,
    });

    expect(upsertPairingRequest).toHaveBeenCalledWith({
      id: "user-2",
      meta: undefined,
    });
    expect(replies[0]).toContain("654321");
  });

  it("normalizes account ids before sending channel_pairing_requested hooks", async () => {
    const handler = vi.fn(async () => {});
    initializeGlobalHookRunner(
      createMockPluginRegistry([{ hookName: "channel_pairing_requested", handler }]),
    );
    const issueChallenge = createChannelPairingChallengeIssuer({
      channel: "quietchat",
      accountId: "Alerts",
      upsertPairingRequest: vi.fn(async () => ({ code: "NORM1234", created: true })),
    });

    await issueChallenge({
      senderId: "user-3",
      senderIdLine: "Your id: user-3",
      sendPairingReply: async () => {},
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "quietchat",
        accountId: "alerts",
        senderId: "user-3",
      }),
      expect.objectContaining({
        channelId: "quietchat",
        accountId: "alerts",
        senderId: "user-3",
      }),
    );
  });
});
