import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

/** Resolved geolocation settings, including the credit its data license requires. */
export type GeolocationSettings = {
  databaseUrl: string;
  attribution: { text: string; url: string };
  refreshMs: number;
};

// DB-IP City Lite is CC BY 4.0: usable commercially, redistribution-free because
// we download at runtime, but the credit below is a license term, not decoration.
const DEFAULT_DATABASE_URL = "https://download.db-ip.com/free/dbip-city-lite-{yyyy}-{mm}.mmdb.gz";
const DEFAULT_ATTRIBUTION_TEXT = "IP Geolocation by DB-IP";
const DEFAULT_ATTRIBUTION_URL = "https://db-ip.com";
const DEFAULT_REFRESH_DAYS = 30;

function positiveRefreshDays(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function resolveGeolocationSettings(pluginConfig: unknown): GeolocationSettings {
  const config = asOptionalRecord(pluginConfig);
  const refreshDays = positiveRefreshDays(config?.refreshDays) ?? DEFAULT_REFRESH_DAYS;
  return {
    databaseUrl: normalizeOptionalString(config?.databaseUrl) ?? DEFAULT_DATABASE_URL,
    attribution: {
      text: normalizeOptionalString(config?.attributionText) ?? DEFAULT_ATTRIBUTION_TEXT,
      url: normalizeOptionalString(config?.attributionUrl) ?? DEFAULT_ATTRIBUTION_URL,
    },
    refreshMs: refreshDays * 24 * 60 * 60 * 1000,
  };
}

/**
 * Monthly builds appear a few days into the month, so the newest published
 * release is either this month's or the previous one. Callers try in order.
 */
export function expandDatabaseUrls(template: string, now: Date): string[] {
  const candidates = [now, new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))];
  const urls = candidates.map((date) =>
    template
      .replaceAll("{yyyy}", String(date.getUTCFullYear()))
      .replaceAll("{mm}", String(date.getUTCMonth() + 1).padStart(2, "0")),
  );
  return [...new Set(urls)];
}
