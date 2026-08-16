// Msteams plugin module implements setup surface behavior.
import {
  mergeAllowFromEntries,
  patchChannelConfigForAccount,
  setSetupChannelEnabled,
  splitSetupEntries,
  createSetupTranslator,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup";
import { createAccountScopedGroupAccessSection } from "openclaw/plugin-sdk/setup-runtime";
import type { MSTeamsTeamConfig } from "../runtime-api.js";
import { resolveMSTeamsAccountConfig } from "./accounts.js";
import { formatUnknownError } from "./errors.js";
import {
  parseMSTeamsTeamEntry,
  resolveMSTeamsChannelAllowlist,
  resolveMSTeamsUserAllowlist,
} from "./resolve-allowlist.js";
import { createMSTeamsSetupWizardBase, patchMSTeamsAccountConfig } from "./setup-core.js";
import { resolveMSTeamsCredentials, saveDelegatedTokens } from "./token.js";

const t = createSetupTranslator();

const channel = "msteams" as const;

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
  accountId?: string;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const accountId = params.accountId ?? "default";
  const existing = resolveMSTeamsAccountConfig(params.cfg, accountId).allowFrom ?? [];
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
      cfg: withMSTeamsAccountConfig(params.cfg, accountId),
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
      return patchChannelConfigForAccount({
        cfg: params.cfg,
        channel,
        accountId,
        patch: { dmPolicy: "allowlist", allowFrom: unique },
      });
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

    const ids = resolved.flatMap((item) => (item.id ? [item.id] : []));
    const unique = mergeAllowFromEntries(existing, ids);
    return patchChannelConfigForAccount({
      cfg: params.cfg,
      channel,
      accountId,
      patch: { dmPolicy: "allowlist", allowFrom: unique },
    });
  }
}

function withMSTeamsAccountConfig(cfg: OpenClawConfig, accountId?: string | null): OpenClawConfig {
  const msteams = resolveMSTeamsAccountConfig(cfg, accountId);
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      msteams:
        accountId && accountId !== "default" ? { ...msteams, defaultAccount: accountId } : msteams,
    },
  };
}

function setMSTeamsTeamsAllowlist(
  cfg: OpenClawConfig,
  accountId: string,
  entries: Array<{ teamKey: string; channelKey?: string }>,
): OpenClawConfig {
  const baseTeams = resolveMSTeamsAccountConfig(cfg, accountId).teams ?? {};
  const teams: Record<string, MSTeamsTeamConfig> = { ...baseTeams };
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
  return patchMSTeamsAccountConfig({
    cfg,
    accountId,
    patch: { teams },
  });
}

function listMSTeamsGroupEntries(cfg: OpenClawConfig, accountId: string): string[] {
  return Object.entries(resolveMSTeamsAccountConfig(cfg, accountId).teams ?? {}).flatMap(
    ([teamKey, value]) => {
      const channels = value?.channels ?? {};
      const channelKeys = Object.keys(channels);
      if (channelKeys.length === 0) {
        return [teamKey];
      }
      return channelKeys.map((channelKey) => `${teamKey}/${channelKey}`);
    },
  );
}

async function resolveMSTeamsGroupAllowlist(params: {
  cfg: OpenClawConfig;
  accountId: string;
  entries: string[];
  prompter: Pick<WizardPrompter, "note">;
}): Promise<Array<{ teamKey: string; channelKey?: string }>> {
  let resolvedEntries = params.entries
    .map((entry) => parseMSTeamsTeamEntry(entry))
    .filter(Boolean) as Array<{ teamKey: string; channelKey?: string }>;
  if (
    params.entries.length === 0 ||
    !resolveMSTeamsCredentials(resolveMSTeamsAccountConfig(params.cfg, params.accountId), {
      allowEnvFallback: params.accountId === "default",
      pathPrefix:
        params.accountId === "default"
          ? "channels.msteams"
          : `channels.msteams.accounts.${params.accountId}`,
    })
  ) {
    return resolvedEntries;
  }
  try {
    const lookups = await resolveMSTeamsChannelAllowlist({
      cfg: withMSTeamsAccountConfig(params.cfg, params.accountId),
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

const msteamsGroupAccess: NonNullable<ChannelSetupWizard["groupAccess"]> =
  createAccountScopedGroupAccessSection({
    channel,
    label: t("wizard.msteams.channelsLabel"),
    placeholder: "Team Name/Channel Name, teamId/conversationId",
    currentPolicy: ({ cfg, accountId }) =>
      resolveMSTeamsAccountConfig(cfg, accountId).groupPolicy ?? "allowlist",
    currentEntries: ({ cfg, accountId }) => listMSTeamsGroupEntries(cfg, accountId),
    updatePrompt: ({ cfg, accountId }) =>
      Boolean(resolveMSTeamsAccountConfig(cfg, accountId).teams),
    resolveAllowlist: async ({ cfg, accountId, entries, prompter }) =>
      await resolveMSTeamsGroupAllowlist({ cfg, accountId, entries, prompter }),
    fallbackResolved: (entries) =>
      entries.map((entry) => parseMSTeamsTeamEntry(entry)).filter(Boolean) as Array<{
        teamKey: string;
        channelKey?: string;
      }>,
    applyAllowlist: ({ cfg, accountId, resolved }) =>
      setMSTeamsTeamsAllowlist(
        cfg,
        accountId,
        resolved as Array<{ teamKey: string; channelKey?: string }>,
      ),
  });

const msteamsDmPolicy: ChannelSetupDmPolicy = {
  label: "MS Teams",
  channel,
  policyKey: "channels.msteams.dmPolicy",
  allowFromKey: "channels.msteams.allowFrom",
  resolveConfigKeys: (_cfg, accountId) => {
    const base =
      accountId && accountId !== "default"
        ? `channels.msteams.accounts.${accountId}`
        : "channels.msteams";
    return { policyKey: `${base}.dmPolicy`, allowFromKey: `${base}.allowFrom` };
  },
  getCurrent: (cfg, accountId) => resolveMSTeamsAccountConfig(cfg, accountId).dmPolicy ?? "pairing",
  setPolicy: (cfg, policy, accountId = "default") =>
    patchMSTeamsAccountConfig({ cfg, accountId, patch: { dmPolicy: policy } }),
  promptAllowFrom: promptMSTeamsAllowFrom,
};

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
    const resolvedAccountId =
      baseResult && "accountId" in baseResult && typeof baseResult.accountId === "string"
        ? baseResult.accountId
        : params.accountId;
    const finalCreds = resolveMSTeamsCredentials(
      resolveMSTeamsAccountConfig(next, resolvedAccountId),
      {
        allowEnvFallback: resolvedAccountId === "default",
        pathPrefix:
          resolvedAccountId === "default"
            ? "channels.msteams"
            : `channels.msteams.accounts.${resolvedAccountId}`,
      },
    );
    if (finalCreds?.type === "secret") {
      const enableDelegated = await params.prompter.confirm({
        message: t("wizard.msteams.delegatedAuthPrompt"),
        initialValue: false,
      });
      if (enableDelegated) {
        next = patchMSTeamsAccountConfig({
          cfg: next,
          accountId: resolvedAccountId,
          patch: { delegatedAuth: { enabled: true } },
        });
        const noteDelegatedAuthFailure = async (err: unknown) => {
          await params.prompter.note(
            `Delegated auth setup failed: ${formatUnknownError(err)}\n` +
              t("wizard.msteams.delegatedAuthRetry"),
            t("wizard.msteams.delegatedAuthTitle"),
          );
        };
        let oauthModule: typeof import("./oauth.js");
        try {
          oauthModule = await import("./oauth.js");
        } catch (err) {
          await noteDelegatedAuthFailure(err);
          return { ...baseResult, cfg: next };
        }

        await params.options?.beforePersistentEffect?.();
        const progress = params.prompter.progress(t("wizard.msteams.delegatedOAuthProgress"));
        let tokens: Awaited<ReturnType<typeof oauthModule.loginMSTeamsDelegated>>;
        try {
          tokens = await oauthModule.loginMSTeamsDelegated(
            {
              isRemote: true,
              openUrl: openDelegatedOAuthUrl,
              log: (msg) => {
                void params.prompter.note(msg);
              },
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
        } catch (err) {
          progress.stop();
          await noteDelegatedAuthFailure(err);
          return { ...baseResult, cfg: next };
        }

        try {
          await params.options?.beforePersistentEffect?.();
        } catch (err) {
          progress.stop();
          throw err;
        }
        saveDelegatedTokens(tokens, { accountId: resolvedAccountId });
        progress.stop(t("wizard.msteams.delegatedAuthConfigured"));
      }
    }
    return { ...baseResult, cfg: next };
  },
  dmPolicy: msteamsDmPolicy,
  groupAccess: msteamsGroupAccess,
  disable: (cfg) => setSetupChannelEnabled(cfg, channel, false),
};
