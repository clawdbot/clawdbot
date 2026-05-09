import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { fetchWithSsrFGuard } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { resolveNextcloudTalkApiCredentials } from "./api-credentials.js";
import { ssrfPolicyFromPrivateNetworkOptIn } from "./send.runtime.js";

const BOT_FEATURE_RESPONSE = 2;

type NextcloudTalkBotAdminEntry = {
  id?: number | string;
  name?: string;
  url?: string;
  features?: number | string;
};

export type NextcloudTalkBotResponseFeatureProbe = {
  ok: boolean;
  skipped?: boolean;
  code:
    | "ok"
    | "missing_api_credentials"
    | "missing_webhook_url"
    | "missing_base_url"
    | "bot_not_found"
    | "missing_response_feature"
    | "api_error"
    | "request_failed";
  message: string;
  botId?: string;
  botName?: string;
  features?: number;
  status?: number;
};

function normalizeUrlForMatch(value: string | undefined): string {
  if (!value?.trim()) {
    return "";
  }
  try {
    const url = new URL(value.trim());
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return value.trim().replace(/\/$/, "");
  }
}

function coerceFeatureMask(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function formatMissingResponseFeatureMessage(bot: NextcloudTalkBotAdminEntry, features?: number) {
  const id = bot.id == null ? "unknown" : String(bot.id);
  const name = bot.name?.trim() || "matching bot";
  const featureText = typeof features === "number" ? ` (features=${features})` : "";
  return `Nextcloud Talk bot "${name}" (${id}) is missing the response feature${featureText}; outbound replies will fail. Run ./occ talk:bot:state --feature webhook --feature response --feature reaction ${id} 1 or reinstall the bot with --feature response.`;
}

export async function probeNextcloudTalkBotResponseFeature(params: {
  account: ResolvedNextcloudTalkAccount;
  timeoutMs?: number;
}): Promise<NextcloudTalkBotResponseFeatureProbe> {
  const { account, timeoutMs } = params;
  const baseUrl = account.baseUrl?.trim();
  if (!baseUrl) {
    return {
      ok: true,
      skipped: true,
      code: "missing_base_url",
      message: "Nextcloud Talk bot response feature probe skipped: baseUrl is not configured.",
    };
  }

  const webhookUrl = normalizeUrlForMatch(account.config.webhookPublicUrl);
  if (!webhookUrl) {
    return {
      ok: true,
      skipped: true,
      code: "missing_webhook_url",
      message:
        "Nextcloud Talk bot response feature probe skipped: webhookPublicUrl is not configured.",
    };
  }

  const credentials = resolveNextcloudTalkApiCredentials({
    apiUser: account.config.apiUser,
    apiPassword: account.config.apiPassword,
    apiPasswordFile: account.config.apiPasswordFile,
  });
  if (!credentials) {
    return {
      ok: true,
      skipped: true,
      code: "missing_api_credentials",
      message:
        "Nextcloud Talk bot response feature probe skipped: apiUser/apiPassword are not configured.",
    };
  }

  const url = `${baseUrl}/ocs/v2.php/apps/spreed/api/v1/bot/admin`;
  const auth = Buffer.from(`${credentials.apiUser}:${credentials.apiPassword}`, "utf-8").toString(
    "base64",
  );

  try {
    const { response, release } = await fetchWithSsrFGuard({
      url,
      init: {
        method: "GET",
        headers: {
          Authorization: `Basic ${auth}`,
          "OCS-APIRequest": "true",
          Accept: "application/json",
        },
      },
      auditContext: "nextcloud-talk.bot-response-preflight",
      policy: ssrfPolicyFromPrivateNetworkOptIn(account.config),
      timeoutMs,
    });
    try {
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        return {
          ok: false,
          code: "api_error",
          status: response.status,
          message: `Nextcloud Talk bot response feature probe failed (${response.status})${body ? `: ${body}` : ""}`,
        };
      }

      const payload = (await response.json()) as {
        ocs?: { data?: NextcloudTalkBotAdminEntry[] };
      };
      const bots = Array.isArray(payload.ocs?.data) ? payload.ocs.data : [];
      const bot = bots.find((entry) => normalizeUrlForMatch(entry.url) === webhookUrl);
      if (!bot) {
        return {
          ok: false,
          code: "bot_not_found",
          message: `Nextcloud Talk bot response feature probe could not find a bot with webhook URL ${webhookUrl}.`,
        };
      }

      const features = coerceFeatureMask(bot.features);
      if (features == null || (features & BOT_FEATURE_RESPONSE) !== BOT_FEATURE_RESPONSE) {
        return {
          ok: false,
          code: "missing_response_feature",
          botId: bot.id == null ? undefined : String(bot.id),
          botName: bot.name,
          features,
          message: formatMissingResponseFeatureMessage(bot, features),
        };
      }

      return {
        ok: true,
        code: "ok",
        botId: bot.id == null ? undefined : String(bot.id),
        botName: bot.name,
        features,
        message: `Nextcloud Talk bot "${bot.name ?? bot.id ?? "matching bot"}" has the response feature.`,
      };
    } finally {
      await release();
    }
  } catch (error) {
    return {
      ok: false,
      code: "request_failed",
      message: `Nextcloud Talk bot response feature probe failed: ${formatErrorMessage(error)}`,
    };
  }
}
