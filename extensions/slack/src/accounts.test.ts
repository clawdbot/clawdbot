import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import {
  resolveSlackAccount,
  resolveSlackAccountAllowFrom,
  resolveSlackAccountDmPolicy,
} from "./accounts.js";

describe("resolveSlackAccount allowFrom precedence", () => {
  it("uses configured defaultAccount when accountId is omitted", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            defaultAccount: "work",
            accounts: {
              work: {
                name: "Work",
                botToken: "xoxb-work",
                appToken: "xapp-work",
              },
            },
          },
        },
      },
    });

    expect(resolved.accountId).toBe("work");
    expect(resolved.name).toBe("Work");
    expect(resolved.botToken).toBe("xoxb-work");
    expect(resolved.appToken).toBe("xapp-work");
  });

  it("prefers accounts.default.allowFrom over top-level for default account", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            allowFrom: ["top"],
            accounts: {
              default: {
                botToken: "xoxb-default",
                appToken: "xapp-default",
                allowFrom: ["default"],
              },
            },
          },
        },
      },
      accountId: "default",
    });

    expect(resolved.config.allowFrom).toEqual(["default"]);
  });

  it("falls back to top-level allowFrom for named account without override", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            allowFrom: ["top"],
            accounts: {
              work: { botToken: "xoxb-work", appToken: "xapp-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toEqual(["top"]);
  });

  it("merges top-level unfurl controls into named accounts", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            unfurlLinks: false,
            unfurlMedia: true,
            accounts: {
              work: { botToken: "xoxb-work", appToken: "xapp-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.unfurlLinks).toBe(false);
    expect(resolved.config.unfurlMedia).toBe(true);
  });

  it("prefers account-level unfurl controls over top-level defaults", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            unfurlLinks: false,
            unfurlMedia: true,
            accounts: {
              work: {
                botToken: "xoxb-work",
                appToken: "xapp-work",
                unfurlLinks: true,
                unfurlMedia: false,
              },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.unfurlLinks).toBe(true);
    expect(resolved.config.unfurlMedia).toBe(false);
  });

  it("merges account bot loop protection over top-level defaults field-by-field", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            botLoopProtection: {
              maxEventsPerWindow: 8,
              windowSeconds: 120,
              cooldownSeconds: 240,
            },
            accounts: {
              work: {
                botToken: "xoxb-work",
                appToken: "xapp-work",
                botLoopProtection: {
                  maxEventsPerWindow: 3,
                },
              },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.botLoopProtection).toEqual({
      maxEventsPerWindow: 3,
      windowSeconds: 120,
      cooldownSeconds: 240,
    });
  });

  it("does not inherit default account allowFrom for named account when top-level is absent", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            accounts: {
              default: {
                botToken: "xoxb-default",
                appToken: "xapp-default",
                allowFrom: ["default"],
              },
              work: { botToken: "xoxb-work", appToken: "xapp-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toBeUndefined();
  });

  it("falls back to top-level dm.allowFrom when allowFrom alias is unset", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            dm: { allowFrom: ["U123"] },
            accounts: {
              work: { botToken: "xoxb-work", appToken: "xapp-work" },
            },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved.config.allowFrom).toBeUndefined();
    expect(resolved.config.dm?.allowFrom).toEqual(["U123"]);
  });

  it("resolves account legacy dm.allowFrom before inherited root allowFrom", () => {
    const cfg = {
      channels: {
        slack: {
          allowFrom: ["root"],
          accounts: {
            work: {
              botToken: "xoxb-work",
              appToken: "xapp-work",
              dm: { allowFrom: ["account-legacy"] },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveSlackAccountAllowFrom({ cfg, accountId: "work" })).toEqual(["account-legacy"]);
  });

  it("coerces numeric allowFrom entries at the config boundary", () => {
    const cfg = {
      channels: {
        slack: {
          accounts: {
            work: {
              botToken: "xoxb-work",
              appToken: "xapp-work",
              allowFrom: [12345],
            },
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(resolveSlackAccountAllowFrom({ cfg, accountId: "work" })).toEqual(["12345"]);
  });

  it("resolves account legacy dm policy before inherited root policy", () => {
    const cfg = {
      channels: {
        slack: {
          dmPolicy: "open",
          accounts: {
            work: {
              botToken: "xoxb-work",
              appToken: "xapp-work",
              dm: { policy: "allowlist" },
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveSlackAccountDmPolicy({ cfg, accountId: "work" })).toBe("allowlist");
  });

  it("resolves mixed-case account keys for DM access settings", () => {
    const cfg = {
      channels: {
        slack: {
          dmPolicy: "open",
          allowFrom: ["root"],
          accounts: {
            Work: {
              botToken: "xoxb-work",
              appToken: "xapp-work",
              dm: { policy: "allowlist" },
              allowFrom: ["U123"],
            },
          },
        },
      },
    } satisfies OpenClawConfig;

    expect(resolveSlackAccountDmPolicy({ cfg, accountId: "work" })).toBe("allowlist");
    expect(resolveSlackAccountAllowFrom({ cfg, accountId: "work" })).toEqual(["U123"]);
  });
});

describe("resolveSlackAccount active secret surfaces", () => {
  const secretRef = { source: "exec", provider: "default", id: "slack_token" } as const;
  const cfgWithUnresolvedBotTokenRef = {
    channels: {
      slack: {
        accounts: {
          default: {
            botToken: secretRef,
            allowFrom: ["U999"],
          },
        },
      },
    },
  } as unknown as OpenClawConfig;

  it("throws when an enabled account still has an unresolved active bot token SecretRef", () => {
    expect(() =>
      resolveSlackAccount({
        cfg: cfgWithUnresolvedBotTokenRef,
        accountId: "default",
      }),
    ).toThrowError(/channels\.slack\.accounts\.default\.botToken/);
  });

  it("does not read credentials for disabled accounts", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            accounts: {
              default: {
                enabled: false,
                botToken: secretRef,
                appToken: secretRef,
                userToken: secretRef,
                allowFrom: ["U999"],
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      accountId: "default",
    });

    expect(resolved.botToken).toBeUndefined();
    expect(resolved.botTokenSource).toBe("none");
    expect(resolved.appToken).toBeUndefined();
    expect(resolved.appTokenSource).toBe("none");
    expect(resolved.userToken).toBeUndefined();
    expect(resolved.userTokenSource).toBe("none");
    expect(resolved.accountId).toBe("default");
    expect(resolved.config.allowFrom).toEqual(["U999"]);
  });

  it("does not read socket-only app token for HTTP mode accounts", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            accounts: {
              default: {
                mode: "http",
                botToken: "xoxb-resolved",
                appToken: secretRef,
                signingSecret: "signing-secret",
              },
            },
          },
        },
      } as unknown as OpenClawConfig,
      accountId: "default",
    });

    expect(resolved.botToken).toBe("xoxb-resolved");
    expect(resolved.botTokenSource).toBe("config");
    expect(resolved.appToken).toBeUndefined();
    expect(resolved.appTokenSource).toBe("none");
  });

  it("throws when a socket-mode account still has an unresolved active app token SecretRef", () => {
    expect(() =>
      resolveSlackAccount({
        cfg: {
          channels: {
            slack: {
              accounts: {
                default: {
                  mode: "socket",
                  botToken: "xoxb-resolved",
                  appToken: secretRef,
                },
              },
            },
          },
        } as unknown as OpenClawConfig,
        accountId: "default",
      }),
    ).toThrowError(/channels\.slack\.accounts\.default\.appToken/);
  });

  it("preserves env fallback when no active config token is set", () => {
    const previousBotToken = process.env.SLACK_BOT_TOKEN;
    const previousAppToken = process.env.SLACK_APP_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-env-only";
    process.env.SLACK_APP_TOKEN = "xapp-env-only";
    try {
      // No SecretRef and no string token configured for the default account:
      // env fallback must still fire so env-only deployments (relying solely
      // on SLACK_BOT_TOKEN / SLACK_APP_TOKEN) keep working when callers like
      // `channel.ts` invoke sendMessageSlack without an explicit override.
      const resolved = resolveSlackAccount({
        cfg: {
          channels: {
            slack: {
              accounts: {
                default: { allowFrom: ["U001"] },
              },
            },
          },
        },
        accountId: "default",
      });

      expect(resolved.botToken).toBe("xoxb-env-only");
      expect(resolved.botTokenSource).toBe("env");
      expect(resolved.appToken).toBe("xapp-env-only");
      expect(resolved.appTokenSource).toBe("env");
    } finally {
      if (previousBotToken === undefined) {
        delete process.env.SLACK_BOT_TOKEN;
      } else {
        process.env.SLACK_BOT_TOKEN = previousBotToken;
      }
      if (previousAppToken === undefined) {
        delete process.env.SLACK_APP_TOKEN;
      } else {
        process.env.SLACK_APP_TOKEN = previousAppToken;
      }
    }
  });

  it("does not use env fallback for inactive credentials", () => {
    const previousBotToken = process.env.SLACK_BOT_TOKEN;
    const previousAppToken = process.env.SLACK_APP_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-env-bot";
    process.env.SLACK_APP_TOKEN = "xapp-env-app";
    try {
      const resolved = resolveSlackAccount({
        cfg: {
          channels: {
            slack: {
              accounts: {
                default: {
                  enabled: false,
                },
              },
            },
          },
        },
        accountId: "default",
      });

      expect(resolved.botToken).toBeUndefined();
      expect(resolved.botTokenSource).toBe("none");
      expect(resolved.appToken).toBeUndefined();
      expect(resolved.appTokenSource).toBe("none");
    } finally {
      if (previousBotToken === undefined) {
        delete process.env.SLACK_BOT_TOKEN;
      } else {
        process.env.SLACK_BOT_TOKEN = previousBotToken;
      }
      if (previousAppToken === undefined) {
        delete process.env.SLACK_APP_TOKEN;
      } else {
        process.env.SLACK_APP_TOKEN = previousAppToken;
      }
    }
  });
});
