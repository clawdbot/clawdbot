// Control UI view renders channel config extras screen content.
import { t } from "../../i18n/index.ts";

export function resolveChannelConfigValue(
  configForm: Record<string, unknown> | null | undefined,
  channelId: string,
): Record<string, unknown> | null {
  if (!configForm) {
    return null;
  }
  const channels = (configForm.channels ?? {}) as Record<string, unknown>;
  const fromChannels = channels[channelId];
  if (fromChannels && typeof fromChannels === "object") {
    return fromChannels as Record<string, unknown>;
  }
  const fallback = configForm[channelId];
  if (fallback && typeof fallback === "object") {
    return fallback as Record<string, unknown>;
  }
  return null;
}

export function formatChannelExtraValue(raw: unknown): string {
  if (raw == null) {
    return t("common.na");
  }
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
    return String(raw);
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return t("common.na");
  }
}

export function resolveChannelExtras(params: {
  configForm: Record<string, unknown> | null | undefined;
  channelId: string;
  fields: readonly string[];
}): Array<{ label: string; value: string }> {
  const value = resolveChannelConfigValue(params.configForm, params.channelId);
  if (!value) {
    return [];
  }
  return params.fields.flatMap((field) => {
    if (!(field in value)) {
      return [];
    }
    return [{ label: field, value: formatChannelExtraValue(value[field]) }];
  });
}
