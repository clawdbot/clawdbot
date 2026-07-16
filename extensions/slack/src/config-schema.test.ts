// Slack tests cover config schema plugin behavior.
import { describe, expect, it } from "vitest";
import { SlackConfigSchema } from "../config-api.js";

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

describe("slack config schema", () => {
  it("accepts explicit Enterprise Grid org-install mode", () => {
    expectSlackConfigValid({ enterpriseOrgInstall: true });
    expectSlackConfigValid({ accounts: { org: { enterpriseOrgInstall: true } } });
    expectSlackConfigIssue({ enterpriseOrgInstall: "true" }, "enterpriseOrgInstall");
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

  it("keeps presence events off by default and accepts account/channel modes", () => {
    const absent = SlackConfigSchema.safeParse({});
    expect(absent.success).toBe(true);
    if (absent.success) {
      expect(absent.data.presenceEvents).toBeUndefined();
    }
    expectSlackConfigValid({ presenceEvents: { mode: "auto" } });
    expectSlackConfigValid({
      accounts: { ops: { presenceEvents: { mode: "on" } } },
      channels: { C123: { presenceEvents: { mode: "off" } } },
    });
    expectSlackConfigIssue({ presenceEvents: { mode: "enabled" } }, "presenceEvents.mode");
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

  it('accepts legacy dm.policy="open" with top-level allowFrom alias', () => {
    expectSlackConfigValid({
      dm: { policy: "open", allowFrom: ["U123"] },
      allowFrom: ["*"],
    });
  });

  it("accepts user token config fields", () => {
    expectSlackConfigValid({
      botToken: "xoxb-any",
      appToken: "xapp-any",
      userToken: "xoxp-any",
      userTokenReadOnly: false,
    });
  });

  it("accepts Socket Mode ping/pong transport tuning", () => {
    expectSlackConfigValid({
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
    });
  });

  it("accepts relay mode with a SecretInput auth token", () => {
    expectSlackConfigValid({
      mode: "relay",
      botToken: "xoxb-any",
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
          authToken: "secret",
        },
      },
      "relay.gatewayId",
    );
  });

  it("rejects invalid Socket Mode ping/pong transport tuning", () => {
    expectSlackConfigIssue(
      {
        socketMode: {
          clientPingTimeout: 0,
        },
      },
      "socketMode.clientPingTimeout",
    );
  });

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
          botToken: "xoxb-any",
          appToken: "xapp-any",
          userToken: "xoxp-any",
          userTokenReadOnly: true,
        },
      },
    });
  });

  it("rejects invalid userTokenReadOnly types", () => {
    expectSlackConfigIssue(
      {
        botToken: "xoxb-any",
        appToken: "xapp-any",
        userToken: "xoxp-any",
        userTokenReadOnly: "no",
      },
      "userTokenReadOnly",
    );
  });

  it("rejects invalid userToken types", () => {
    expectSlackConfigIssue(
      {
        botToken: "xoxb-any",
        appToken: "xapp-any",
        userToken: 123,
      },
      "userToken",
    );
  });

  it("accepts HTTP mode when signing secret is configured", () => {
    expectSlackConfigValid({
      mode: "http",
      signingSecret: "secret",
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

  it("accepts account HTTP mode when base signing secret is set", () => {
    expectSlackConfigValid({
      signingSecret: "secret",
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
});
