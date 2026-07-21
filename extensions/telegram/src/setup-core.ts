// Telegram plugin module implements setup core behavior.
import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/setup-runtime";
import {
  createEnvPatchedAccountSetupAdapter,
  patchChannelConfigForAccount,
  promptResolvedAllowFrom,
  splitSetupEntries,
  createSetupTranslator,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { resolveDefaultTelegramAccountId, resolveTelegramAccount } from "./accounts.js";
import { isNumericTelegramSenderUserId } from "./allow-from.js";
import { namedAccountPromotionKeys, singleAccountKeysToMove } from "./setup-contract.js";

const t = createSetupTranslator();

const channel = "telegram" as const;

export function getTelegramTokenHelpLines(): string[] {
  return [
    t("wizard.telegram.tokenHelpOpenBotFather"),
    t("wizard.telegram.tokenHelpNewBot"),
    t("wizard.telegram.tokenHelpCopyToken"),
    // Telegram's documented BotFather Mini App deep link (core.telegram.org/bots/features);
    // web-based alternative to the /newbot chat flow, also works on web.telegram.org.
    t("wizard.telegram.tokenHelpWebApp", { url: "https://t.me/BotFather?startapp" }),
    t("wizard.telegram.tokenEnvTip"),
    t("wizard.channels.docs", { link: formatDocsLink("/telegram") }),
    t("wizard.telegram.website", { url: "https://openclaw.ai" }),
  ];
}

export function getTelegramUserIdHelpLines(): string[] {
  return [
    t("wizard.telegram.userIdHelpLogs", {
      command: formatCliCommand("openclaw logs --follow"),
    }),
    t("wizard.telegram.userIdHelpGetUpdates"),
    t("wizard.telegram.userIdHelpThirdParty"),
    t("wizard.channels.docs", { link: formatDocsLink("/telegram") }),
    t("wizard.telegram.website", { url: "https://openclaw.ai" }),
  ];
}

function normalizeTelegramAllowFromInput(raw: string): string {
  return raw
    .trim()
    .replace(/^(telegram|tg):/i, "")
    .trim();
}

export function parseTelegramAllowFromId(raw: string): string | null {
  const stripped = normalizeTelegramAllowFromInput(raw);
  return isNumericTelegramSenderUserId(stripped) ? stripped : null;
}

export async function promptTelegramAllowFromForAccount(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}) {
  const accountId = params.accountId ?? resolveDefaultTelegramAccountId(params.cfg);
  const resolved = resolveTelegramAccount({ cfg: params.cfg, accountId });
  await params.prompter.note(
    getTelegramUserIdHelpLines().join("\n"),
    t("wizard.telegram.userIdTitle"),
  );
  const unique = await promptResolvedAllowFrom({
    prompter: params.prompter,
    existing: resolved.config.allowFrom ?? [],
    message: t("wizard.telegram.allowFromPrompt"),
    placeholder: "123456789",
    label: t("wizard.telegram.allowlistTitle"),
    parseInputs: splitSetupEntries,
    parseId: parseTelegramAllowFromId,
    invalidWithoutTokenNote: t("wizard.telegram.allowFromInvalid"),
    resolveEntries: async ({ entries }) =>
      entries.map((entry) => {
        const id = parseTelegramAllowFromId(entry);
        return { input: entry, resolved: Boolean(id), id };
      }),
  });
  return patchChannelConfigForAccount({
    cfg: params.cfg,
    channel,
    accountId,
    patch: { dmPolicy: "allowlist", allowFrom: unique },
    setupSurface: telegramSetupAdapter,
  });
}

export const telegramSetupAdapter: ChannelSetupAdapter = {
  ...createEnvPatchedAccountSetupAdapter({
    channelKey: channel,
    defaultAccountOnlyEnvError: "TELEGRAM_BOT_TOKEN can only be used for the default account.",
    missingCredentialError: "Telegram requires token or --token-file (or --use-env).",
    hasCredentials: (input) => Boolean(input.token || input.tokenFile),
    buildPatch: (input) =>
      input.tokenFile
        ? { tokenFile: input.tokenFile }
        : input.token
          ? { botToken: input.token }
          : {},
  }),
  singleAccountKeysToMove,
  namedAccountPromotionKeys,
};
