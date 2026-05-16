import {
  createTopLevelChannelAllowFromSetter,
  createTopLevelChannelDmPolicy,
  createTopLevelChannelGroupPolicySetter,
  mergeAllowFromEntries,
  splitSetupEntries,
  createSetupTranslator,
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
import { createMSTeamsSetupWizardBase } from "./setup-core.js";
import { resolveMSTeamsCredentials, saveDelegatedTokens } from "./token.js";

const t = createSetupTranslator();

const channel = "msteams" as const;
const setMSTeamsAllowFrom = createTopLevelChannelAllowFromSetter({
  channel,
});
const setMSTeamsGroupPolicy = createTopLevelChannelGroupPolicySetter({
  channel,
  enabled: true,
});

export function openDelegatedOAuthUrl(url: string): Promise<void> {
  return Promise.reject(
    new Error(`Automatic browser launch is not available. Open this URL manually: ${url}`),
  );
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
      t("wizard.msteams.allowlistIntro"),
      t("wizard.msteams.allowlistResolve"),
      t("wizard.msteams.examples"),
      "- alex@example.com",
      "- Alex Johnson",
      "- 00000000-0000-0000-0000-000000000000",
    ].join("\n"),
    t("wizard.msteams.allowlistTitle"),
  );

  while (true) {
    const entry = await params.prompter.text({
      message: t("wizard.msteams.allowFromPrompt"),
      placeholder: "alex@example.com, Alex Johnson",
      initialValue: existing[0] ? existing[0] : undefined,
      validate: (value) => (value.trim() ? undefined : t("common.required")),
    });
    const parts = splitSetupEntries(entry);
    if (parts.length === 0) {
      await params.prompter.note(
        t("wizard.msteams.enterAtLeastOneUser"),
        t("wizard.msteams.allowlistTitle"),
      );
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
          t("wizard.msteams.graphLookupUnavailable"),
          t("wizard.msteams.allowlistTitle"),
        );
        continue;
      }
      const unique = mergeAllowFromEntries(existing, ids);
      return setMSTeamsAllowFrom(params.cfg, unique);
    }

    const unresolved = resolved.filter((item) => !item.resolved || !item.id);
    if (unresolved.length > 0) {
      await params.prompter.note(
        t("wizard.msteams.couldNotResolve", {
          entries: unresolved.map((item) => item.input).join(", "),
        }),
        t("wizard.msteams.allowlistTitle"),
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
        t("wizard.msteams.resolvedChannels", {
          entries: resolvedChannels
            .map((entry) => entry.channelId)
            .filter(Boolean)
            .join(", "),
        }),
      );
    }
    if (resolvedTeams.length > 0) {
      summary.push(
        t("wizard.msteams.resolvedTeams", {
          entries: resolvedTeams
            .map((entry) => entry.teamId)
            .filter(Boolean)
            .join(", "),
        }),
      );
    }
    if (unresolved.length > 0) {
      summary.push(t("wizard.msteams.unresolvedKept", { entries: unresolved.join(", ") }));
    }
    if (summary.length > 0) {
      await params.prompter.note(summary.join("\n"), t("wizard.msteams.channelsLabel"));
    }
    return resolvedEntries;
  } catch (err) {
    await params.prompter.note(
      t("wizard.msteams.channelLookupFailed", { error: formatUnknownError(err) }),
      t("wizard.msteams.channelsLabel"),
    );
    return resolvedEntries;
  }
}

const msteamsGroupAccess: NonNullable<ChannelSetupWizard["groupAccess"]> = {
  label: t("wizard.msteams.channelsLabel"),
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
        message: t("wizard.msteams.delegatedAuthPrompt"),
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
          const progress = params.prompter.progress(t("wizard.msteams.delegatedOAuthProgress"));
          const tokens = await loginMSTeamsDelegated(
            {
              isRemote: true,
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
          progress.stop(t("wizard.msteams.delegatedAuthConfigured"));
        } catch (err) {
          await params.prompter.note(
            `Delegated auth setup failed: ${formatUnknownError(err)}\n` +
              t("wizard.msteams.delegatedAuthRetry"),
            t("wizard.msteams.delegatedAuthTitle"),
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
