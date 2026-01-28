import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  MoltbotConfig,
  DmPolicy,
  WizardPrompter,
} from "clawdbot/plugin-sdk";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  promptChannelAccessConfig,
} from "clawdbot/plugin-sdk";

import { resolveMSTeamsCredentials } from "./token.js";
import {
  parseMSTeamsTeamEntry,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";

const channel = "msteams" as const;

function setMSTeamsDmPolicy(cfg: MoltbotConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(cfg.channels?.msteams?.allowFrom)?.map((entry) => String(entry))
      : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: {
        ...cfg.channels?.msteams,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

function setMSTeamsAllowFrom(cfg: MoltbotConfig, allowFrom: string[]): MoltbotConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: {
        ...cfg.channels?.msteams,
        allowFrom,
      },
    },
  };
}

function parseAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function looksLikeGuid(value: string): boolean {
  return /^[0-9a-fA-F-]{16,}$/.test(value);
}

async function promptMSTeamsAllowFrom(params: {
  cfg: MoltbotConfig;
  prompter: WizardPrompter;
}): Promise<MoltbotConfig> {
  const existing = params.cfg.channels?.msteams?.allowFrom ?? [];
  await params.prompter.note(
    [
      "Allowlist MS Teams DMs by display name, UPN/email, or user id.",
      "We resolve names to user IDs via Microsoft Graph when credentials allow.",
      "Examples:",
      "- alex@example.com",
      "- Alex Johnson",
      "- 00000000-0000-0000-0000-000000000000",
    ].join("\n"),
    "MS Teams allowlist",
  );

  while (true) {
    const entry = await params.prompter.text({
      message: "MS Teams allowFrom (usernames or ids)",
      placeholder: "alex@example.com, Alex Johnson",
      initialValue: existing[0] ? String(existing[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = parseAllowFromInput(String(entry));
    if (parts.length === 0) {
      await params.prompter.note("Enter at least one user.", "MS Teams allowlist");
      continue;
    }

    const resolved = await resolveMSTeamsUserAllowlist({
      cfg: params.cfg,
      entries: parts,
    }).catch(() => null);

    if (!resolved) {
      const ids = parts.filter((part) => looksLikeGuid(part));
      if (ids.length !== parts.length) {
        await params.prompter.note(
          "Graph lookup unavailable. Use user IDs only.",
          "MS Teams allowlist",
        );
        continue;
      }
      const unique = [
        ...new Set([...existing.map((v) => String(v).trim()).filter(Boolean), ...ids]),
      ];
      return setMSTeamsAllowFrom(params.cfg, unique);
    }

    const unresolved = resolved.filter((item) => !item.resolved || !item.id);
    if (unresolved.length > 0) {
      await params.prompter.note(
        `Could not resolve: ${unresolved.map((item) => item.input).join(", ")}`,
        "MS Teams allowlist",
      );
      continue;
    }

    const ids = resolved.map((item) => item.id as string);
    const unique = [
      ...new Set([...existing.map((v) => String(v).trim()).filter(Boolean), ...ids]),
    ];
    return setMSTeamsAllowFrom(params.cfg, unique);
  }
}

async function noteMSTeamsCredentialHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Azure Bot registration → get App ID + Tenant ID",
      "2) Add a client secret (App Password)",
      "3) Set webhook URL + messaging endpoint",
      "Tip: you can also set MSTEAMS_APP_ID / MSTEAMS_APP_PASSWORD / MSTEAMS_TENANT_ID.",
      `Docs: ${formatDocsLink("/channels/msteams", "msteams")}`,
    ].join("\n"),
    "MS Teams credentials",
  );
}

function setMSTeamsGroupPolicy(
  cfg: MoltbotConfig,
  groupPolicy: "open" | "allowlist" | "disabled",
): MoltbotConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: {
        ...cfg.channels?.msteams,
        enabled: true,
        groupPolicy,
      },
    },
  };
}

function setMSTeamsTeamsAllowlist(
  cfg: MoltbotConfig,
  entries: Array<{ teamKey: string; channelKey?: string }>,
): MoltbotConfig {
  const baseTeams = cfg.channels?.msteams?.teams ?? {};
  const teams: Record<string, { channels?: Record<string, unknown> }> = { ...baseTeams };
  for (const entry of entries) {
    const teamKey = entry.teamKey;
    if (!teamKey) continue;
    const existing = teams[teamKey] ?? {};
    if (entry.channelKey) {
      const channels = { ...(existing.channels ?? {}) };
      channels[entry.channelKey] = channels[entry.channelKey] ?? {};
      teams[teamKey] = { ...existing, channels };
    } else {
      teams[teamKey] = existing;
    }
  }
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: {
        ...cfg.channels?.msteams,
        enabled: true,
        teams,
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "MS Teams",
  channel,
  policyKey: "channels.msteams.dmPolicy",
  allowFromKey: "channels.msteams.allowFrom",
  getCurrent: (cfg) => cfg.channels?.msteams?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setMSTeamsDmPolicy(cfg, policy),
  promptAllowFrom: promptMSTeamsAllowFrom,
};

export const msteamsOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams));
    return {
      channel,
      configured,
      statusLines: [`MS Teams: ${configured ? "configured" : "needs app credentials"}`],
      selectionHint: configured ? "configured" : "needs app creds",
      quickstartScore: configured ? 2 : 0,
    };
  },
  configure: async ({ cfg, prompter }) => {
    const resolved = resolveMSTeamsCredentials(cfg.channels?.msteams);
    const hasConfigCreds = Boolean(
      cfg.channels?.msteams?.appId?.trim() &&
      cfg.channels?.msteams?.appPassword?.trim() &&
      cfg.channels?.msteams?.tenantId?.trim(),
    );
    const canUseEnv = Boolean(
      !hasConfigCreds &&
      process.env.MSTEAMS_APP_ID?.trim() &&
      process.env.MSTEAMS_APP_PASSWORD?.trim() &&
      process.env.MSTEAMS_TENANT_ID?.trim(),
    );

    let next = cfg;
    let appId: string | null = null;
    let appPassword: string | null = null;
    let tenantId: string | null = null;

    if (!resolved) {
      await noteMSTeamsCredentialHelp(prompter);
    }

    if (canUseEnv) {
      const keepEnv = await prompter.confirm({
        message:
          "MSTEAMS_APP_ID + MSTEAMS_APP_PASSWORD + MSTEAMS_TENANT_ID detected. Use env vars?",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            msteams: { ...next.channels?.msteams, enabled: true },
          },
        };
      } else {
        appId = String(
          await prompter.text({
            message: "Enter MS Teams App ID",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        appPassword = String(
          await prompter.text({
            message: "Enter MS Teams App Password",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        tenantId = String(
          await prompter.text({
            message: "Enter MS Teams Tenant ID",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigCreds) {
      const keep = await prompter.confirm({
        message: "MS Teams credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        appId = String(
          await prompter.text({
            message: "Enter MS Teams App ID",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        appPassword = String(
          await prompter.text({
            message: "Enter MS Teams App Password",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        tenantId = String(
          await prompter.text({
            message: "Enter MS Teams Tenant ID",
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      appId = String(
        await prompter.text({
          message: "Enter MS Teams App ID",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      appPassword = String(
        await prompter.text({
          message: "Enter MS Teams App Password",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      tenantId = String(
        await prompter.text({
          message: "Enter MS Teams Tenant ID",
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (appId && appPassword && tenantId) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          msteams: {
            ...next.channels?.msteams,
            enabled: true,
            appId,
            appPassword,
            tenantId,
          },
        },
      };
    }

    const currentEntries = Object.entries(next.channels?.msteams?.teams ?? {}).flatMap(
      ([teamKey, value]) => {
        const channels = value?.channels ?? {};
        const channelKeys = Object.keys(channels);
        if (channelKeys.length === 0) return [teamKey];
        return channelKeys.map((channelKey) => `${teamKey}/${channelKey}`);
      },
    );
    const accessConfig = await promptChannelAccessConfig({
      prompter,
      label: "MS Teams channels",
      currentPolicy: next.channels?.msteams?.groupPolicy ?? "allowlist",
      currentEntries,
      placeholder: "Team Name/Channel Name, teamId/conversationId",
      updatePrompt: Boolean(next.channels?.msteams?.teams),
    });
    if (accessConfig) {
      if (accessConfig.policy !== "allowlist") {
        next = setMSTeamsGroupPolicy(next, accessConfig.policy);
      } else {
        let entries = accessConfig.entries
          .map((entry) => parseMSTeamsTeamEntry(entry))
          .filter(Boolean) as Array<{ teamKey: string; channelKey?: string }>;
        if (accessConfig.entries.length > 0 && resolveMSTeamsCredentials(next.channels?.msteams)) {
          try {
            const resolved = await resolveMSTeamsChannelAllowlist({
              cfg: next,
              entries: accessConfig.entries,
            });
            const resolvedChannels = resolved.filter(
              (entry) => entry.resolved && entry.teamId && entry.channelId,
            );
            const resolvedTeams = resolved.filter(
              (entry) => entry.resolved && entry.teamId && !entry.channelId,
            );
            const unresolved = resolved
              .filter((entry) => !entry.resolved)
              .map((entry) => entry.input);

            entries = [
              ...resolvedChannels.map((entry) => ({
                teamKey: entry.teamId as string,
                channelKey: entry.channelId as string,
              })),
              ...resolvedTeams.map((entry) => ({
                teamKey: entry.teamId as string,
              })),
              ...unresolved
                .map((entry) => parseMSTeamsTeamEntry(entry))
                .filter(Boolean),
            ] as Array<{ teamKey: string; channelKey?: string }>;

            if (resolvedChannels.length > 0 || resolvedTeams.length > 0 || unresolved.length > 0) {
              const summary: string[] = [];
              if (resolvedChannels.length > 0) {
                summary.push(
                  `Resolved channels: ${resolvedChannels
                    .map((entry) => entry.channelId)
                    .filter(Boolean)
                    .join(", ")}`,
                );
              }
              if (resolvedTeams.length > 0) {
                summary.push(
                  `Resolved teams: ${resolvedTeams
                    .map((entry) => entry.teamId)
                    .filter(Boolean)
                    .join(", ")}`,
                );
              }
              if (unresolved.length > 0) {
                summary.push(`Unresolved (kept as typed): ${unresolved.join(", ")}`);
              }
              await prompter.note(summary.join("\n"), "MS Teams channels");
            }
          } catch (err) {
            await prompter.note(
              `Channel lookup failed; keeping entries as typed. ${String(err)}`,
              "MS Teams channels",
            );
          }
        }
        next = setMSTeamsGroupPolicy(next, "allowlist");
        next = setMSTeamsTeamsAllowlist(next, entries);
      }
    }

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: { ...cfg.channels?.msteams, enabled: false },
    },
  }),
};
