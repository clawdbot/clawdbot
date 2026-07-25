// Tests pairing challenge creation, validation, and reply formatting.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createMockPluginRegistry } from "../plugins/hooks.test-fixtures.js";
import { issuePairingChallenge } from "./pairing-challenge.js";

describe("issuePairingChallenge", () => {
  afterEach(() => {
    resetGlobalHookRunner();
  });

  function createBaseChallengeParams() {
    return {
      channel: "forum",
      senderId: "123",
      senderIdLine: "Your forum user id: 123",
    } as const;
  }

  async function issueChallengeAndCaptureReply(
    params: Omit<Parameters<typeof issuePairingChallenge>[0], "sendPairingReply">,
  ) {
    const sent: string[] = [];
    const result = await issuePairingChallenge({
      ...params,
      sendPairingReply: async (text) => {
        sent.push(text);
      },
    });
    return { result, sent };
  }

  function expectReplyTexts(sent: string[], expectedTexts: readonly string[]) {
    expect(sent).toEqual([...expectedTexts]);
  }

  function expectReplyContaining(sent: string[], expectedText: string) {
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(expectedText);
  }

  async function expectIssuedChallengeCase(params: {
    issueParams: Omit<Parameters<typeof issuePairingChallenge>[0], "sendPairingReply">;
    expectedResult: Awaited<ReturnType<typeof issuePairingChallenge>>;
    assertReply?: (sent: string[]) => void;
    sendPairingReply?: Parameters<typeof issuePairingChallenge>[0]["sendPairingReply"];
    assertResult?: () => void;
  }) {
    if (params.sendPairingReply) {
      const result = await issuePairingChallenge({
        ...params.issueParams,
        sendPairingReply: params.sendPairingReply,
      });
      expect(result).toEqual(params.expectedResult);
      params.assertResult?.();
      return;
    }

    const { result, sent } = await issueChallengeAndCaptureReply(params.issueParams);
    expect(result).toEqual(params.expectedResult);
    params.assertReply?.(sent);
    params.assertResult?.();
  }

  it.each([
    {
      name: "creates and sends a pairing reply when request is newly created",
      issueParams: {
        ...createBaseChallengeParams(),
        upsertPairingRequest: async () => ({ code: "ABCD", created: true }),
      },
      expectedResult: { created: true, code: "ABCD" },
      assertReply: (sent: string[]) => {
        expectReplyContaining(sent, "ABCD");
      },
    },
    {
      name: "supports custom reply text builder",
      issueParams: {
        channel: "line",
        senderId: "u1",
        senderIdLine: "Your line id: u1",
        upsertPairingRequest: async () => ({ code: "ZXCV", created: true }),
        buildReplyText: ({ code }: { code: string }) => `custom ${code}`,
      },
      expectedResult: { created: true, code: "ZXCV" },
      assertReply: (sent: string[]) => {
        expectReplyTexts(sent, ["custom ZXCV"]);
      },
    },
  ] as const)("$name", async ({ issueParams, expectedResult, assertReply }) => {
    await expectIssuedChallengeCase({
      issueParams,
      expectedResult,
      assertReply,
    });
  });

  it.each([
    {
      name: "does not send a reply when request already exists",
      setup: () => {
        const sendPairingReply = vi.fn(async () => {});
        return {
          issueParams: {
            ...createBaseChallengeParams(),
            upsertPairingRequest: async () => ({ code: "ABCD", created: false }),
          },
          sendPairingReply,
          expectedResult: { created: false },
          assertResult: () => {
            expect(sendPairingReply).not.toHaveBeenCalled();
          },
        };
      },
    },
    {
      name: "calls onCreated and forwards meta to upsert",
      setup: () => {
        const onCreated = vi.fn();
        const upsert = vi.fn(async () => ({ code: "1111", created: true }));
        return {
          issueParams: {
            channel: "guildchat",
            senderId: "42",
            senderIdLine: "Your guildchat user id: 42",
            meta: { name: "alice" },
            upsertPairingRequest: upsert,
            onCreated,
          },
          sendPairingReply: async () => {},
          expectedResult: { created: true, code: "1111" },
          assertResult: () => {
            expect(upsert).toHaveBeenCalledWith({ id: "42", meta: { name: "alice" } });
            expect(onCreated).toHaveBeenCalledWith({ code: "1111" });
          },
        };
      },
    },
    {
      name: "captures reply errors through onReplyError",
      setup: () => {
        const onReplyError = vi.fn();
        return {
          issueParams: {
            channel: "quietchat",
            senderId: "+1555",
            senderIdLine: "Your quietchat sender id: +1555",
            upsertPairingRequest: async () => ({ code: "9999", created: true }),
            onReplyError,
          },
          sendPairingReply: async () => {
            throw new Error("send failed");
          },
          expectedResult: { created: true, code: "9999" },
          assertResult: () => {
            expect(onReplyError).toHaveBeenCalledTimes(1);
          },
        };
      },
    },
  ] as const)("$name", async ({ setup }) => {
    await expectIssuedChallengeCase(setup());
  });

  it("fires channel_pairing_requested only for newly created requests", async () => {
    const handler = vi.fn(async () => {});
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "channel_pairing_requested",
          handler,
        },
      ]),
    );

    await issuePairingChallenge({
      ...createBaseChallengeParams(),
      accountId: "alerts",
      meta: { username: "alice" },
      upsertPairingRequest: async () => ({ code: "HOOK1234", created: true }),
      sendPairingReply: async () => {},
    });
    await issuePairingChallenge({
      ...createBaseChallengeParams(),
      accountId: "alerts",
      upsertPairingRequest: async () => ({ code: "EXISTS12", created: false }),
      sendPairingReply: async () => {},
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      {
        channel: "forum",
        accountId: "alerts",
        senderId: "123",
        code: "HOOK1234",
        metadata: { username: "alice" },
      },
      {
        channelId: "forum",
        accountId: "alerts",
        senderId: "123",
      },
    );
  });

  it("does not block pairing replies when pairing-request hooks fail or stall", async () => {
    const throwingHook = vi.fn(() => {
      throw new Error("notification failed");
    });
    const stallingHook = vi.fn(() => new Promise<void>(() => {}));
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "channel_pairing_requested",
          handler: throwingHook,
          pluginId: "throwing",
        },
        {
          hookName: "channel_pairing_requested",
          handler: stallingHook,
          pluginId: "stalling",
        },
      ]),
    );
    const sendPairingReply = vi.fn(async () => {});

    const result = await issuePairingChallenge({
      ...createBaseChallengeParams(),
      upsertPairingRequest: async () => ({ code: "FAST1234", created: true }),
      sendPairingReply,
    });

    expect(result).toEqual({ created: true, code: "FAST1234" });
    expect(throwingHook).toHaveBeenCalledTimes(1);
    expect(stallingHook).toHaveBeenCalledTimes(1);
    expect(sendPairingReply).toHaveBeenCalledTimes(1);
  });
});
