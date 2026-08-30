// Slack tests cover channel actions setup status.contract plugin behavior.
import {
  installChannelActionsContractSuite,
  installChannelSetupContractSuite,
  installChannelStatusContractSuite,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { moveSingleAccountChannelSectionToDefaultAccount } from "openclaw/plugin-sdk/setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "../api.js";
import { SlackConfigSchema } from "../config-api.js";
import { slackSetupPlugin } from "../setup-plugin-api.js";
import { inspectSlackAccount } from "./account-inspect.js";

const slackDefaultActions = [
  "send",
  "conversation-open",
  "react",
  "reactions",
  "read",
  "edit",
  "delete",
  "download-file",
  "upload-file",
  "pin",
  "unpin",
  "list-pins",
  "member-info",
  "emoji-list",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("slack actions contract", () => {
  installChannelActionsContractSuite({
    plugin: slackPlugin,
    unsupportedAction: "poll",
    cases: [
      {
        name: "configured account exposes default Slack actions",
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
              appToken: "xapp-test",
            },
          },
        } as OpenClawConfig,
        expectedActions: slackDefaultActions,
        expectedCapabilities: ["presentation"],
      },
      {
        name: "missing tokens disables the actions surface",
        cfg: {
          channels: {
            slack: {
              enabled: true,
            },
          },
        } as OpenClawConfig,
        expectedActions: [],
        expectedCapabilities: [],
      },
    ],
  });
});

describe("slack setup contract", () => {
  it("keeps a shared HTTP signing secret at the channel root during account promotion", () => {
    const cfg = {
      channels: {
        slack: {
          enabled: true,
          mode: "http",
          botToken: "xoxb-default",
          signingSecret: "shared-signing-secret",
        },
      },
    } as OpenClawConfig;

    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg,
      channelKey: "slack",
      setupSurface: slackSetupPlugin.setupContract,
    });

    expect(next.channels?.slack?.signingSecret).toBe("shared-signing-secret");
    expect(next.channels?.slack).not.toHaveProperty("botToken");
    expect(next.channels?.slack?.accounts?.default).toMatchObject({
      botToken: "xoxb-default",
    });
    expect(inspectSlackAccount({ cfg: next, accountId: "default" })).toMatchObject({
      configured: true,
      signingSecret: "shared-signing-secret",
    });
    expect(SlackConfigSchema.safeParse(next.channels?.slack).success).toBe(true);
  });

  it.each([
    {
      name: "an HTTP account with its own signing secret",
      account: {
        mode: "http" as const,
        botToken: "xoxb-target",
        signingSecret: "target-signing-secret",
      },
    },
    {
      name: "a Socket Mode account",
      account: { mode: "socket" as const, botToken: "xoxb-target", appToken: "xapp-target" },
    },
    {
      name: "a relay account",
      account: {
        mode: "relay" as const,
        botToken: "xoxb-target",
        relay: {
          url: "https://relay.example.test",
          authToken: "relay-auth-token",
          gatewayId: "relay-gateway",
        },
      },
    },
  ])("preserves sibling HTTP credentials when promoting $name", ({ account }) => {
    const cfg = {
      channels: {
        slack: {
          enabled: true,
          mode: "http",
          signingSecret: "shared-signing-secret",
          accounts: {
            default: account,
            bot: { mode: "http", botToken: "xoxb-sibling" },
            user: { mode: "http", postAs: "user", userToken: "xoxp-sibling" },
          },
        },
      },
    } as OpenClawConfig;

    const next = moveSingleAccountChannelSectionToDefaultAccount({
      cfg,
      channelKey: "slack",
      setupSurface: slackSetupPlugin.setupContract,
    });

    expect(next.channels?.slack?.signingSecret).toBe("shared-signing-secret");
    expect(SlackConfigSchema.safeParse(next.channels?.slack).success).toBe(true);
    expect(inspectSlackAccount({ cfg: next, accountId: "bot" })).toMatchObject({
      configured: true,
      signingSecret: "shared-signing-secret",
    });
    expect(inspectSlackAccount({ cfg: next, accountId: "user" })).toMatchObject({
      configured: true,
      signingSecret: "shared-signing-secret",
    });
  });

  it("recognizes HTTP bot accounts at the setup plugin boundary without an app token", () => {
    const cfg = {
      channels: {
        slack: {
          mode: "http",
          botToken: "xoxb-test",
          signingSecret: "test-signing-secret",
        },
      },
    } as OpenClawConfig;
    const account = slackSetupPlugin.config.resolveAccount(cfg, "default");

    expect(slackSetupPlugin.config.isConfigured?.(account, cfg)).toBe(true);
    expect(slackSetupPlugin.config.describeAccount?.(account, cfg)).toMatchObject({
      configured: true,
    });
  });

  installChannelSetupContractSuite({
    plugin: slackSetupPlugin,
    cases: [
      {
        name: "default account stores tokens and enables the channel",
        cfg: {} as OpenClawConfig,
        input: {
          botToken: "xoxb-test",
          appToken: "xapp-test",
        },
        expectedAccountId: "default",
        assertPatchedConfig: (cfg) => {
          expect(cfg.channels?.slack?.enabled).toBe(true);
          expect(cfg.channels?.slack?.botToken).toBe("xoxb-test");
          expect(cfg.channels?.slack?.appToken).toBe("xapp-test");
        },
      },
      {
        name: "non-default env setup is rejected",
        cfg: {} as OpenClawConfig,
        accountId: "ops",
        input: {
          useEnv: true,
        },
        expectedAccountId: "ops",
        expectedValidation: "Slack env tokens can only be used for the default account.",
      },
      {
        name: "HTTP env setup accepts a configured signing secret without an app token",
        cfg: {
          channels: {
            slack: {
              mode: "http",
              signingSecret: "test-signing-secret",
            },
          },
        } as OpenClawConfig,
        input: {
          useEnv: true,
        },
        beforeTest: () => {
          expect(
            slackSetupPlugin.setupContract?.metadata.fields.find((field) => field.key === "useEnv"),
          ).toMatchObject({ kind: "boolean", envVars: ["SLACK_BOT_TOKEN"] });
          vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
          vi.stubEnv("SLACK_APP_TOKEN", "");
        },
        assertPatchedConfig: (cfg) => {
          expect(cfg.channels?.slack).toMatchObject({
            enabled: true,
            mode: "http",
            signingSecret: "test-signing-secret",
          });
          expect(cfg.channels?.slack?.appToken).toBeUndefined();
        },
      },
      {
        name: "Socket Mode env setup rejects a missing app token",
        cfg: {} as OpenClawConfig,
        input: {
          useEnv: true,
        },
        beforeTest: () => {
          vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
          vi.stubEnv("SLACK_APP_TOKEN", "");
        },
        expectedValidation: "Slack Socket Mode requires SLACK_APP_TOKEN when using --use-env.",
      },
      {
        name: "Socket Mode env setup accepts bot and app tokens",
        cfg: {} as OpenClawConfig,
        input: {
          useEnv: true,
        },
        beforeTest: () => {
          vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-test");
          vi.stubEnv("SLACK_APP_TOKEN", "xapp-test");
        },
        assertPatchedConfig: (cfg) => {
          expect(cfg.channels?.slack).toMatchObject({ enabled: true });
        },
      },
      {
        name: "user identity stores the user and Socket Mode transport tokens",
        cfg: {} as OpenClawConfig,
        input: {
          identity: "user",
          userToken: "test-user-token",
          appToken: "test-app-token",
        },
        expectedAccountId: "default",
        assertPatchedConfig: (cfg) => {
          expect(cfg.channels?.slack).toMatchObject({
            enabled: true,
            postAs: "user",
            userToken: "test-user-token",
            appToken: "test-app-token",
          });
          expect(cfg.channels?.slack?.botToken).toBeUndefined();
        },
      },
      {
        name: "HTTP user identity stores the user token and signing secret",
        cfg: {} as OpenClawConfig,
        input: {
          identity: "user",
          mode: "http",
          userToken: "test-user-token",
          signingSecret: "test-signing-secret",
        },
        expectedAccountId: "default",
        assertPatchedConfig: (cfg) => {
          expect(cfg.channels?.slack).toMatchObject({
            enabled: true,
            postAs: "user",
            mode: "http",
            userToken: "test-user-token",
            signingSecret: "test-signing-secret",
          });
          expect(cfg.channels?.slack?.botToken).toBeUndefined();
          expect(cfg.channels?.slack?.appToken).toBeUndefined();
        },
      },
      {
        name: "existing user identity stores an HTTP mode update",
        cfg: {
          channels: {
            slack: {
              postAs: "user",
              userToken: "test-old-user-token",
              appToken: "test-old-app-token",
            },
          },
        } as OpenClawConfig,
        input: {
          mode: "http",
          userToken: "test-user-token",
          signingSecret: "test-signing-secret",
        },
        expectedAccountId: "default",
        assertPatchedConfig: (cfg) => {
          expect(cfg.channels?.slack).toMatchObject({
            enabled: true,
            postAs: "user",
            mode: "http",
            userToken: "test-user-token",
            signingSecret: "test-signing-secret",
          });
        },
      },
      {
        name: "user identity rejects relay mode",
        cfg: {
          channels: {
            slack: {
              mode: "relay",
            },
          },
        } as OpenClawConfig,
        input: {
          identity: "user",
          userToken: "test-user-token",
          appToken: "test-app-token",
        },
        expectedAccountId: "default",
        expectedValidation:
          'Slack user identity setup supports mode "socket" or "http", not "relay".',
      },
      {
        name: "user identity rejects the bot-only env shortcut",
        cfg: {} as OpenClawConfig,
        input: {
          identity: "user",
          useEnv: true,
        },
        expectedAccountId: "default",
        expectedValidation:
          "Slack user identity setup does not support --use-env; configure userToken and the transport credential explicitly.",
      },
      {
        name: "HTTP bot identity stores the bot token and signing secret",
        cfg: {} as OpenClawConfig,
        input: {
          identity: "bot",
          mode: "http",
          botToken: "test-bot-token",
          signingSecret: "test-signing-secret",
        },
        expectedAccountId: "default",
        assertPatchedConfig: (cfg) => {
          expect(cfg.channels?.slack).toMatchObject({
            enabled: true,
            postAs: "bot",
            mode: "http",
            botToken: "test-bot-token",
            signingSecret: "test-signing-secret",
          });
          expect(cfg.channels?.slack?.appToken).toBeUndefined();
        },
      },
      {
        name: "HTTP bot identity rejects an app token without a signing secret",
        cfg: {} as OpenClawConfig,
        input: {
          identity: "bot",
          mode: "http",
          botToken: "test-bot-token",
          appToken: "test-app-token",
        },
        expectedAccountId: "default",
        expectedValidation:
          "Slack HTTP mode requires --bot-token and --signing-secret (or --use-env).",
      },
    ],
  });
});

describe("slack status contract", () => {
  installChannelStatusContractSuite({
    plugin: slackPlugin,
    cases: [
      {
        name: "configured account produces a configured status snapshot",
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
              appToken: "xapp-test",
            },
          },
        } as OpenClawConfig,
        runtime: {
          accountId: "default",
          connected: true,
          running: true,
        },
        probe: { ok: true },
        assertSnapshot: (snapshot) => {
          expect(snapshot.accountId).toBe("default");
          expect(snapshot.enabled).toBe(true);
          expect(snapshot.configured).toBe(true);
        },
      },
    ],
  });
});
