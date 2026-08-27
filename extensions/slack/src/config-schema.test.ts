// Slack tests cover config schema plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { SlackConfigSchema } from "../config-api.js";
import { listSlackAccountIds, resolveSlackAccount } from "./accounts.js";

function expectSlackConfigValid(config: unknown) {
  const res = SlackConfigSchema.safeParse(config);
  expect(res.success).toBe(true);
}

function expectSlackConfigIssue(config: unknown, path: string) {
  const res = SlackConfigSchema.safeParse(config);
  expect(res.success).toBe(false);
  if (!res.success) {
    expect(res.error.issues.map((issue) => issue.path.join("."))).toContain(path);
  }
}

function expectSlackConfigKeyRejected(config: unknown, key: string) {
  const res = SlackConfigSchema.safeParse(config);
  expect(res.success).toBe(false);
  if (!res.success) {
    expect(res.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unrecognized_keys",
          keys: expect.arrayContaining([key]),
        }),
      ]),
    );
  }
}

describe("slack config schema", () => {
  it("accepts compact progress style", () => {
    expectSlackConfigValid({
      streaming: {
        mode: "progress",
        progress: { style: "compact" },
      },
    });
    expectSlackConfigIssue(
      { streaming: { mode: "progress", progress: { style: "plain" } } },
      "streaming.progress.style",
    );
  });

  it("accepts capability arrays and rejects retired interactive reply objects", () => {
    expectSlackConfigValid({ capabilities: ["presentation"] });
    expectSlackConfigIssue({ capabilities: { interactiveReplies: true } }, "capabilities");
  });

  it("rejects the retired Enterprise Grid installation setting", () => {
    expectSlackConfigKeyRejected({ enterpriseOrgInstall: true }, "enterpriseOrgInstall");
    expectSlackConfigKeyRejected(
      { accounts: { org: { enterpriseOrgInstall: true } } },
      "enterpriseOrgInstall",
    );
  });

  it("keeps workspace-scoped mention pattern policies valid for workspace installs", () => {
    expectSlackConfigValid({ mentionPatterns: { denyIn: ["C123"] } });
    expectSlackConfigValid({
      accounts: { workspace: { mentionPatterns: { mode: "deny", allowIn: ["C456"] } } },
    });
  });

  it("defaults groupPolicy to allowlist", () => {
    const res = SlackConfigSchema.safeParse({});

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.groupPolicy).toBe("allowlist");
    }
  });

  it("preserves default-on join introductions without masking account inheritance", () => {
    const parsed = SlackConfigSchema.parse({ accounts: { work: {} } });

    expect(parsed.joinIntro).toBeUndefined();
    expect(parsed.accounts?.work?.joinIntro).toBeUndefined();
  });

  it.each([
    { root: false, account: undefined, expected: false },
    { root: false, account: true, expected: true },
    { root: true, account: false, expected: false },
  ])(
    "resolves join introductions from root=$root and account=$account to $expected",
    ({ root, account, expected }) => {
      const cfg = {
        channels: {
          slack: {
            joinIntro: root,
            accounts: { work: account === undefined ? {} : { joinIntro: account } },
          },
        },
      } satisfies OpenClawConfig;

      expectSlackConfigValid(cfg.channels.slack);
      expect(resolveSlackAccount({ cfg, accountId: "work" }).config.joinIntro).toBe(expected);
    },
  );

  it('defaults postAs to "bot"', () => {
    const res = SlackConfigSchema.safeParse({ accounts: { work: {} } });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.postAs).toBe("bot");
      expect(res.data.accounts?.work?.postAs).toBeUndefined();
      expect(res.data.accounts?.work?.postAs ?? res.data.postAs).toBe("bot");
    }
  });

  it('accepts postAs="user" with a user token and socket companion app', () => {
    expectSlackConfigValid({
      postAs: "user",
      userToken: "test-user-token",
      appToken: "test-app-token",
    });
  });

  it('accepts postAs="user" with a user token and HTTP companion app', () => {
    expectSlackConfigValid({
      postAs: "user",
      mode: "http",
      userToken: "test-user-token",
      signingSecret: "test-signing-secret",
    });
  });

  it("allows account entries to inherit the top-level user postAs", () => {
    const cfg = {
      channels: {
        slack: {
          postAs: "user" as const,
          userToken: "test-user-token",
          appToken: "test-app-token",
          accounts: { work: {} },
        },
      },
    } satisfies OpenClawConfig;

    expectSlackConfigValid(cfg.channels.slack);
    expect(resolveSlackAccount({ cfg, accountId: "work" }).identity).toBe("user");
  });

  it("keeps user tokens and companion app tokens active for user postAs", () => {
    const cfg = {
      channels: {
        slack: {
          postAs: "user" as const,
          userToken: "test-user-token",
          appToken: "test-app-token",
        },
      },
    } satisfies OpenClawConfig;

    const account = resolveSlackAccount({ cfg });

    expect(listSlackAccountIds(cfg)).toEqual(["default"]);
    expect(account.userToken).toBe("test-user-token");
    expect(account.userTokenSource).toBe("config");
    expect(account.appToken).toBe("test-app-token");
    expect(account.appTokenSource).toBe("config");
  });

  it("accepts inherited and relay companion-app transports for user postAs", () => {
    expectSlackConfigValid({
      postAs: "user",
      userToken: "test-user-token",
      appToken: "test-app-token",
      accounts: {
        work: {},
      },
    });
    expectSlackConfigValid({
      postAs: "user",
      mode: "relay",
      userToken: "test-user-token",
      relay: {
        url: "test-relay-url",
        authToken: "test-relay-auth-token",
        gatewayId: "test-gateway-id",
      },
    });
  });

  it("defers user-postAs user-token presence to runtime", () => {
    expectSlackConfigValid({ postAs: "user" });
  });

  it("keeps presence events off by default and accepts account/channel modes", () => {
    const absent = SlackConfigSchema.safeParse({});
    expect(absent.success).toBe(true);
    if (absent.success) {
      expect(absent.data.presenceEvents).toBeUndefined();
    }
    expectSlackConfigValid({ presenceEvents: { mode: "auto", prompt: "Do not greet." } });
    expectSlackConfigValid({
      accounts: { ops: { presenceEvents: { mode: "on", prompt: "Account guidance" } } },
      channels: { C123: { presenceEvents: { mode: "off", prompt: "" } } },
    });
    expectSlackConfigIssue({ presenceEvents: { mode: "enabled" } }, "presenceEvents.mode");
    expectSlackConfigIssue({ presenceEvents: { prompt: false } }, "presenceEvents.prompt");
  });

  it("caps presence event prompts at the AGENTS.md bootstrap limit", () => {
    const maxPrompt = "x".repeat(20_000);
    const oversizedPrompt = `${maxPrompt}x`;

    expectSlackConfigValid({ presenceEvents: { prompt: maxPrompt } });
    expectSlackConfigIssue(
      { presenceEvents: { prompt: oversizedPrompt } },
      "presenceEvents.prompt",
    );
    expectSlackConfigIssue(
      { accounts: { ops: { presenceEvents: { prompt: oversizedPrompt } } } },
      "accounts.ops.presenceEvents.prompt",
    );
    expectSlackConfigIssue(
      { channels: { C123: { presenceEvents: { prompt: oversizedPrompt } } } },
      "channels.C123.presenceEvents.prompt",
    );
  });

  it("accepts historyLimit overrides per account", () => {
    const res = SlackConfigSchema.safeParse({
      historyLimit: 7,
      accounts: { ops: { historyLimit: 2 } },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.historyLimit).toBe(7);
      expect(res.data.accounts?.ops?.historyLimit).toBe(2);
    }
  });

  it("rejects Slack Web API URL config overrides", () => {
    const res = SlackConfigSchema.safeParse({
      apiUrl: "http://127.0.0.1:49152/api/",
      accounts: { ops: { apiUrl: "http://127.0.0.1:49153/api/" } },
    });

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(
        res.error.issues.some(
          (issue) => issue.code === "unrecognized_keys" && issue.keys.includes("apiUrl"),
        ),
      ).toBe(true);
    }
  });

  it("accepts unfurl controls at root and account level", () => {
    const res = SlackConfigSchema.safeParse({
      unfurlLinks: false,
      unfurlMedia: false,
      accounts: {
        ops: {
          unfurlLinks: true,
          unfurlMedia: false,
        },
      },
    });

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.unfurlLinks).toBe(false);
      expect(res.data.unfurlMedia).toBe(false);
      expect(res.data.accounts?.ops?.unfurlLinks).toBe(true);
      expect(res.data.accounts?.ops?.unfurlMedia).toBe(false);
    }
  });

  it("rejects invalid unfurl control types", () => {
    expectSlackConfigIssue({ unfurlLinks: "false" }, "unfurlLinks");
    expectSlackConfigIssue(
      { accounts: { ops: { unfurlMedia: "false" } } },
      "accounts.ops.unfurlMedia",
    );
  });

  it('rejects dmPolicy="open" without allowFrom "*"', () => {
    expectSlackConfigIssue(
      {
        dmPolicy: "open",
        allowFrom: ["U123"],
      },
      "allowFrom",
    );
  });

  it("accepts account allowlist policy inherited from the channel", () => {
    expectSlackConfigValid({
      allowFrom: ["U123"],
      botToken: "fake",
      appToken: "fake",
      accounts: {
        work: { dmPolicy: "allowlist", botToken: "fake", appToken: "fake" },
      },
    });
  });

  it("accepts progress commentary in streaming config", () => {
    expectSlackConfigValid({
      streaming: {
        mode: "progress",
        progress: { commentary: true },
      },
    });
  });

  it("rejects legacy nested DM access keys", () => {
    expectSlackConfigIssue({ dm: { policy: "open", allowFrom: ["U123"] } }, "dm");
  });

  it("accepts user token config fields", () => {
    expectSlackConfigValid({
      botToken: "test-bot-token",
      appToken: "test-app-token",
      userToken: "test-user-token",
      userTokenReadOnly: false,
    });
  });

  it("rejects retired Socket Mode ping/pong transport tuning", () => {
    expect(
      SlackConfigSchema.safeParse({
        mode: "socket",
        socketMode: {
          clientPingTimeout: 15_000,
          serverPingTimeout: 45_000,
          pingPongLoggingEnabled: true,
        },
        accounts: {
          ops: {
            socketMode: {
              clientPingTimeout: 20_000,
            },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts relay mode with a SecretInput auth token", () => {
    expectSlackConfigValid({
      mode: "relay",
      botToken: "test-bot-token",
      relay: {
        url: "wss://router.example.com/gateway/ws",
        authToken: { source: "env", provider: "default", id: "SLACK_RELAY_AUTH_TOKEN" },
        gatewayId: "team-gateway",
      },
    });
  });

  it("requires every relay connection field", () => {
    expectSlackConfigIssue({ mode: "relay" }, "relay.url");
    expectSlackConfigIssue(
      { mode: "relay", relay: { url: "wss://router.example.com/gateway/ws" } },
      "relay.authToken",
    );
    expectSlackConfigIssue(
      {
        mode: "relay",
        relay: {
          url: "wss://router.example.com/gateway/ws",
          authToken: "test-relay-auth-token",
        },
      },
      "relay.gatewayId",
    );
  });

  it.each(["http", "relay"] as const)(
    "does not require %s transport credentials when Slack is disabled",
    (mode) => {
      expectSlackConfigValid({ enabled: false, mode });
      expectSlackConfigValid({
        enabled: false,
        mode,
        accounts: { ops: { mode } },
      });
    },
  );

  it("accepts per-channel replyToMode", () => {
    expectSlackConfigValid({
      channels: {
        C123: { requireMention: false, replyToMode: "off" },
      },
    });
  });

  it("rejects invalid per-channel replyToMode", () => {
    expectSlackConfigIssue(
      {
        channels: {
          C123: { replyToMode: "sometimes" },
        },
      },
      "channels.C123.replyToMode",
    );
  });

  it("accepts account-level user token config", () => {
    expectSlackConfigValid({
      accounts: {
        work: {
          botToken: "test-bot-token",
          appToken: "test-app-token",
          userToken: "test-user-token",
          userTokenReadOnly: true,
        },
      },
    });
  });

  it("rejects invalid userTokenReadOnly types", () => {
    expectSlackConfigIssue(
      {
        botToken: "test-bot-token",
        appToken: "test-app-token",
        userToken: "test-user-token",
        userTokenReadOnly: "no",
      },
      "userTokenReadOnly",
    );
  });

  it("rejects invalid userToken types", () => {
    expectSlackConfigIssue(
      {
        botToken: "test-bot-token",
        appToken: "test-app-token",
        userToken: 123,
      },
      "userToken",
    );
  });

  it("accepts HTTP mode when signing secret is configured", () => {
    expectSlackConfigValid({
      mode: "http",
      signingSecret: "test-signing-secret",
    });
  });

  it("accepts HTTP mode when signing secret is configured as SecretRef", () => {
    expectSlackConfigValid({
      mode: "http",
      signingSecret: { source: "env", provider: "default", id: "SLACK_SIGNING_SECRET" },
    });
  });

  it("rejects HTTP mode without signing secret", () => {
    expectSlackConfigIssue({ mode: "http" }, "signingSecret");
  });

  it("rejects implicit account HTTP mode without signing secret", () => {
    expectSlackConfigIssue({ mode: "http", accounts: {} }, "signingSecret");
  });

  it("accepts inherited account HTTP mode with an account signing secret", () => {
    expectSlackConfigValid({
      mode: "http",
      accounts: {
        ops: {
          botToken: "test-bot-token",
          signingSecret: "test-ops-signing-secret",
          webhookPath: "/slack/events/ops",
        },
      },
    });
  });

  it("accepts inherited account HTTP mode with a signing secret SecretRef", () => {
    expectSlackConfigValid({
      mode: "http",
      accounts: {
        ops: {
          botToken: "test-bot-token",
          signingSecret: {
            source: "env",
            provider: "default",
            id: "SLACK_OPS_SIGNING_SECRET",
          },
          webhookPath: "/slack/events/ops",
        },
      },
    });
  });

  it("accepts independently signed accounts inheriting HTTP mode", () => {
    expectSlackConfigValid({
      mode: "http",
      accounts: {
        ops: {
          botToken: "test-ops-bot-token",
          signingSecret: "test-ops-signing-secret",
          webhookPath: "/slack/events/ops",
        },
        support: {
          botToken: "test-support-bot-token",
          signingSecret: "test-support-signing-secret",
          webhookPath: "/slack/events/support",
        },
      },
    });
  });

  it("skips disabled accounts inheriting HTTP mode", () => {
    expectSlackConfigValid({
      mode: "http",
      accounts: {
        disabled: { enabled: false },
        ops: {
          botToken: "test-bot-token",
          signingSecret: "test-ops-signing-secret",
        },
      },
    });
    expectSlackConfigValid({
      mode: "http",
      accounts: { ops: { enabled: false } },
    });
  });

  it("reports a missing inherited HTTP signing secret on its account only", () => {
    const result = SlackConfigSchema.safeParse({
      mode: "http",
      accounts: { ops: { botToken: "test-bot-token" } },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join("."))).toEqual([
        "accounts.ops.signingSecret",
      ]);
    }
  });

  it("accepts account HTTP mode when base signing secret is set", () => {
    expectSlackConfigValid({
      signingSecret: "test-signing-secret",
      accounts: {
        ops: {
          mode: "http",
        },
      },
    });
  });

  it("accepts account HTTP mode when account signing secret is set as SecretRef", () => {
    expectSlackConfigValid({
      accounts: {
        ops: {
          mode: "http",
          signingSecret: {
            source: "env",
            provider: "default",
            id: "SLACK_OPS_SIGNING_SECRET",
          },
        },
      },
    });
  });

  it("rejects account HTTP mode without signing secret", () => {
    expectSlackConfigIssue(
      {
        accounts: {
          ops: {
            mode: "http",
          },
        },
      },
      "accounts.ops.signingSecret",
    );
  });

  it("accepts canonical implicit mention policy at root and account scope", () => {
    expectSlackConfigValid({
      implicitMentions: { replyToBot: false, threadParticipation: true },
      accounts: {
        ops: {
          implicitMentions: { quotedBot: false },
        },
      },
    });
  });

  it("rejects the retired thread requireExplicitMention runtime key", () => {
    expectSlackConfigIssue({ thread: { requireExplicitMention: true } }, "thread");
  });
});
