import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { telegramMessageActions, telegramMessageActionRuntime } from "./channel-actions.js";

const handleTelegramActionMock = vi.hoisted(() => vi.fn());
const originalHandleTelegramAction = telegramMessageActionRuntime.handleTelegramAction;

describe("telegramMessageActions", () => {
  beforeEach(() => {
    handleTelegramActionMock.mockReset().mockResolvedValue({
      ok: true,
      content: [],
      details: {},
    });
    telegramMessageActionRuntime.handleTelegramAction = (...args) =>
      handleTelegramActionMock(...args);
  });

  afterEach(() => {
    telegramMessageActionRuntime.handleTelegramAction = originalHandleTelegramAction;
  });

  it("executes message actions in the gateway when a gateway is available", () => {
    for (const action of ["send", "poll", "react", "delete", "edit"] as const) {
      expect(telegramMessageActions.resolveExecutionMode?.({ action })).toBe("gateway");
    }
  });

  it("allows interactive-only sends", async () => {
    await telegramMessageActions.handleAction!({
      action: "send",
      params: {
        to: "123456",
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Approve", value: "approve", style: "success" }],
            },
          ],
        },
      },
      cfg: {} as never,
      accountId: "default",
      mediaLocalRoots: [],
      sessionKey: "telegram-session",
    } as never);

    expect(handleTelegramActionMock).toHaveBeenCalledWith(
      {
        action: "sendMessage",
        to: "123456",
        interactive: {
          blocks: [
            {
              type: "buttons",
              buttons: [{ label: "Approve", value: "approve", style: "success" }],
            },
          ],
        },
        accountId: "default",
      },
      {},
      {
        mediaLocalRoots: [],
        sessionKey: "telegram-session",
      },
    );
  });

  it("computes poll/topic action availability from config gates", () => {
    const cases = [
      {
        name: "configured telegram enables poll",
        cfg: { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig,
        expectPoll: true,
        expectTopicEdit: true,
      },
      {
        name: "sendMessage disabled hides poll",
        cfg: {
          channels: {
            telegram: {
              botToken: "tok",
              actions: { sendMessage: false },
            },
          },
        } as OpenClawConfig,
        expectPoll: false,
        expectTopicEdit: true,
      },
      {
        name: "poll gate disabled hides poll",
        cfg: {
          channels: {
            telegram: {
              botToken: "tok",
              actions: { poll: false },
            },
          },
        } as OpenClawConfig,
        expectPoll: false,
        expectTopicEdit: true,
      },
      {
        name: "split account gates do not expose poll",
        cfg: {
          channels: {
            telegram: {
              accounts: {
                senderOnly: {
                  botToken: "tok-send",
                  actions: {
                    sendMessage: true,
                    poll: false,
                  },
                },
                pollOnly: {
                  botToken: "tok-poll",
                  actions: {
                    sendMessage: false,
                    poll: true,
                  },
                },
              },
            },
          },
        } as OpenClawConfig,
        expectPoll: false,
        expectTopicEdit: true,
      },
    ] as const;

    for (const testCase of cases) {
      const actions =
        telegramMessageActions.describeMessageTool?.({
          cfg: testCase.cfg,
        })?.actions ?? [];
      if (testCase.expectPoll) {
        expect(actions, testCase.name).toContain("poll");
      } else {
        expect(actions, testCase.name).not.toContain("poll");
      }
      if (testCase.expectTopicEdit) {
        expect(actions, testCase.name).toContain("topic-edit");
      } else {
        expect(actions, testCase.name).not.toContain("topic-edit");
      }
    }
  });

  it("lists sticker actions only when enabled by config", () => {
    const cases = [
      {
        name: "default config",
        cfg: { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig,
        expectSticker: false,
      },
      {
        name: "per-account sticker enabled",
        cfg: {
          channels: {
            telegram: {
              accounts: {
                media: { botToken: "tok", actions: { sticker: true } },
              },
            },
          },
        } as OpenClawConfig,
        expectSticker: true,
      },
      {
        name: "all accounts omit sticker",
        cfg: {
          channels: {
            telegram: {
              accounts: {
                a: { botToken: "tok1" },
                b: { botToken: "tok2" },
              },
            },
          },
        } as OpenClawConfig,
        expectSticker: false,
      },
    ] as const;

    for (const testCase of cases) {
      const actions =
        telegramMessageActions.describeMessageTool?.({
          cfg: testCase.cfg,
        })?.actions ?? [];
      if (testCase.expectSticker) {
        expect(actions, testCase.name).toEqual(
          expect.arrayContaining(["sticker", "sticker-search"]),
        );
      } else {
        expect(actions, testCase.name).not.toContain("sticker");
        expect(actions, testCase.name).not.toContain("sticker-search");
      }
    }
  });

  it("honors account-scoped action gates during discovery", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "tok-default",
          actions: {
            reactions: false,
            poll: true,
          },
          accounts: {
            work: {
              botToken: "tok-work",
              actions: {
                reactions: true,
                poll: false,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const defaultActions =
      telegramMessageActions.describeMessageTool?.({
        cfg,
        accountId: "default",
      })?.actions ?? [];
    const workActions =
      telegramMessageActions.describeMessageTool?.({
        cfg,
        accountId: "work",
      })?.actions ?? [];

    expect(defaultActions).toContain("poll");
    expect(defaultActions).not.toContain("react");
    expect(workActions).toContain("react");
    expect(workActions).not.toContain("poll");
  });

  it("normalizes reaction message identifiers before dispatch", async () => {
    const cfg = { channels: { telegram: { botToken: "tok" } } } as OpenClawConfig;
    const cases = [
      {
        name: "numeric channelId/messageId",
        params: {
          channelId: 123,
          messageId: 456,
          emoji: "ok",
        },
        expectedChannelField: "channelId",
        expectedChannelValue: "123",
        expectedMessageId: "456",
      },
      {
        name: "snake_case message_id",
        params: {
          channelId: 123,
          message_id: "456",
          emoji: "ok",
        },
        expectedChannelField: "channelId",
        expectedChannelValue: "123",
        expectedMessageId: "456",
      },
      {
        name: "toolContext fallback",
        params: {
          chatId: "123",
          emoji: "ok",
        },
        toolContext: { currentMessageId: "9001" },
        expectedChannelField: "chatId",
        expectedChannelValue: "123",
        expectedMessageId: "9001",
      },
      {
        name: "missing messageId soft-falls through",
        params: {
          chatId: "123",
          emoji: "ok",
        },
        expectedChannelField: "chatId",
        expectedChannelValue: "123",
        expectedMessageId: undefined,
      },
    ] as const;

    for (const testCase of cases) {
      handleTelegramActionMock.mockClear();
      await telegramMessageActions.handleAction?.({
        channel: "telegram",
        action: "react",
        params: testCase.params,
        cfg,
        toolContext: "toolContext" in testCase ? testCase.toolContext : undefined,
      });

      const call = handleTelegramActionMock.mock.calls[0]?.[0] as
        | Record<string, unknown>
        | undefined;
      if (!call) {
        throw new Error(`expected Telegram action call for ${testCase.name}`);
      }
      expect(call.action, testCase.name).toBe("react");
      expect(String(call[testCase.expectedChannelField]), testCase.name).toBe(
        testCase.expectedChannelValue,
      );
      if (testCase.expectedMessageId === undefined) {
        expect(call.messageId, testCase.name).toBeUndefined();
      } else {
        expect(String(call.messageId), testCase.name).toBe(testCase.expectedMessageId);
      }
    }
  });
});
