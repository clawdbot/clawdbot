// Signal tests cover message actions plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendReactionsModule = await import("./send-reactions.js");
const sendReactionSignalMock = vi
  .spyOn(sendReactionsModule, "sendReactionSignal")
  .mockResolvedValue({ ok: true });
const removeReactionSignalMock = vi
  .spyOn(sendReactionsModule, "removeReactionSignal")
  .mockResolvedValue({ ok: true });
const { signalMessageActions } = await import("./message-actions.js");

function createSignalAccountOverrideCfg(): OpenClawConfig {
  return {
    channels: {
      signal: {
        account: "+15550002222",
        actions: { reactions: false },
        accounts: {
          work: { account: "+15550001111", actions: { reactions: true } },
        },
      },
    },
  } as OpenClawConfig;
}

describe("signalMessageActions", () => {
  beforeEach(() => {
    sendReactionSignalMock.mockClear();
    removeReactionSignalMock.mockClear();
  });

  it("lists actions based on configured accounts and reaction gates", () => {
    expect(
      signalMessageActions.describeMessageTool?.({ cfg: {} as OpenClawConfig })?.actions ?? [],
    ).toStrictEqual([]);

    expect(
      signalMessageActions.describeMessageTool?.({
        cfg: {
          channels: { signal: { account: "+15550001111", actions: { reactions: false } } },
        } as OpenClawConfig,
      })?.actions,
    ).toEqual(["send"]);

    expect(
      signalMessageActions.describeMessageTool?.({ cfg: createSignalAccountOverrideCfg() })
        ?.actions,
    ).toEqual(["send", "react"]);
  });

  it("honors account-scoped reaction gates during discovery", () => {
    const cfg = createSignalAccountOverrideCfg();

    expect(
      signalMessageActions.describeMessageTool?.({ cfg, accountId: "default" })?.actions,
    ).toEqual(["send"]);
    expect(signalMessageActions.describeMessageTool?.({ cfg, accountId: "work" })?.actions).toEqual(
      ["send", "react"],
    );
  });

  it("supports only reactions for plugin dispatch", () => {
    expect(signalMessageActions.supportsAction?.({ action: "send" })).toBe(false);
    expect(signalMessageActions.supportsAction?.({ action: "react" })).toBe(true);
    expect(signalMessageActions.supportsAction?.({ action: "delete" })).toBe(false);
    expect(signalMessageActions.supportsAction?.({ action: "pin" })).toBe(false);
  });

  it("keeps inherited Signal reply ids in the durable delivery context", async () => {
    const prepared = await signalMessageActions.prepareSendPayload?.({
      ctx: {
        channel: "signal",
        action: "send",
        cfg: {} as OpenClawConfig,
        params: { replyTo: "1700000000001" },
      },
      to: "+15550001111",
      payload: { text: "reply" },
      replyToId: "1700000000001",
      replyToIdSource: "implicit",
    });

    expect(prepared).toEqual({ text: "reply" });
  });

  it("preserves explicit Signal reply ids that equal the current message", async () => {
    const prepared = await signalMessageActions.prepareSendPayload?.({
      ctx: {
        channel: "signal",
        action: "send",
        cfg: {} as OpenClawConfig,
        params: { replyTo: "1700000000001" },
        toolContext: { currentMessageId: "1700000000001", replyToMode: "first" },
      },
      to: "+15550001111",
      payload: { text: "reply" },
      replyToId: "1700000000001",
      replyToIdSource: "explicit",
    });

    expect(prepared).toEqual({ text: "reply", replyToId: "1700000000001" });
  });

  it("preserves explicit Signal replies when implicit replies are suppressed", async () => {
    for (const replyToMode of ["off", "batched"] as const) {
      const prepared = await signalMessageActions.prepareSendPayload?.({
        ctx: {
          channel: "signal",
          action: "send",
          cfg: {} as OpenClawConfig,
          params: { replyTo: "1700000000001" },
          toolContext: { currentMessageId: "1700000000001", replyToMode },
        },
        to: "+15550001111",
        payload: { text: "reply" },
        replyToId: "1700000000001",
        replyToIdSource: "explicit",
      });

      expect(prepared, replyToMode).toEqual({ text: "reply", replyToId: "1700000000001" });
    }
  });

  it("blocks reactions when the action gate is disabled", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111", actions: { reactions: false } } },
    } as OpenClawConfig;

    await expect(
      signalMessageActions.handleAction?.({
        channel: "signal",
        action: "react",
        params: { to: "+15550001111", messageId: "123", emoji: "✅" },
        cfg,
      }),
    ).rejects.toThrow(/actions\.reactions/);
  });

  it("maps reaction targets into sendReactionSignal calls", async () => {
    const cases = [
      {
        name: "uses account-level actions when enabled",
        cfg: createSignalAccountOverrideCfg(),
        accountId: "work",
        params: { to: "+15550001111", messageId: "123", emoji: "👍" },
        expectedRecipient: "+15550001111",
        expectedTimestamp: 123,
        expectedEmoji: "👍",
        expectedOptions: { accountId: "work" },
      },
      {
        name: "normalizes uuid recipients",
        cfg: { channels: { signal: { account: "+15550001111" } } } as OpenClawConfig,
        params: {
          recipient: "uuid:123e4567-e89b-12d3-a456-426614174000",
          messageId: "123",
          emoji: "🔥",
        },
        expectedRecipient: "123e4567-e89b-12d3-a456-426614174000",
        expectedTimestamp: 123,
        expectedEmoji: "🔥",
        expectedOptions: {},
      },
      {
        name: "passes groupId and targetAuthor for group reactions",
        cfg: { channels: { signal: { account: "+15550001111" } } } as OpenClawConfig,
        params: {
          to: "signal:group:group-id",
          targetAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
          messageId: "123",
          emoji: "✅",
        },
        expectedRecipient: "",
        expectedTimestamp: 123,
        expectedEmoji: "✅",
        expectedOptions: {
          groupId: "group-id",
          targetAuthor: "uuid:123e4567-e89b-12d3-a456-426614174000",
        },
      },
      {
        name: "falls back to toolContext.currentMessageId when messageId is omitted",
        cfg: { channels: { signal: { account: "+15550001111" } } } as OpenClawConfig,
        params: { to: "+15559999999", emoji: "🔥" },
        expectedRecipient: "+15559999999",
        expectedTimestamp: 1737630212345,
        expectedEmoji: "🔥",
        expectedOptions: {},
        toolContext: { currentMessageId: "1737630212345" },
      },
    ] as const;

    for (const testCase of cases) {
      sendReactionSignalMock.mockClear();
      const expectedOptions = testCase.expectedOptions as {
        accountId?: string;
        groupId?: string;
        targetAuthor?: string;
        targetAuthorUuid?: string;
      };
      await signalMessageActions.handleAction?.({
        channel: "signal",
        action: "react",
        params: testCase.params,
        cfg: testCase.cfg,
        accountId: "accountId" in testCase ? testCase.accountId : undefined,
        toolContext: "toolContext" in testCase ? testCase.toolContext : undefined,
      });

      expect(sendReactionSignalMock, testCase.name).toHaveBeenCalledWith(
        testCase.expectedRecipient,
        testCase.expectedTimestamp,
        testCase.expectedEmoji,
        {
          cfg: testCase.cfg,
          accountId: expectedOptions.accountId,
          groupId: expectedOptions.groupId,
          targetAuthor: expectedOptions.targetAuthor,
          targetAuthorUuid: expectedOptions.targetAuthorUuid,
        },
      );
    }
  });

  it("rejects invalid reaction inputs before dispatch", async () => {
    const cfg = {
      channels: { signal: { account: "+15550001111" } },
    } as OpenClawConfig;

    await expect(
      signalMessageActions.handleAction?.({
        channel: "signal",
        action: "react",
        params: { to: "+15559999999", emoji: "✅" },
        cfg,
      }),
    ).rejects.toThrow(/messageId.*required/);

    await expect(
      signalMessageActions.handleAction?.({
        channel: "signal",
        action: "react",
        params: { to: "+15559999999", messageId: "123abc", emoji: "✅" },
        cfg,
      }),
    ).rejects.toThrow(/Invalid messageId/);
    expect(sendReactionSignalMock).not.toHaveBeenCalled();

    await expect(
      signalMessageActions.handleAction?.({
        channel: "signal",
        action: "react",
        params: { to: "signal:group:group-id", messageId: "123", emoji: "✅" },
        cfg,
      }),
    ).rejects.toThrow(/targetAuthor/);
  });
});
