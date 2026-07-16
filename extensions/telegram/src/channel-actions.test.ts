// Telegram tests cover channel actions plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { telegramMessageActions } from "./channel-actions.js";

const handleTelegramActionMock = vi.hoisted(() => vi.fn());

vi.mock("./action-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./action-runtime.js")>("./action-runtime.js");
  return { ...actual, handleTelegramAction: handleTelegramActionMock };
});

describe("telegramMessageActions", () => {
  beforeEach(() => {
    handleTelegramActionMock.mockReset().mockResolvedValue({
      ok: true,
      content: [],
      details: {},
    });
  });

  it("executes message actions in the gateway when a gateway is available", () => {
    for (const action of ["send", "poll", "react", "delete", "edit"] as const) {
      expect(telegramMessageActions.resolveExecutionMode?.({ action })).toBe("gateway");
    }
  });

  it("classifies provider-native mutation actions", () => {
    for (const action of ["sendMessage", "editMessage", "deleteMessage", "react", "topic-edit"]) {
      expect(telegramMessageActions.isToolDeliveryAction?.({ args: { action } })).toBe(true);
    }
    for (const action of ["searchSticker", "stickerCacheStats"]) {
      expect(telegramMessageActions.isToolDeliveryAction?.({ args: { action } })).toBe(false);
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
        mediaReadFile: undefined,
        sessionKey: "telegram-session",
        gatewayClientScopes: undefined,
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
        expect(actions, testCase.name).toContain("sticker");
        expect(actions, testCase.name).toContain("sticker-search");
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

      const call = handleTelegramActionMock.mock.calls.at(0)?.[0] as
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

  // Regression for #75433: prompt discovery reads raw config before the active
  // runtime snapshot has resolved SecretRefs. Treat SecretRef-backed accounts
  // as configured and keep advertising config-derived actions.
  it("describes discovery when botToken is an unresolved SecretRef instead of crashing the embedded run", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: { source: "exec", provider: "default", id: "telegram-token" },
          actions: {
            reactions: true,
            poll: false,
          },
        },
      },
    } as unknown as OpenClawConfig;

    const discovery = telegramMessageActions.describeMessageTool?.({ cfg });

    expect(discovery?.actions).toContain("send");
    expect(discovery?.actions).toContain("react");
    expect(discovery?.actions).not.toContain("poll");
  });

  it("describes scoped account discovery when Telegram account token is an unresolved SecretRef", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            ops: {
              botToken: { source: "exec", provider: "default", id: "telegram-ops" },
              actions: {
                reactions: false,
                poll: true,
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const discovery = telegramMessageActions.describeMessageTool?.({
      cfg,
      accountId: "ops",
    });

    expect(discovery?.actions).toContain("send");
    expect(discovery?.actions).toContain("poll");
    expect(discovery?.actions).not.toContain("react");
  });

  it("advertises poll duration as a positive integer in message tool schema", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "tok",
          actions: { poll: true },
        },
      },
    } as OpenClawConfig;

    const discovery = telegramMessageActions.describeMessageTool?.({ cfg });
    const schema = Array.isArray(discovery?.schema) ? discovery.schema[0] : undefined;

    expect(schema?.properties.pollDurationSeconds).toMatchObject({
      type: "integer",
      minimum: 1,
    });
  });

  it("matches runtime account-key normalization during SecretRef-tolerant discovery", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            "Carey Notifications": {
              botToken: { source: "exec", provider: "default", id: "telegram-carey" },
              actions: {
                poll: true,
                reactions: false,
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const discovery = telegramMessageActions.describeMessageTool?.({
      cfg,
      accountId: "carey-notifications",
    });

    expect(discovery?.actions).toContain("send");
    expect(discovery?.actions).toContain("poll");
    expect(discovery?.actions).not.toContain("react");
  });

  it("does not discover unknown scoped accounts via channel-level fallback in multi-account config", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: "tok-channel",
          accounts: {
            work: { botToken: "tok-work" },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      telegramMessageActions.describeMessageTool?.({
        cfg,
        accountId: "unknown",
      })?.actions,
    ).toEqual([]);
  });

  it("keeps healthy Telegram accounts discoverable when a sibling token is an unresolved SecretRef", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            unresolved: {
              botToken: { source: "exec", provider: "default", id: "telegram-unresolved" },
              actions: {
                reactions: false,
                poll: false,
              },
            },
            healthy: {
              botToken: "tok-healthy",
              actions: {
                reactions: true,
                poll: false,
              },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    const discovery = telegramMessageActions.describeMessageTool?.({ cfg });

    expect(discovery?.actions).toContain("send");
    expect(discovery?.actions).toContain("react");
    expect(discovery?.actions).not.toContain("poll");
  });
});
