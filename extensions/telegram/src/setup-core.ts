import type { ChannelSetupAdapter } from "openclaw/plugin-sdk/setup-runtime";
import {
  createEnvPatchedAccountSetupAdapter,
  patchChannelConfigForAccount,
  promptResolvedAllowFrom,
  splitSetupEntries,
  type OpenClawConfig,
  type WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";
import { formatCliCommand, formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { resolveDefaultTelegramAccountId, resolveTelegramAccount } from "./accounts.js";
import { isNumericTelegramSenderUserId } from "./allow-from.js";

const channel = "telegram" as const;

export const TELEGRAM_TOKEN_HELP_LINES = [
  "1) Open Telegram and chat with @BotFather",
  "2) Run /newbot (or /mybots)",
  "3) Copy the token (looks like 123456:ABC...)",
  "Tip: you can also set TELEGRAM_BOT_TOKEN in your env.",
  `Docs: ${formatDocsLink("/telegram")}`,
  "Website: https://openclaw.ai",
];

export const TELEGRAM_USER_ID_HELP_LINES = [
  `1) DM your bot, then read from.id in \`${formatCliCommand("openclaw logs --follow")}\` (safest)`,
  "2) Or call https://api.telegram.org/bot<bot_token>/getUpdates and read message.from.id",
  "3) Third-party: DM @userinfobot or @getidsbot",
  `Docs: ${formatDocsLink("/telegram")}`,
  "Website: https://openclaw.ai",
];

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
  await params.prompter.note(TELEGRAM_USER_ID_HELP_LINES.join("\n"), "Telegram user id");
  const unique = await promptResolvedAllowFrom({
    prompter: params.prompter,
    existing: resolved.config.allowFrom ?? [],
    message: "Telegram allowFrom (numeric sender id)",
    placeholder: "123456789",
    label: "Telegram allowlist",
    parseInputs: splitSetupEntries,
    parseId: parseTelegramAllowFromId,
    invalidWithoutTokenNote:
      "Telegram allowFrom requires numeric sender ids. DM your bot first, then copy from.id from logs or getUpdates.",
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
  });
}

export const telegramSetupAdapter: ChannelSetupAdapter = createEnvPatchedAccountSetupAdapter({
  channelKey: channel,
  defaultAccountOnlyEnvError: "TELEGRAM_BOT_TOKEN can only be used for the default account.",
  missingCredentialError: "Telegram requires token or --token-file (or --use-env).",
  hasCredentials: (input) => Boolean(input.token || input.tokenFile),
  buildPatch: (input) =>
    input.tokenFile ? { tokenFile: input.tokenFile } : input.token ? { botToken: input.token } : {},
});
