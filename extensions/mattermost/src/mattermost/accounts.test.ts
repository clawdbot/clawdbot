// Mattermost tests cover accounts plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import {
  inspectMattermostAccount,
  isMattermostConfigured,
  listMattermostAccountIds,
  resolveDefaultMattermostAccountId,
  resolveMattermostAccount,
  resolveMattermostReplyToMode,
} from "./accounts.js";

describe("resolveDefaultMattermostAccountId", () => {
  it("prefers channels.mattermost.defaultAccount when it matches a configured account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          defaultAccount: "alerts",
          accounts: {
            default: { botToken: "tok-default", baseUrl: "https://chat.example.com" },
            alerts: { botToken: "tok-alerts", baseUrl: "https://alerts.example.com" },
          },
        },
      },
    };

    expect(resolveDefaultMattermostAccountId(cfg)).toBe("alerts");
  });

  it("normalizes channels.mattermost.defaultAccount before lookup", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          defaultAccount: "Ops Team",
          accounts: {
            "ops-team": { botToken: "tok-ops", baseUrl: "https://chat.example.com" },
          },
        },
      },
    };

    expect(resolveDefaultMattermostAccountId(cfg)).toBe("ops-team");
  });

  it("falls back when channels.mattermost.defaultAccount is missing", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          defaultAccount: "missing",
          accounts: {
            default: { botToken: "tok-default", baseUrl: "https://chat.example.com" },
            alerts: { botToken: "tok-alerts", baseUrl: "https://alerts.example.com" },
          },
        },
      },
    };

    expect(resolveDefaultMattermostAccountId(cfg)).toBe("default");
  });

  it("keeps the implicit default account when named accounts are added to top-level credentials", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          botToken: "tok-default",
          baseUrl: "https://chat.example.com",
          accounts: {
            work: {
              enabled: false,
              botToken: "tok-work",
              baseUrl: "https://work.example.com",
            },
          },
        },
      },
    };

    expect(listMattermostAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultMattermostAccountId(cfg)).toBe("default");
  });

  it("inherits top-level access policy for named accounts before doctor migration", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          dmPolicy: "open",
          groupPolicy: "open",
          allowFrom: ["*"],
          groupAllowFrom: ["*"],
          accounts: {
            tony: {
              botToken: "tok-tony",
              baseUrl: "https://chat.example.com",
            },
          },
        },
      },
    };

    const account = resolveMattermostAccount({ cfg, accountId: "tony" });

    expect(account.config.dmPolicy).toBe("open");
    expect(account.config.groupPolicy).toBe("open");
    expect(account.config.allowFrom).toEqual(["*"]);
    expect(account.config.groupAllowFrom).toEqual(["*"]);
  });
});

describe("Mattermost account SecretRef inspection", () => {
  afterEach(() => vi.unstubAllEnvs());

  const unresolvedRef = {
    source: "env" as const,
    provider: "default",
    id: "OPENCLAW_TEST_MISSING_MATTERMOST_TOKEN",
  };

  it.each([
    { botToken: "bot-token", baseUrl: "https://mm.example.com", configured: true },
    { botToken: unresolvedRef, baseUrl: "https://mm.example.com", configured: true },
    { botToken: undefined, baseUrl: "https://mm.example.com", configured: false },
    { botToken: "bot-token", baseUrl: undefined, configured: false },
  ])("reports configured=$configured for token $botToken and URL $baseUrl", (entry) => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          accounts: {
            work: { botToken: entry.botToken, baseUrl: entry.baseUrl, dmPolicy: "allowlist" },
          },
        },
      },
    };
    const account = inspectMattermostAccount({ cfg, accountId: "work" });
    expect(isMattermostConfigured(account)).toBe(entry.configured);
    expect(account).toMatchObject({
      accountId: "work",
      enabled: true,
      configured: entry.configured,
      dmPolicy: "allowlist",
    });
  });

  it("keeps direct account resolution strict", () => {
    expect(() =>
      resolveMattermostAccount({
        cfg: {
          channels: {
            mattermost: { botToken: unresolvedRef, baseUrl: "https://mm.example.com" },
          },
        },
      }),
    ).toThrow(/unresolved SecretRef/);
  });

  it("does not fall through an unavailable configured ref to the environment", () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", "lower-precedence-token");
    const account = inspectMattermostAccount({
      cfg: {
        channels: {
          mattermost: { botToken: unresolvedRef, baseUrl: "https://mm.example.com" },
        },
      },
    });
    expect(account).toMatchObject({
      botToken: undefined,
      botTokenSource: "config",
      botTokenStatus: "configured_unavailable",
    });
  });
});

describe("resolveMattermostReplyToMode", () => {
  it("uses configured defaultAccount when accountId is omitted", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          defaultAccount: "alerts",
          accounts: {
            alerts: {
              botToken: "tok-alerts",
              baseUrl: "https://alerts.example.com",
              replyToMode: "all",
            },
          },
        },
      },
    };

    const account = resolveMattermostAccount({ cfg });
    expect(account.accountId).toBe("alerts");
    expect(resolveMattermostReplyToMode(account, "channel")).toBe("all");
  });

  it("uses the configured mode for channel and group messages", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          replyToMode: "all",
        },
      },
    };

    const account = resolveMattermostAccount({ cfg, accountId: "default" });
    expect(resolveMattermostReplyToMode(account, "channel")).toBe("all");
    expect(resolveMattermostReplyToMode(account, "group")).toBe("all");
  });

  it("keeps direct messages off by default even when replyToMode is enabled", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          replyToMode: "all",
        },
      },
    };

    const account = resolveMattermostAccount({ cfg, accountId: "default" });
    expect(resolveMattermostReplyToMode(account, "direct")).toBe("off");
  });

  it("uses per-chat-type overrides before the channel and group default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        mattermost: {
          replyToMode: "all",
          replyToModeByChatType: {
            direct: "first",
            channel: "off",
          },
        },
      },
    };

    const account = resolveMattermostAccount({ cfg, accountId: "default" });
    expect(resolveMattermostReplyToMode(account, "direct")).toBe("first");
    expect(resolveMattermostReplyToMode(account, "channel")).toBe("off");
    expect(resolveMattermostReplyToMode(account, "group")).toBe("all");
  });

  it("defaults to off when replyToMode is unset", () => {
    const account = resolveMattermostAccount({ cfg: {}, accountId: "default" });
    expect(resolveMattermostReplyToMode(account, "channel")).toBe("off");
  });

  it("preserves shared commands config when an account overrides one commands field", () => {
    const account = resolveMattermostAccount({
      cfg: {
        channels: {
          mattermost: {
            commands: {
              native: true,
            },
            accounts: {
              work: {
                commands: {
                  callbackPath: "/hooks/work",
                },
              },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(account.config.commands).toEqual({
      native: true,
      callbackPath: "/hooks/work",
    });
  });

  it("resolves documented streaming mode from account config", () => {
    const account = resolveMattermostAccount({
      cfg: {
        channels: {
          mattermost: {
            streaming: { mode: "partial" },
            accounts: {
              work: {
                streaming: { mode: "off" },
              },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(account.streamingMode).toBe("off");
  });
});
