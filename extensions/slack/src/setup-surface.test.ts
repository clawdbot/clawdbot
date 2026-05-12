import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createTestWizardPrompter,
  runSetupWizardPrepare,
  runSetupWizardFinalize,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { createSlackSetupWizardBase } from "./setup-core.js";
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
    expect(note).not.toHaveBeenCalled();
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

  it("does not print the manifest after Slack credentials are configured", async () => {
    const plain = vi.fn<NonNullable<WizardPrompter["plain"]>>(async () => {});

    await runSetupWizardPrepare({
      prepare: slackSetupWizard.prepare,
      cfg: baseCfg,
      prompter: createTestWizardPrompter({
        plain,
      }),
    });

    expect(plain).not.toHaveBeenCalled();
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
