// Validates secret input schema fragments shared by config sections.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { z } from "zod";
import { hasConfiguredSecretInput } from "./types.secrets.js";

type TelegramAccountLike = {
  enabled?: unknown;
  webhookUrl?: unknown;
  webhookSecret?: unknown;
};

type TelegramConfigLike = {
  webhookUrl?: unknown;
  webhookSecret?: unknown;
  accounts?: Record<string, TelegramAccountLike | undefined>;
};

type SlackAccountLike = {
  enabled?: unknown;
  mode?: unknown;
  signingSecret?: unknown;
};

type SlackConfigLike = {
  mode?: unknown;
  signingSecret?: unknown;
  accounts?: Record<string, SlackAccountLike | undefined>;
};

// Only enabled accounts need per-account secret requirement checks.
function forEachEnabledAccount<T extends { enabled?: unknown }>(
  accounts: Record<string, T | undefined> | undefined,
  run: (accountId: string, account: T) => void,
): void {
  if (!accounts) {
    return;
  }
  for (const [accountId, account] of Object.entries(accounts)) {
    if (!account || account.enabled === false) {
      continue;
    }
    run(accountId, account);
  }
}

/** Validates Telegram webhook URLs have a usable shared or account webhook secret. */
export function validateTelegramWebhookSecretRequirements(
  value: TelegramConfigLike,
  ctx: z.RefinementCtx,
): void {
  const baseWebhookUrl = normalizeOptionalString(value.webhookUrl) ?? "";
  const hasBaseWebhookSecret = hasConfiguredSecretInput(value.webhookSecret);
  if (baseWebhookUrl && !hasBaseWebhookSecret) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "channels.telegram.webhookUrl requires channels.telegram.webhookSecret",
      path: ["webhookSecret"],
    });
  }
  forEachEnabledAccount(value.accounts, (accountId, account) => {
    const accountWebhookUrl = normalizeOptionalString(account.webhookUrl) ?? "";
    if (!accountWebhookUrl) {
      return;
    }
    const hasAccountSecret = hasConfiguredSecretInput(account.webhookSecret);
    if (!hasAccountSecret && !hasBaseWebhookSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "channels.telegram.accounts.*.webhookUrl requires channels.telegram.webhookSecret or channels.telegram.accounts.*.webhookSecret",
        path: ["accounts", accountId, "webhookSecret"],
      });
    }
  });
}

export function validateSlackSigningSecretRequirements(
  value: SlackConfigLike,
  ctx: z.RefinementCtx,
): void {
  const baseMode = value.mode === "http" || value.mode === "socket" ? value.mode : "socket";
  if (baseMode === "http" && !hasConfiguredSecretInput(value.signingSecret)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'channels.slack.mode="http" requires channels.slack.signingSecret',
      path: ["signingSecret"],
    });
  }
  forEachEnabledAccount(value.accounts, (accountId, account) => {
    const accountMode =
      account.mode === "http" || account.mode === "socket" ? account.mode : baseMode;
    if (accountMode !== "http") {
      return;
    }
    const accountSecret = account.signingSecret ?? value.signingSecret;
    if (!hasConfiguredSecretInput(accountSecret)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'channels.slack.accounts.*.mode="http" requires channels.slack.signingSecret or channels.slack.accounts.*.signingSecret',
        path: ["accounts", accountId, "signingSecret"],
      });
    }
  });
}
