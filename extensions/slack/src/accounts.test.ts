import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { resolveSlackAccount } from "./accounts.js";

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
});

describe("resolveSlackAccount tolerateUnresolvedSecrets", () => {
  // The static `SlackAccountConfig.botToken` type is `string` because it
  // models the post-resolution shape, but the runtime cfg snapshot can still
  // hold an unresolved `SecretRef` object for inactive channel targets (per
  // the inspect/strict separation in #66818). Cast via `unknown` so the test
  // can construct that runtime-only shape without weakening the production
  // type. See #68237.
  const cfgWithUnresolvedBotTokenRef = {
    channels: {
      slack: {
        accounts: {
          default: {
            botToken: { source: "exec", provider: "default", id: "slack_bot_token" },
            allowFrom: ["U999"],
          },
        },
      },
    },
  } as unknown as OpenClawConfig;

  it("throws by default when the snapshot still holds an unresolved SecretRef botToken", () => {
    expect(() =>
      resolveSlackAccount({
        cfg: cfgWithUnresolvedBotTokenRef,
        accountId: "default",
      }),
    ).toThrowError(/channels\.slack\.accounts\.default\.botToken/);
  });

  it("returns undefined credentials without throwing when tolerateUnresolvedSecrets is set", () => {
    const resolved = resolveSlackAccount({
      cfg: cfgWithUnresolvedBotTokenRef,
      accountId: "default",
      tolerateUnresolvedSecrets: true,
    });

    expect(resolved.botToken).toBeUndefined();
    expect(resolved.botTokenSource).toBe("none");
    // Surrounding account info still resolves so callers with an explicit
    // override (for example sendMessageSlack receiving opts.token) can keep
    // operating.
    expect(resolved.accountId).toBe("default");
    expect(resolved.config.allowFrom).toEqual(["U999"]);
  });

  it("still returns resolved string credentials in tolerant mode", () => {
    const resolved = resolveSlackAccount({
      cfg: {
        channels: {
          slack: {
            accounts: {
              default: { botToken: "xoxb-resolved", appToken: "xapp-resolved" },
            },
          },
        },
      },
      accountId: "default",
      tolerateUnresolvedSecrets: true,
    });

    expect(resolved.botToken).toBe("xoxb-resolved");
    expect(resolved.botTokenSource).toBe("config");
    expect(resolved.appToken).toBe("xapp-resolved");
    expect(resolved.appTokenSource).toBe("config");
  });

  it("does not silently fall back to SLACK_*_TOKEN env vars in tolerant mode when all credentials are configured as SecretRef (credential confusion guard)", () => {
    // Each credential is configured as a SecretRef. In tolerant mode none of
    // them resolves, so per-credential env gating must block all three env
    // vars; otherwise a stray `SLACK_*_TOKEN` would silently impersonate the
    // operator-configured account (CWE-287 credential confusion).
    const cfgAllSecretRefs = {
      channels: {
        slack: {
          accounts: {
            default: {
              botToken: { source: "exec", provider: "default", id: "slack_bot_token" },
              appToken: { source: "exec", provider: "default", id: "slack_app_token" },
              userToken: { source: "exec", provider: "default", id: "slack_user_token" },
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const previousBotToken = process.env.SLACK_BOT_TOKEN;
    const previousAppToken = process.env.SLACK_APP_TOKEN;
    const previousUserToken = process.env.SLACK_USER_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-env-fallback";
    process.env.SLACK_APP_TOKEN = "xapp-env-fallback";
    process.env.SLACK_USER_TOKEN = "xoxp-env-fallback";
    try {
      const resolved = resolveSlackAccount({
        cfg: cfgAllSecretRefs,
        accountId: "default",
        tolerateUnresolvedSecrets: true,
      });

      expect(resolved.botToken).toBeUndefined();
      expect(resolved.botTokenSource).toBe("none");
      expect(resolved.appToken).toBeUndefined();
      expect(resolved.appTokenSource).toBe("none");
      expect(resolved.userToken).toBeUndefined();
      expect(resolved.userTokenSource).toBe("none");
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
      if (previousUserToken === undefined) {
        delete process.env.SLACK_USER_TOKEN;
      } else {
        process.env.SLACK_USER_TOKEN = previousUserToken;
      }
    }
  });

  it("preserves SLACK_BOT_TOKEN env fallback in tolerant mode when no config token is set (env-only setups)", () => {
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
        tolerateUnresolvedSecrets: true,
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

  it("blocks env fallback per-credential: unresolved SecretRef on botToken does not leak SLACK_APP_TOKEN", () => {
    const previousBotToken = process.env.SLACK_BOT_TOKEN;
    const previousAppToken = process.env.SLACK_APP_TOKEN;
    process.env.SLACK_BOT_TOKEN = "xoxb-env-bot";
    process.env.SLACK_APP_TOKEN = "xapp-env-app";
    try {
      // botToken has an unresolved SecretRef (env fallback should be
      // blocked), but appToken is unset (env fallback should still fire).
      // This proves the gating is per-credential, not whole-account.
      const resolved = resolveSlackAccount({
        cfg: {
          channels: {
            slack: {
              accounts: {
                default: {
                  botToken: { source: "exec", provider: "default", id: "slack_bot_token" },
                },
              },
            },
          },
        } as unknown as OpenClawConfig,
        accountId: "default",
        tolerateUnresolvedSecrets: true,
      });

      expect(resolved.botToken).toBeUndefined();
      expect(resolved.botTokenSource).toBe("none");
      // appToken was never configured → env fallback still fires.
      expect(resolved.appToken).toBe("xapp-env-app");
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
});
