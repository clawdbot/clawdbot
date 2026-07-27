// Slack tests cover setup surface plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createQueuedWizardPrompter,
  createSetupWizardAdapter,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  runSetupWizardPrepare,
  runSetupWizardFinalize,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSlackSetupWizardBase, slackSetupAdapter } from "./setup-core.js";
import { buildSlackSetupLines } from "./setup-shared.js";

const slackSetupWizard = createSlackSetupWizardBase({
  promptAllowFrom: async ({ cfg }) => cfg,
  resolveAllowFromEntries: async ({ entries }) =>
    entries.map((entry) => ({
      input: entry,
      resolved: false,
      id: null,
    })),
  resolveGroupAllowlist: async ({ entries }) => entries,
});

const credentialOnlySlackSetupWizard = {
  ...slackSetupWizard,
  dmPolicy: undefined,
  allowFrom: undefined,
  groupAccess: undefined,
  finalize: undefined,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

const baseCfg = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

function requireFirstStringArg(mock: ReturnType<typeof vi.fn>, label: string): string {
  const [call] = mock.mock.calls;
  if (!call || typeof call[0] !== "string") {
    throw new Error(`expected ${label}`);
  }
  return call[0];
}

describe("slackSetupWizard.finalize", () => {
  it("prompts to enable interactive replies for newly configured Slack accounts", async () => {
    const confirm = vi.fn(async () => true);

    const result = await runSetupWizardFinalize({
      finalize: slackSetupWizard.finalize,
      cfg: baseCfg,
      prompter: createTestWizardPrompter({
        confirm: confirm as WizardPrompter["confirm"],
      }),
    });
    if (!result?.cfg) {
      throw new Error("expected finalize to patch config");
    }

    expect(confirm).toHaveBeenCalledWith({
      message: "Enable Slack interactive replies (buttons/selects) for agent responses?",
      initialValue: true,
    });
    expect(
      (result.cfg.channels?.slack as { capabilities?: { interactiveReplies?: boolean } })
        ?.capabilities?.interactiveReplies,
    ).toBe(true);
  });

  it("auto-enables interactive replies for quickstart defaults without prompting", async () => {
    const confirm = vi.fn(async () => false);

    const result = await runSetupWizardFinalize({
      finalize: slackSetupWizard.finalize,
      cfg: baseCfg,
      options: { quickstartDefaults: true },
      prompter: createTestWizardPrompter({
        confirm: confirm as WizardPrompter["confirm"],
      }),
    });
    if (!result?.cfg) {
      throw new Error("expected finalize to patch config");
    }

    expect(confirm).not.toHaveBeenCalled();
    expect(
      (result.cfg.channels?.slack as { capabilities?: { interactiveReplies?: boolean } })
        ?.capabilities?.interactiveReplies,
    ).toBe(true);
  });
});

describe("slackSetupWizard.prepare", () => {
  it("keeps the manifest out of framed intro note lines", () => {
    const lines = buildSlackSetupLines();

    expect(lines.join("\n")).not.toContain("Manifest (JSON):");
    expect(lines.join("\n")).not.toContain('"display_information"');
    expect(lines).toContain("Manifest JSON follows as plain text for copy/paste.");
  });

  it("prints the manifest as plain JSON when Slack is not configured", async () => {
    const plain = vi.fn<NonNullable<WizardPrompter["plain"]>>(async () => {});
    const note = vi.fn(async () => {});

    await runSetupWizardPrepare({
      prepare: slackSetupWizard.prepare,
      cfg: { channels: { slack: {} } } as OpenClawConfig,
      prompter: createTestWizardPrompter({
        plain,
        note,
      }),
    });

    expect(plain).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith(buildSlackSetupLines().join("\n"), expect.any(String));
    const manifest = requireFirstStringArg(plain, "Slack manifest plain text");
    expect(JSON.parse(manifest)).toEqual({
      display_information: {
        name: "OpenClaw",
        description: "OpenClaw connector for OpenClaw",
      },
      features: {
        bot_user: {
          display_name: "OpenClaw",
          always_online: true,
        },
        app_home: {
          home_tab_enabled: true,
          messages_tab_enabled: true,
          messages_tab_read_only_enabled: false,
        },
        agent_view: {
          agent_description: "OpenClaw connects Slack Agent View conversations to OpenClaw agents.",
          suggested_prompts: [
            {
              title: "What can you do?",
              message: "What can you help me with?",
            },
            {
              title: "Summarize this channel",
              message: "Summarize the recent activity in this channel.",
            },
            {
              title: "Draft a reply",
              message: "Help me draft a reply.",
            },
          ],
        },
        slash_commands: [
          {
            command: "/openclaw",
            description: "Send a message to OpenClaw",
            should_escape: false,
          },
        ],
      },
      oauth_config: {
        scopes: {
          bot: [
            "app_mentions:read",
            "assistant:write",
            "channels:history",
            "channels:read",
            "chat:write",
            "commands",
            "emoji:read",
            "files:read",
            "files:write",
            "groups:history",
            "groups:read",
            "im:history",
            "im:read",
            "im:write",
            "mpim:history",
            "mpim:read",
            "mpim:write",
            "pins:read",
            "pins:write",
            "reactions:read",
            "reactions:write",
            "usergroups:read",
            "users:read",
          ],
        },
      },
      settings: {
        socket_mode_enabled: true,
        event_subscriptions: {
          bot_events: [
            "app_home_opened",
            "app_mention",
            "app_context_changed",
            "channel_rename",
            "member_joined_channel",
            "member_left_channel",
            "message.channels",
            "message.groups",
            "message.im",
            "message.mpim",
            "pin_added",
            "pin_removed",
            "reaction_added",
            "reaction_removed",
          ],
        },
      },
    });
  });

  it("collects only the user token and Socket Mode transport token for user identity", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["user"],
      textValues: ["test-user-token", "test-app-token"],
    });
    const configure = createSetupWizardAdapter({
      plugin: {
        id: "slack",
        meta: { label: "Slack" },
        config: {
          listAccountIds: () => ["default"],
          defaultAccountId: () => "default",
        },
        setup: slackSetupAdapter,
      } as never,
      wizard: credentialOnlySlackSetupWizard,
    }).configure;

    const result = await runSetupWizardConfigure({
      configure,
      cfg: {} as OpenClawConfig,
      prompter: queued.prompter,
      options: { secretInputMode: "plaintext" as const },
    });

    expect(result.cfg.channels?.slack).toMatchObject({
      enabled: true,
      postAs: "user",
      userToken: "test-user-token",
      appToken: "test-app-token",
    });
    expect(result.cfg.channels?.slack?.botToken).toBeUndefined();
    expect(
      queued.text.mock.calls.map(([params]) => (params as { message: string }).message),
    ).toEqual(["Enter Slack user OAuth token", "Enter Slack app token (xapp-...)"]);
    expect(queued.note).toHaveBeenCalledTimes(1);
    const instructions = requireFirstStringArg(queued.note, "Slack user identity instructions");
    expect(instructions).toContain("User Token Scopes");
    expect(instructions).toContain("Subscribe to events on behalf of users");
    expect(instructions).toContain("/channels/slack#user-identity-post-as-a-real-person");
    expect(queued.select.mock.invocationCallOrder[0]).toBeLessThan(
      queued.note.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("collects a signing secret instead of an app token for HTTP user identity", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["user"],
      textValues: ["test-user-token", "test-signing-secret"],
    });
    const configure = createSetupWizardAdapter({
      plugin: {
        id: "slack",
        meta: { label: "Slack" },
        config: {
          listAccountIds: () => ["default"],
          defaultAccountId: () => "default",
        },
        setup: slackSetupAdapter,
      } as never,
      wizard: credentialOnlySlackSetupWizard,
    }).configure;

    const result = await runSetupWizardConfigure({
      configure,
      cfg: { channels: { slack: { mode: "http" } } } as OpenClawConfig,
      prompter: queued.prompter,
      options: { secretInputMode: "plaintext" as const },
    });

    expect(result.cfg.channels?.slack).toMatchObject({
      enabled: true,
      postAs: "user",
      mode: "http",
      userToken: "test-user-token",
      signingSecret: "test-signing-secret",
    });
    expect(result.cfg.channels?.slack?.botToken).toBeUndefined();
    expect(result.cfg.channels?.slack?.appToken).toBeUndefined();
  });

  it("continues user setup after preserving a user-token SecretRef", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["user"],
      confirmValues: [true],
      textValues: ["test-app-token"],
    });
    const configure = createSetupWizardAdapter({
      plugin: {
        id: "slack",
        meta: { label: "Slack" },
        config: {
          listAccountIds: () => ["work"],
          defaultAccountId: () => "work",
        },
        setup: slackSetupAdapter,
      } as never,
      wizard: credentialOnlySlackSetupWizard,
    }).configure;
    const userTokenRef = {
      source: "env" as const,
      provider: "default",
      id: "TEST_SLACK_USER_TOKEN",
    };

    const result = await runSetupWizardConfigure({
      configure,
      cfg: {
        channels: {
          slack: {
            accounts: {
              work: { postAs: "user", userToken: userTokenRef },
            },
          },
        },
      } as OpenClawConfig,
      prompter: queued.prompter,
      options: { secretInputMode: "plaintext" as const },
    });

    expect(result.cfg.channels?.slack?.accounts?.work).toMatchObject({
      postAs: "user",
      userToken: userTokenRef,
      appToken: "test-app-token",
    });
  });

  it.each([
    { name: "new setup", cfg: {} as OpenClawConfig },
    {
      name: "switch from user identity",
      cfg: { channels: { slack: { postAs: "user" } } } as OpenClawConfig,
    },
  ])("keeps bot identity implicit for $name", async ({ cfg }) => {
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("SLACK_APP_TOKEN", "");
    const queued = createQueuedWizardPrompter({
      selectValues: ["bot"],
      textValues: ["test-bot-token", "test-app-token"],
    });
    const configure = createSetupWizardAdapter({
      plugin: {
        id: "slack",
        meta: { label: "Slack" },
        config: {
          listAccountIds: () => ["default"],
          defaultAccountId: () => "default",
        },
        setup: slackSetupAdapter,
      } as never,
      wizard: credentialOnlySlackSetupWizard,
    }).configure;

    const result = await runSetupWizardConfigure({
      configure,
      cfg,
      prompter: queued.prompter,
      options: { secretInputMode: "plaintext" as const },
    });

    expect(result.cfg.channels?.slack).toEqual({
      enabled: true,
      botToken: "test-bot-token",
      appToken: "test-app-token",
    });
    expect(JSON.stringify(result.cfg.channels?.slack)).toBe(
      '{"enabled":true,"botToken":"test-bot-token","appToken":"test-app-token"}',
    );
    expect(result.cfg.channels?.slack).not.toHaveProperty("postAs");
  });

  it("keeps a named bot override when the channel default is user identity", async () => {
    const queued = createQueuedWizardPrompter({
      selectValues: ["bot"],
      textValues: ["test-bot-token", "test-app-token"],
    });
    const configure = createSetupWizardAdapter({
      plugin: {
        id: "slack",
        meta: { label: "Slack" },
        config: {
          listAccountIds: () => ["work"],
          defaultAccountId: () => "work",
        },
        setup: slackSetupAdapter,
      } as never,
      wizard: credentialOnlySlackSetupWizard,
    }).configure;

    const result = await runSetupWizardConfigure({
      configure,
      cfg: {
        channels: {
          slack: {
            postAs: "user",
            userToken: "test-user-token",
            appToken: "test-user-app-token",
            accounts: {
              work: { userToken: "", appToken: "" },
            },
          },
        },
      } as OpenClawConfig,
      prompter: queued.prompter,
      options: { secretInputMode: "plaintext" as const },
    });

    expect(result.cfg.channels?.slack?.postAs).toBe("user");
    expect(result.cfg.channels?.slack?.accounts?.work).toMatchObject({
      enabled: true,
      postAs: "bot",
      botToken: "test-bot-token",
      appToken: "test-app-token",
    });
  });

  it("lets a configured user identity switch back to implicit bot", async () => {
    const queued = createQueuedWizardPrompter({ selectValues: ["bot"] });

    const result = await runSetupWizardPrepare({
      prepare: slackSetupWizard.prepare,
      cfg: {
        channels: {
          slack: {
            postAs: "user",
            userToken: "test-user-token",
            appToken: "test-app-token",
          },
        },
      } as OpenClawConfig,
      prompter: queued.prompter,
    });

    expect(queued.select).toHaveBeenCalledTimes(1);
    expect(result?.cfg.channels?.slack).toMatchObject({
      enabled: true,
      userToken: "test-user-token",
      appToken: "test-app-token",
    });
    expect(result?.cfg.channels?.slack).not.toHaveProperty("postAs");
  });

  it("does not print the manifest after Slack credentials are configured", async () => {
    const queued = createQueuedWizardPrompter();

    await runSetupWizardPrepare({
      prepare: slackSetupWizard.prepare,
      cfg: baseCfg,
      prompter: queued.prompter,
    });

    expect(queued.select).not.toHaveBeenCalled();
    expect(queued.plain).not.toHaveBeenCalled();
  });
});

describe("slackSetupWizard.dmPolicy", () => {
  it("reads the named-account DM policy instead of the channel root", () => {
    expect(
      slackSetupWizard.dmPolicy?.getCurrent(
        {
          channels: {
            slack: {
              dmPolicy: "disabled",
              accounts: {
                alerts: {
                  dmPolicy: "allowlist",
                  botToken: "xoxb-alerts",
                  appToken: "xapp-alerts",
                },
              },
            },
          },
        } as OpenClawConfig,
        "alerts",
      ),
    ).toBe("allowlist");
  });

  it("reports account-scoped config keys for named accounts", () => {
    expect(slackSetupWizard.dmPolicy?.resolveConfigKeys?.({}, "alerts")).toEqual({
      policyKey: "channels.slack.accounts.alerts.dmPolicy",
      allowFromKey: "channels.slack.accounts.alerts.allowFrom",
    });
  });

  it('writes open policy state to the named account and preserves inherited allowFrom with "*"', () => {
    const next = slackSetupWizard.dmPolicy?.setPolicy(
      {
        channels: {
          slack: {
            allowFrom: ["U123"],
            accounts: {
              alerts: {
                botToken: "xoxb-alerts",
                appToken: "xapp-alerts",
              },
            },
          },
        },
      } as OpenClawConfig,
      "open",
      "alerts",
    );

    expect(next?.channels?.slack?.dmPolicy).toBeUndefined();
    expect(next?.channels?.slack?.accounts?.alerts?.dmPolicy).toBe("open");
    expect(next?.channels?.slack?.accounts?.alerts?.allowFrom).toEqual(["U123", "*"]);
  });
});

describe("slackSetupWizard.status", () => {
  it("defers identity-specific setup instructions until after identity selection", () => {
    expect("introNote" in slackSetupWizard).toBe(false);
  });

  it.each([
    {
      name: "Socket Mode",
      slack: {
        postAs: "user" as const,
        userToken: "test-user-token",
        appToken: "test-app-token",
      },
    },
    {
      name: "HTTP mode",
      slack: {
        postAs: "user" as const,
        mode: "http" as const,
        userToken: "test-user-token",
        signingSecret: "test-signing-secret",
      },
    },
  ])("treats a complete user-identity $name account as configured", async ({ slack }) => {
    expect(
      await slackSetupWizard.status.resolveConfigured({
        cfg: { channels: { slack } } as OpenClawConfig,
      }),
    ).toBe(true);
  });

  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const configured = await slackSetupWizard.status.resolveConfigured({
      cfg: {
        channels: {
          slack: {
            defaultAccount: "work",
            botToken: "xoxb-root",
            appToken: "xapp-root",
            accounts: {
              alerts: {
                botToken: "xoxb-alerts",
                appToken: "xapp-alerts",
              },
              work: {
                botToken: "",
                appToken: "",
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(configured).toBe(false);
  });
});
