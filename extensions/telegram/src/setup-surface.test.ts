import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { describe, expect, it, vi } from "vitest";
import { resolveTelegramAllowFromEntries } from "./setup-core.js";
import {
  buildTelegramDmAccessWarningLines,
  ensureTelegramDefaultGroupMentionGate,
  shouldShowTelegramDmAccessWarning,
  telegramSetupDmPolicy,
} from "./setup-surface.helpers.js";

describe("ensureTelegramDefaultGroupMentionGate", () => {
  it('adds groups["*"].requireMention=true for fresh setups', async () => {
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

  it("preserves an explicit wildcard group mention setting", async () => {
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

describe("resolveTelegramAllowFromEntries", () => {
  it("passes apiRoot through username lookups", async () => {
    const globalFetch = vi.fn(async () => {
      throw new Error("global fetch should not be called");
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { id: 12345 } }),
    }));
    vi.stubGlobal("fetch", globalFetch);
    const proxyFetch = vi.fn();
    const fetchModule = await import("./fetch.js");
    const proxyModule = await import("./proxy.js");
    const resolveTelegramFetch = vi.spyOn(fetchModule, "resolveTelegramFetch");
    const makeProxyFetch = vi.spyOn(proxyModule, "makeProxyFetch");
    makeProxyFetch.mockReturnValue(proxyFetch as unknown as typeof fetch);
    resolveTelegramFetch.mockReturnValue(fetchMock as unknown as typeof fetch);

    try {
      const resolved = await resolveTelegramAllowFromEntries({
        entries: ["@user"],
        credentialValue: "tok",
        apiRoot: "https://custom.telegram.test/root/",
        proxyUrl: "http://127.0.0.1:8080",
        network: { autoSelectFamily: false, dnsResultOrder: "ipv4first" },
      });

      expect(resolved).toEqual([{ input: "@user", resolved: true, id: "12345" }]);
      expect(makeProxyFetch).toHaveBeenCalledWith("http://127.0.0.1:8080");
      expect(resolveTelegramFetch).toHaveBeenCalledWith(proxyFetch, {
        network: { autoSelectFamily: false, dnsResultOrder: "ipv4first" },
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://custom.telegram.test/root/bottok/getChat?chat_id=%40user",
        undefined,
      );
    } finally {
      makeProxyFetch.mockRestore();
      resolveTelegramFetch.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
