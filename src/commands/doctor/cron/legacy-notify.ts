// Legacy cron `notify: true` migration to explicit webhook/completion delivery.
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeHttpWebhookUrl } from "../../../cron/webhook-url.js";

export type LegacyNotifyMigrationOutcome = {
  changed: boolean;
  warnings: string[];
};

/** Migrate legacy notify fallback flags into explicit delivery destinations when possible. */
export function migrateLegacyNotifyFallback(params: {
  jobs: Array<Record<string, unknown>>;
  legacyWebhook?: string;
}): LegacyNotifyMigrationOutcome {
  let changed = false;
  const warnings: string[] = [];
  const configuredLegacyWebhook = normalizeOptionalString(params.legacyWebhook);
  const legacyWebhook = configuredLegacyWebhook
    ? normalizeHttpWebhookUrl(configuredLegacyWebhook)
    : undefined;

  const warnMissingLegacyWebhook = (jobName: string) => {
    warnings.push(
      configuredLegacyWebhook
        ? `Cron job "${jobName}" still uses legacy notify fallback, but cron.webhook is not a valid HTTP(S) URL so doctor cannot migrate it automatically.`
        : `Cron job "${jobName}" still uses legacy notify fallback, but cron.webhook is unset so doctor cannot migrate it automatically.`,
    );
  };

  for (const raw of params.jobs) {
    if (!("notify" in raw)) {
      continue;
    }

    const jobName =
      normalizeOptionalString(raw.name) ?? normalizeOptionalString(raw.id) ?? "<unnamed>";
    const notify = raw.notify === true;
    if (!notify) {
      delete raw.notify;
      changed = true;
      continue;
    }

    const delivery =
      raw.delivery && typeof raw.delivery === "object" && !Array.isArray(raw.delivery)
        ? (raw.delivery as Record<string, unknown>)
        : null;
    const mode = normalizeOptionalLowercaseString(delivery?.mode);
    const to = normalizeOptionalString(delivery?.to);
    const hasLegacyChatDelivery =
      mode === undefined &&
      delivery !== null &&
      (normalizeOptionalString(delivery.channel) !== undefined ||
        normalizeOptionalString(delivery.accountId) !== undefined ||
        "threadId" in delivery ||
        (to !== undefined && !normalizeHttpWebhookUrl(to)));
    const completionDestination =
      delivery?.completionDestination &&
      typeof delivery.completionDestination === "object" &&
      !Array.isArray(delivery.completionDestination)
        ? (delivery.completionDestination as Record<string, unknown>)
        : null;
    const completionMode = normalizeOptionalLowercaseString(completionDestination?.mode);
    const completionTo = normalizeOptionalString(completionDestination?.to);
    const validWebhookTo = to ? normalizeHttpWebhookUrl(to) : undefined;
    const validCompletionTo = completionTo ? normalizeHttpWebhookUrl(completionTo) : undefined;

    if (
      (mode === "webhook" && validWebhookTo) ||
      (completionMode === "webhook" && validCompletionTo)
    ) {
      delete raw.notify;
      changed = true;
      continue;
    }

    if ((mode === undefined && !hasLegacyChatDelivery) || mode === "none" || mode === "webhook") {
      if (!legacyWebhook) {
        warnMissingLegacyWebhook(jobName);
        continue;
      }
      raw.delivery = {
        ...delivery,
        mode: "webhook",
        to: mode === "none" ? legacyWebhook : (validWebhookTo ?? legacyWebhook),
      };
      delete raw.notify;
      changed = true;
      continue;
    }

    if (legacyWebhook) {
      raw.delivery = {
        ...delivery,
        ...(hasLegacyChatDelivery ? { mode: "announce" } : {}),
        completionDestination: {
          ...completionDestination,
          mode: "webhook",
          to: legacyWebhook,
        },
      };
      delete raw.notify;
      changed = true;
      continue;
    }

    warnMissingLegacyWebhook(jobName);
  }

  return { changed, warnings };
}
