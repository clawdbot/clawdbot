import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { describe, expect, it, vi } from "vitest";
import { promptTelegramAllowFromForAccount } from "./setup-core.js";
import {
  buildTelegramDmAccessWarningLines,
  ensureTelegramDefaultGroupMentionGate,
  shouldShowTelegramDmAccessWarning,
  telegramSetupDmPolicy,
} from "./setup-surface.helpers.js";
import { telegramSetupWizard } from "./setup-surface.js";

describe("ensureTelegramDefaultGroupMentionGate", () => {
  it('adds groups["*"].requireMention=true for fresh setups', () => {
    const cfg = ensureTelegramDefaultGroupMentionGate(
      {
        channels: {
          telegram: {
            botToken: "tok",
          },
        },
      },
      DEFAULT_ACCOUNT_ID,
    );

    expect(cfg.channels?.telegram?.groups).toEqual({
      "*": { requireMention: true },
    });
  });

  it("preserves an explicit wildcard group mention setting", () => {
    const cfg = ensureTelegramDefaultGroupMentionGate(
      {
        channels: {
          telegram: {
            botToken: "tok",
            groups: {
              "*": { requireMention: false },
            },
          },
        },
      },
      DEFAULT_ACCOUNT_ID,
    );

    expect(cfg.channels?.telegram?.groups).toEqual({
      "*": { requireMention: false },
    });
  });
});

describe("telegram DM access warning helpers", () => {
  it("shows global config commands for the default account", () => {
    const lines = buildTelegramDmAccessWarningLines(DEFAULT_ACCOUNT_ID);

    expect(lines.join("\n")).toContain(
      'openclaw config set channels.telegram.dmPolicy "allowlist"',
    );
    expect(lines.join("\n")).toContain(
      `openclaw config set channels.telegram.allowFrom '["YOUR_USER_ID"]'`,
    );
  });

  it("shows account-scoped config commands for named accounts", () => {
    const lines = buildTelegramDmAccessWarningLines("alerts");

    expect(lines.join("\n")).toContain(
      'openclaw config set channels.telegram.accounts.alerts.dmPolicy "allowlist"',
    );
    expect(lines.join("\n")).toContain(
      `openclaw config set channels.telegram.accounts.alerts.allowFrom '["YOUR_USER_ID"]'`,
    );
  });

  it("skips the warning when an allowFrom entry already exists", () => {
    expect(
      shouldShowTelegramDmAccessWarning(
        {
          channels: {
            telegram: {
              botToken: "tok",
              allowFrom: ["123"],
            },
          },
        },
        DEFAULT_ACCOUNT_ID,
      ),
    ).toBe(false);
  });
});

describe("telegramSetupDmPolicy", () => {
  it("reads the named-account DM policy instead of the channel root", () => {
    expect(
      telegramSetupDmPolicy.getCurrent?.(
        {
          channels: {
            telegram: {
              dmPolicy: "disabled",
              accounts: {
                alerts: {
                  dmPolicy: "allowlist",
                  botToken: "tok",
                },
              },
            },
          },
        },
        "alerts",
      ),
    ).toBe("allowlist");
  });

  it("reports account-scoped config keys for named accounts", () => {
    expect(telegramSetupDmPolicy.resolveConfigKeys?.({}, "alerts")).toEqual({
      policyKey: "channels.telegram.accounts.alerts.dmPolicy",
      allowFromKey: "channels.telegram.accounts.alerts.allowFrom",
    });
  });

  it("uses configured defaultAccount for omitted DM policy account context", () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          defaultAccount: "alerts",
          dmPolicy: "disabled",
          allowFrom: ["123"],
          accounts: {
            alerts: {
              dmPolicy: "allowlist",
              botToken: "tok",
            },
          },
        },
      },
    };

    expect(telegramSetupDmPolicy.getCurrent?.(cfg)).toBe("allowlist");
    expect(telegramSetupDmPolicy.resolveConfigKeys?.(cfg)).toEqual({
      policyKey: "channels.telegram.accounts.alerts.dmPolicy",
      allowFromKey: "channels.telegram.accounts.alerts.allowFrom",
    });

    const next = telegramSetupDmPolicy.setPolicy?.(cfg, "open");
    expect(next?.channels?.telegram?.dmPolicy).toBe("disabled");
    expect(next?.channels?.telegram?.accounts?.alerts?.dmPolicy).toBe("open");
  });

  it('writes open policy state to the named account and preserves inherited allowFrom with "*"', () => {
    const cfg: OpenClawConfig = {
      channels: {
        telegram: {
          allowFrom: ["123"],
          accounts: {
            alerts: {
              botToken: "tok",
            },
          },
        },
      },
    };

    const next = telegramSetupDmPolicy.setPolicy?.(cfg, "open", "alerts");

    expect(next?.channels?.telegram?.dmPolicy).toBeUndefined();
    expect(next?.channels?.telegram?.accounts?.alerts?.dmPolicy).toBe("open");
    expect(next?.channels?.telegram?.accounts?.alerts?.allowFrom).toEqual(["123", "*"]);
  });
});

describe("telegramSetupWizard allowFrom", () => {
  it("accepts numeric sender ids only", async () => {
    const globalFetch = vi.fn(async () => {
      throw new Error("global fetch should not be called");
    });
    vi.stubGlobal("fetch", globalFetch);

    try {
      const resolved = await telegramSetupWizard.allowFrom?.resolveEntries({
        cfg: {},
        accountId: DEFAULT_ACCOUNT_ID,
        credentialValues: { token: "tok" },
        entries: ["@user"],
      });

      expect(telegramSetupWizard.allowFrom?.message).toBe("Telegram allowFrom (numeric sender id)");
      expect(telegramSetupWizard.allowFrom?.placeholder).toBe("123456789");
      expect(resolved).toEqual([{ input: "@user", resolved: false, id: null }]);
      expect(globalFetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("localizes setup wizard allowFrom copy when loaded under zh-CN", async () => {
    const previousLocale = process.env.OPENCLAW_LOCALE;
    process.env.OPENCLAW_LOCALE = "zh-CN";

    try {
      vi.resetModules();
      const { telegramSetupWizard: localizedWizard } = await import("./setup-surface.js");

      expect(localizedWizard.allowFrom?.helpTitle).toBe("Telegram 用户 ID");
      expect(localizedWizard.allowFrom?.message).toBe("Telegram allowFrom（数字发送者 ID）");
      expect(localizedWizard.allowFrom?.invalidWithoutCredentialNote).toBe(
        "Telegram allowFrom 需要数字发送者 ID。先给 bot 发一条 DM，然后从日志或 getUpdates 中复制 from.id。",
      );
    } finally {
      if (previousLocale === undefined) {
        delete process.env.OPENCLAW_LOCALE;
      } else {
        process.env.OPENCLAW_LOCALE = previousLocale;
      }
    }
  });

  it("localizes legacy allowFrom prompt copy", async () => {
    const previousLocale = process.env.OPENCLAW_LOCALE;
    process.env.OPENCLAW_LOCALE = "zh-CN";
    const note = vi.fn(async () => {});
    const text = vi.fn(async () => "123456789");

    try {
      await promptTelegramAllowFromForAccount({
        cfg: {},
        prompter: { note, text } as never,
      });

      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("先给你的 bot 发送 DM"),
        "Telegram 用户 ID",
      );
      expect(text).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Telegram allowFrom（数字发送者 ID）",
          placeholder: "123456789",
        }),
      );
    } finally {
      if (previousLocale === undefined) {
        delete process.env.OPENCLAW_LOCALE;
      } else {
        process.env.OPENCLAW_LOCALE = previousLocale;
      }
    }
  });
});
