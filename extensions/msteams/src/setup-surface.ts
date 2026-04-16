import { spawn } from "node:child_process";
import {
  createTopLevelChannelAllowFromSetter,
  createTopLevelChannelDmPolicy,
  createTopLevelChannelGroupPolicySetter,
  mergeAllowFromEntries,
  splitSetupEntries,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import type { MSTeamsTeamConfig } from "../runtime-api.js";
import { formatUnknownError } from "./errors.js";
import {
  parseMSTeamsTeamEntry,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";
import { createMSTeamsSetupWizardBase, msteamsSetupAdapter } from "./setup-core.js";
import { resolveMSTeamsCredentials } from "./token.js";

const channel = "msteams" as const;
const setMSTeamsAllowFrom = createTopLevelChannelAllowFromSetter({
  channel,
});
const setMSTeamsGroupPolicy = createTopLevelChannelGroupPolicySetter({
  channel,
  enabled: true,
});

export function openDelegatedOAuthUrl(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cmd = process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(cmd, [url], { stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      reject(new Error(`${cmd} failed with ${reason}`));
    });
  });
}

function looksLikeGuid(value: string): boolean {
  return /^[0-9a-fA-F-]{16,}$/.test(value);
}

async function promptMSTeamsAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
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
      initialValue: existing[0] ? existing[0] : undefined,
      validate: (value) => (value.trim() ? undefined : "Required"),
    });
    const parts = splitSetupEntries(entry);
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
      const unique = mergeAllowFromEntries(existing, ids);
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
    const unique = mergeAllowFromEntries(existing, ids);
    return setMSTeamsAllowFrom(params.cfg, unique);
  }
}

function setMSTeamsTeamsAllowlist(
  cfg: OpenClawConfig,
  entries: Array<{ teamKey: string; channelKey?: string }>,
): OpenClawConfig {
  const baseTeams = cfg.channels?.msteams?.teams ?? {};
  const teams: Record<string, { channels?: Record<string, unknown> }> = { ...baseTeams };
  for (const entry of entries) {
    const teamKey = entry.teamKey;
    if (!teamKey) {
      continue;
    }
    const existing = teams[teamKey] ?? {};
    if (entry.channelKey) {
      const channels = { ...existing.channels };
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
        teams: teams as Record<string, MSTeamsTeamConfig>,
      },
    },
  };
}

function listMSTeamsGroupEntries(cfg: OpenClawConfig): string[] {
  return Object.entries(cfg.channels?.msteams?.teams ?? {}).flatMap(([teamKey, value]) => {
    const channels = value?.channels ?? {};
    const channelKeys = Object.keys(channels);
    if (channelKeys.length === 0) {
      return [teamKey];
    }
    return channelKeys.map((channelKey) => `${teamKey}/${channelKey}`);
  });
}

async function resolveMSTeamsGroupAllowlist(params: {
  cfg: OpenClawConfig;
  entries: string[];
  prompter: Pick<WizardPrompter, "note">;
}): Promise<Array<{ teamKey: string; channelKey?: string }>> {
  let resolvedEntries = params.entries
    .map((entry) => parseMSTeamsTeamEntry(entry))
    .filter(Boolean) as Array<{ teamKey: string; channelKey?: string }>;
  if (params.entries.length === 0 || !resolveMSTeamsCredentials(params.cfg.channels?.msteams)) {
    return resolvedEntries;
  }
  try {
    const lookups = await resolveMSTeamsChannelAllowlist({
      cfg: params.cfg,
      entries: params.entries,
    });
    const resolvedChannels = lookups.filter(
      (entry) => entry.resolved && entry.teamId && entry.channelId,
    );
    const resolvedTeams = lookups.filter(
      (entry) => entry.resolved && entry.teamId && !entry.channelId,
    );
    const unresolved = lookups.filter((entry) => !entry.resolved).map((entry) => entry.input);
    resolvedEntries = [
      ...resolvedChannels.map((entry) => ({
        teamKey: entry.teamId as string,
        channelKey: entry.channelId as string,
      })),
      ...resolvedTeams.map((entry) => ({
        teamKey: entry.teamId as string,
      })),
      ...unresolved.map((entry) => parseMSTeamsTeamEntry(entry)).filter(Boolean),
    ] as Array<{ teamKey: string; channelKey?: string }>;
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
    if (summary.length > 0) {
      await params.prompter.note(summary.join("\n"), "MS Teams channels");
    }
    return resolvedEntries;
  } catch (err) {
    await params.prompter.note(
      `Channel lookup failed; keeping entries as typed. ${formatUnknownError(err)}`,
      "MS Teams channels",
    );
    return resolvedEntries;
  }
}

const msteamsGroupAccess: NonNullable<ChannelSetupWizard["groupAccess"]> = {
  label: "MS Teams channels",
  placeholder: "Team Name/Channel Name, teamId/conversationId",
  currentPolicy: ({ cfg }) => cfg.channels?.msteams?.groupPolicy ?? "allowlist",
  currentEntries: ({ cfg }) => listMSTeamsGroupEntries(cfg),
  updatePrompt: ({ cfg }) => Boolean(cfg.channels?.msteams?.teams),
  setPolicy: ({ cfg, policy }) => setMSTeamsGroupPolicy(cfg, policy),
  resolveAllowlist: async ({ cfg, entries, prompter }) =>
    await resolveMSTeamsGroupAllowlist({ cfg, entries, prompter }),
  applyAllowlist: ({ cfg, resolved }) =>
    setMSTeamsTeamsAllowlist(cfg, resolved as Array<{ teamKey: string; channelKey?: string }>),
};

const msteamsDmPolicy: ChannelSetupDmPolicy = createTopLevelChannelDmPolicy({
  label: "MS Teams",
  channel,
  policyKey: "channels.msteams.dmPolicy",
  allowFromKey: "channels.msteams.allowFrom",
  getCurrent: (cfg) => cfg.channels?.msteams?.dmPolicy ?? "pairing",
  promptAllowFrom: promptMSTeamsAllowFrom,
});

export { msteamsSetupAdapter } from "./setup-core.js";

const msteamsSetupWizardBase = createMSTeamsSetupWizardBase();

export const msteamsSetupWizard: ChannelSetupWizard = {
  ...msteamsSetupWizardBase,
  // Override finalize to layer on the optional delegated-auth bootstrap after
  // the base wizard collects app credentials. This preserves main's shared
  // setup-core flow while keeping the delegated OAuth step from this PR.
  finalize: async (params) => {
    // setup-core always provides a finalize; the type is optional only because
    // ChannelSetupWizard.finalize is generally optional. Fall back to the
    // incoming cfg if the base ever returns void for forward-compat.
    const baseFinalize = msteamsSetupWizardBase.finalize;
    const baseResult = baseFinalize ? await baseFinalize(params) : undefined;
    let next = baseResult?.cfg ?? params.cfg;
    const finalCreds = resolveMSTeamsCredentials(next.channels?.msteams);
    if (finalCreds?.type === "secret") {
      const enableDelegated = await params.prompter.confirm({
        message: "Enable delegated auth? (required for reactions and write operations)",
        initialValue: false,
      });
      if (enableDelegated) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            msteams: {
              ...next.channels?.msteams,
              delegatedAuth: { enabled: true },
            },
          },
        };
        try {
          const { loginMSTeamsDelegated } = await import("./oauth.js");
          const { saveDelegatedTokens } = await import("./token.js");
          const { shouldUseManualOAuthFlow } = await import("./oauth.flow.js");
          const isRemote = Boolean(process.env.SSH_TTY || process.env.SSH_CONNECTION);
          const progress = params.prompter.progress("MSTeams Delegated OAuth");
          const tokens = await loginMSTeamsDelegated(
            {
              isRemote: shouldUseManualOAuthFlow(isRemote),
              openUrl: openDelegatedOAuthUrl,
              log: (msg) => params.prompter.note(msg),
              note: (msg, title) => params.prompter.note(msg, title),
              prompt: (msg) => params.prompter.text({ message: msg }),
              progress,
            },
            {
              tenantId: finalCreds.tenantId,
              clientId: finalCreds.appId,
              clientSecret: finalCreds.appPassword,
            },
          );
          saveDelegatedTokens(tokens);
          progress.stop("Delegated auth configured");
        } catch (err) {
          await params.prompter.note(
            `Delegated auth setup failed: ${formatUnknownError(err)}\n` +
              "You can retry later via the setup wizard.",
            "MS Teams delegated auth",
          );
        }
      }
    }
    return { ...baseResult, cfg: next };
  },
  dmPolicy: msteamsDmPolicy,
  groupAccess: msteamsGroupAccess,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams: { ...cfg.channels?.msteams, enabled: false },
    },
  }),
};
