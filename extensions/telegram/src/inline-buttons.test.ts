// Telegram tests cover inline buttons plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { buildTelegramInteractiveButtons } from "./button-types.js";
import { describeTelegramInteractiveButtonBehavior } from "./button-types.test-helpers.js";
import {
  isTelegramInlineButtonsEnabled,
  resolveTelegramInlineButtonsScope,
  resolveTelegramTargetChatType,
} from "./inline-buttons.js";

describe("resolveTelegramTargetChatType", () => {
  it("returns 'direct' for positive numeric IDs", () => {
    expect(resolveTelegramTargetChatType("5232990709")).toBe("direct");
    expect(resolveTelegramTargetChatType("123456789")).toBe("direct");
  });

  it("returns 'group' for negative numeric IDs", () => {
    expect(resolveTelegramTargetChatType("-123456789")).toBe("group");
    expect(resolveTelegramTargetChatType("-1001234567890")).toBe("group");
  });

  it("handles telegram: prefix from normalizeTelegramMessagingTarget", () => {
    expect(resolveTelegramTargetChatType("telegram:5232990709")).toBe("direct");
    expect(resolveTelegramTargetChatType("telegram:-123456789")).toBe("group");
    expect(resolveTelegramTargetChatType("TELEGRAM:5232990709")).toBe("direct");
  });

  it("handles tg/group prefixes and topic suffixes", () => {
    expect(resolveTelegramTargetChatType("tg:5232990709")).toBe("direct");
    expect(resolveTelegramTargetChatType("telegram:group:-1001234567890")).toBe("group");
    expect(resolveTelegramTargetChatType("telegram:group:-1001234567890:topic:456")).toBe("group");
    expect(resolveTelegramTargetChatType("-1001234567890:456")).toBe("group");
  });

  it("returns 'unknown' for usernames", () => {
    expect(resolveTelegramTargetChatType("@username")).toBe("unknown");
    expect(resolveTelegramTargetChatType("telegram:@username")).toBe("unknown");
  });

  it("returns 'unknown' for empty strings", () => {
    expect(resolveTelegramTargetChatType("")).toBe("unknown");
    expect(resolveTelegramTargetChatType("   ")).toBe("unknown");
  });
});

describeTelegramInteractiveButtonBehavior();

describe("buildTelegramInteractiveButtons callback rewrites", () => {
  it("drops shared buttons whose callback data exceeds Telegram's limit", () => {
    expect(
      buildTelegramInteractiveButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Keep", value: "keep" },
              { label: "Too long", value: `a${"b".repeat(64)}` },
            ],
          },
        ],
      }),
    ).toEqual([[{ text: "Keep", callback_data: "keep", style: undefined }]]);
  });

  it("rewrites /approve allow-always callbacks to always so plugin IDs fit Telegram limits", () => {
    const pluginApprovalId = `plugin:${"a".repeat(36)}`;
    expect(
      buildTelegramInteractiveButtons({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Allow Always",
                value: `/approve ${pluginApprovalId} allow-always`,
                style: "primary",
              },
            ],
          },
        ],
      }),
    ).toEqual([
      [
        {
          text: "Allow Always",
          callback_data: `/approve ${pluginApprovalId} always`,
          style: "primary",
        },
      ],
    ]);
  });
});

describe("resolveTelegramInlineButtonsScope (#75433 SecretRef tolerance)", () => {
  // Embedded prompt prep calls this from raw config before the active runtime
  // snapshot has resolved channel credentials. Read-only account inspection
  // keeps SecretRef-backed config readable without resolving the token.
  it("preserves the default inline-buttons scope when botToken is an unresolved SecretRef", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: { source: "exec", provider: "default", id: "telegram-token" },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveTelegramInlineButtonsScope({ cfg })).toBe("allowlist");
    expect(isTelegramInlineButtonsEnabled({ cfg })).toBe(true);
  });

  it("preserves the default inline-buttons scope when legacy capabilities are empty", () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: { source: "exec", provider: "default", id: "telegram-token" },
          capabilities: [],
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveTelegramInlineButtonsScope({ cfg })).toBe("allowlist");
    expect(isTelegramInlineButtonsEnabled({ cfg })).toBe(true);
  });

  it("inherits the channel scope when an account legacy capabilities array is empty", () => {
    const cfg = {
      channels: {
        telegram: {
          capabilities: { inlineButtons: "off" },
          accounts: {
            ops: {
              botToken: "123:telegram-ops-token",
              capabilities: [],
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveTelegramInlineButtonsScope({ cfg, accountId: "ops" })).toBe("off");
    expect(isTelegramInlineButtonsEnabled({ cfg, accountId: "ops" })).toBe(false);
  });

  it('preserves configured "off" when botToken is an unresolved SecretRef', () => {
    const cfg = {
      channels: {
        telegram: {
          botToken: { source: "exec", provider: "default", id: "telegram-token" },
          capabilities: { inlineButtons: "off" },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveTelegramInlineButtonsScope({ cfg })).toBe("off");
    expect(isTelegramInlineButtonsEnabled({ cfg })).toBe(false);
  });

  it("preserves scoped account inline-buttons config when the token is an unresolved SecretRef", () => {
    const cfg = {
      channels: {
        telegram: {
          accounts: {
            ops: {
              botToken: { source: "exec", provider: "default", id: "telegram-ops" },
              capabilities: { inlineButtons: "all" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveTelegramInlineButtonsScope({ cfg, accountId: "ops" })).toBe("all");
    expect(isTelegramInlineButtonsEnabled({ cfg, accountId: "ops" })).toBe(true);
  });
});
