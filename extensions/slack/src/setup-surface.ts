// Slack plugin module implements setup surface behavior.
import {
  noteChannelLookupFailure,
  noteChannelLookupSummary,
  patchChannelConfigForAccount,
  resolveEntriesWithOptionalToken,
  resolveSetupAccountId,
  createSetupTranslator,
  type OpenClawConfig,
  parseMentionOrPrefixedId,
  promptResolvedAllowFrom,
  splitSetupEntries,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";
import type {
  ChannelSetupWizard,
  ChannelSetupWizardAllowFromEntry,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { inspectSlackAccount, type InspectedSlackAccount } from "./account-inspect.js";
import { resolveDefaultSlackAccountId, resolveSlackAccountAllowFrom } from "./accounts.js";
import { resolveSlackChannelAllowlist } from "./resolve-channels.js";
import { resolveSlackUserAllowlist } from "./resolve-users.js";
import { createSlackSetupWizardBase } from "./setup-core.js";
import { SLACK_CHANNEL as channel } from "./shared.js";

const t = createSetupTranslator();

type SlackSetupCredentialValues = { botToken?: string; userToken?: string };

function resolveSlackSetupAuth(
  account: InspectedSlackAccount,
  credentialValues: SlackSetupCredentialValues,
): string | undefined {
  if (account.config.postAs === "user") {
    return credentialValues.userToken || account.userToken;
  }
  return credentialValues.botToken || account.botToken;
}

async function resolveSlackAllowFromEntries(params: {
  token?: string;
  entries: string[];
}): Promise<ChannelSetupWizardAllowFromEntry[]> {
  return await resolveEntriesWithOptionalToken({
    token: params.token,
    entries: params.entries,
    buildWithoutToken: (input) => ({
      input,
      resolved: false,
      id: null,
    }),
    resolveEntries: async ({ token, entries }) =>
      (
        await resolveSlackUserAllowlist({
          token,
          entries,
        })
      ).map((entry) => ({
        input: entry.input,
        resolved: entry.resolved,
        id: entry.id ?? null,
      })),
  });
}

async function promptSlackAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const parseId = (value: string) =>
    parseMentionOrPrefixedId({
      value,
      mentionPattern: /^<@([A-Z0-9]+)>$/i,
      prefixPattern: /^(slack:|user:)/i,
      idPattern: /^[A-Z][A-Z0-9]+$/i,
      normalizeId: (id) => id.toUpperCase(),
    });

  const accountId = resolveSetupAccountId({
    accountId: params.accountId,
    defaultAccountId: resolveDefaultSlackAccountId(params.cfg),
  });
  const account = inspectSlackAccount({ cfg: params.cfg, accountId });
  const noteTitle = t("wizard.slack.allowlistTitle");
  await params.prompter.note(
    [
      t("wizard.slack.allowlistIntro"),
      t("wizard.slack.examples"),
      "- U12345678",
      "- @alice",
      t("wizard.slack.multipleEntries"),
      t("wizard.channels.docs", { link: formatDocsLink("/slack", "slack") }),
    ].join("\n"),
    noteTitle,
  );
  const allowFrom = await promptResolvedAllowFrom({
    prompter: params.prompter,
    existing: resolveSlackAccountAllowFrom({ cfg: params.cfg, accountId }) ?? [],
    token: account.userToken ?? account.botToken ?? "",
    message: t("wizard.slack.allowFromPrompt"),
    placeholder: "@alice, U12345678",
    label: noteTitle,
    parseInputs: splitSetupEntries,
    parseId,
    invalidWithoutTokenNote: t("wizard.slack.allowFromInvalidWithoutToken"),
    resolveEntries: async ({ token, entries }) =>
      (
        await resolveSlackUserAllowlist({
          token,
          entries,
        })
      ).map((entry) => ({
        input: entry.input,
        resolved: entry.resolved,
        id: entry.id ?? null,
      })),
  });
  return patchChannelConfigForAccount({
    cfg: params.cfg,
    channel,
    accountId: account.accountId,
    patch: {
      allowFrom,
      dm: {
        ...account.config.dm,
        enabled: typeof account.config.dm?.enabled === "boolean" ? account.config.dm.enabled : true,
      },
    },
  });
}

async function resolveSlackGroupAllowlist(params: {
  cfg: OpenClawConfig;
  accountId: string;
  credentialValues: SlackSetupCredentialValues;
  entries: string[];
  prompter: { note: (message: string, title?: string) => Promise<void> };
}) {
  let keys = params.entries;
  const accountWithTokens = inspectSlackAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const auth = resolveSlackSetupAuth(accountWithTokens, params.credentialValues) || "";
  if (params.entries.length > 0) {
    try {
      const resolved = await resolveEntriesWithOptionalToken<{
        input: string;
        resolved: boolean;
        id?: string;
      }>({
        token: auth,
        entries: params.entries,
        buildWithoutToken: (input) => ({ input, resolved: false, id: undefined }),
        resolveEntries: async ({ token, entries }) =>
          await resolveSlackChannelAllowlist({
            token,
            entries,
          }),
      });
      const resolvedKeys = resolved
        .filter((entry) => entry.resolved && entry.id)
        .map((entry) => entry.id as string);
      const unresolved = resolved.filter((entry) => !entry.resolved).map((entry) => entry.input);
      keys = [...resolvedKeys, ...normalizeStringEntries(unresolved)];
      await noteChannelLookupSummary({
        prompter: params.prompter,
        label: t("wizard.slack.channelsLabel"),
        resolvedSections: [{ title: t("wizard.channels.resolvedTitle"), values: resolvedKeys }],
        unresolved,
      });
    } catch (error) {
      await noteChannelLookupFailure({
        prompter: params.prompter,
        label: t("wizard.slack.channelsLabel"),
        error,
      });
    }
  }
  return keys;
}

export const slackSetupWizard: ChannelSetupWizard = createSlackSetupWizardBase({
  promptAllowFrom: promptSlackAllowFrom,
  resolveAllowFromEntries: async ({ cfg, accountId, credentialValues, entries }) => {
    const auth = resolveSlackSetupAuth(inspectSlackAccount({ cfg, accountId }), credentialValues);
    return await resolveSlackAllowFromEntries({ token: auth, entries });
  },
  resolveGroupAllowlist: async ({ cfg, accountId, credentialValues, entries, prompter }) =>
    await resolveSlackGroupAllowlist({
      cfg,
      accountId,
      credentialValues,
      entries,
      prompter,
    }),
});
