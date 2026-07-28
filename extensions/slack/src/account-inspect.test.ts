// Slack tests cover account inspection and credential status reporting.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { inspectSlackAccount } from "./account-inspect.js";

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
});
