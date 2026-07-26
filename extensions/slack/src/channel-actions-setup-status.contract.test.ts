// Slack tests cover channel actions setup status.contract plugin behavior.
import {
  installChannelActionsContractSuite,
  installChannelSetupContractSuite,
  installChannelStatusContractSuite,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect } from "vitest";
import { slackPlugin } from "../api.js";
import { slackSetupPlugin } from "../setup-plugin-api.js";

const slackDefaultActions = [
  "send",
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
        name: "interactive replies keep the shared presentation capability",
        cfg: {
          channels: {
            slack: {
              botToken: "xoxb-test",
              appToken: "xapp-test",
              capabilities: {
                interactiveReplies: true,
              },
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
        cfg: {} as OpenClawConfig,
        input: {
          identity: "user",
          mode: "relay",
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
        name: "explicit bot identity keeps the bot and app token setup contract",
        cfg: {} as OpenClawConfig,
        input: {
          identity: "bot",
          mode: "http",
          botToken: "test-bot-token",
          appToken: "test-app-token",
        },
        expectedAccountId: "default",
        assertPatchedConfig: (cfg) => {
          expect(cfg.channels?.slack).toMatchObject({
            enabled: true,
            postAs: "bot",
            botToken: "test-bot-token",
            appToken: "test-app-token",
          });
          expect(cfg.channels?.slack?.mode).toBeUndefined();
        },
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
