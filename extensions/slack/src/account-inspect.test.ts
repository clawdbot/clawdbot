// Slack tests cover account inspection and credential status reporting.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { isSlackPluginAccountConfigured } from "./account-configured.js";
import { inspectSlackAccount } from "./account-inspect.js";

function isInspectedSlackAccountUsable(account: ReturnType<typeof inspectSlackAccount>): boolean {
  return isSlackPluginAccountConfigured({
    ...account,
    identity: account.identity ?? "bot",
  });
}

describe("inspectSlackAccount", () => {
  it("reports user-token source and status for a configured user identity", () => {
    const account = inspectSlackAccount({
      cfg: {
        channels: {
          slack: {
            postAs: "user",
            userToken: "test-user-token",
            appToken: "test-app-token",
          },
        },
      } as OpenClawConfig,
      envBotToken: "",
      envAppToken: "",
      envUserToken: "",
    });

    expect(account).toMatchObject({
      identity: "user",
      configured: true,
      userTokenSource: "config",
      userTokenStatus: "available",
      appTokenSource: "config",
      appTokenStatus: "available",
      botTokenStatus: "missing",
    });
  });

  it("requires the selected HTTP transport credential for user identity", () => {
    const account = inspectSlackAccount({
      cfg: {
        channels: {
          slack: {
            postAs: "user",
            mode: "http",
            userToken: "test-user-token",
          },
        },
      } as OpenClawConfig,
      envBotToken: "",
      envAppToken: "",
      envUserToken: "",
    });

    expect(account).toMatchObject({
      identity: "user",
      configured: false,
      userTokenSource: "config",
      userTokenStatus: "available",
      signingSecretSource: "none",
      signingSecretStatus: "missing",
    });
  });

  it("keeps bot identity inspection output free of a new identity field", () => {
    const account = inspectSlackAccount({
      cfg: {
        channels: {
          slack: {
            botToken: "test-bot-token",
            appToken: "test-app-token",
          },
        },
      } as OpenClawConfig,
      envBotToken: "",
      envAppToken: "",
      envUserToken: "",
    });

    expect(account.configured).toBe(true);
    expect(account).not.toHaveProperty("identity");
    expect(account).toMatchObject({
      botTokenSource: "config",
      botTokenStatus: "available",
      appTokenSource: "config",
      appTokenStatus: "available",
      userTokenSource: "none",
      userTokenStatus: "missing",
    });
  });

  it("does not fall through an unavailable configured ref to environment tokens", () => {
    const account = inspectSlackAccount({
      cfg: {
        channels: {
          slack: {
            botToken: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_TEST_MISSING_SLACK_BOT_TOKEN",
            },
            appToken: "test-app-token",
          },
        },
      } as OpenClawConfig,
      envBotToken: "xoxb-lower-precedence",
      envAppToken: "",
      envUserToken: "",
    });

    expect(account.botToken).toBeUndefined();
    expect(account).toMatchObject({
      botTokenSource: "config",
      botTokenStatus: "configured_unavailable",
      configured: true,
    });
    expect(isInspectedSlackAccountUsable(account)).toBe(false);
  });

  it("keeps a healthy bot identity configured when its optional user token is unavailable", () => {
    const account = inspectSlackAccount({
      cfg: {
        channels: {
          slack: {
            botToken: "test-bot-token",
            appToken: "test-app-token",
            userToken: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_TEST_MISSING_OPTIONAL_SLACK_USER_TOKEN",
            },
          },
        },
      } as OpenClawConfig,
      envBotToken: "",
      envAppToken: "",
      envUserToken: "",
    });

    expect(account).toMatchObject({
      configured: true,
      botTokenStatus: "available",
      appTokenStatus: "available",
      userTokenStatus: "configured_unavailable",
    });
    expect(isInspectedSlackAccountUsable(account)).toBe(true);
  });

  it("keeps incomplete required credentials unconfigured even when another token is unavailable", () => {
    const account = inspectSlackAccount({
      cfg: {
        channels: {
          slack: {
            botToken: {
              source: "env",
              provider: "default",
              id: "OPENCLAW_TEST_MISSING_REQUIRED_SLACK_BOT_TOKEN",
            },
          },
        },
      } as OpenClawConfig,
      envBotToken: "",
      envAppToken: "",
      envUserToken: "",
    });

    expect(account).toMatchObject({
      configured: false,
      botTokenStatus: "configured_unavailable",
      appTokenStatus: "missing",
    });
    expect(isInspectedSlackAccountUsable(account)).toBe(false);
  });
});
