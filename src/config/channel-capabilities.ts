import { normalizeAnyChannelId } from "../channels/registry.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { OpenClawConfig } from "./config.js";
import type { SlackCapabilitiesConfig } from "./types.slack.js";
import type { TelegramCapabilitiesConfig } from "./types.telegram.js";

type CapabilitiesConfig = TelegramCapabilitiesConfig | SlackCapabilitiesConfig;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

function normalizeCapabilities(capabilities: CapabilitiesConfig | undefined): string[] | undefined {
  // Handle object-format capabilities (e.g., { inlineButtons: "dm" }) gracefully.
  // Channel-specific handlers (like resolveTelegramInlineButtonsScope) process these separately.
  if (!isStringArray(capabilities)) {
    return undefined;
  }
  const normalized = capabilities.map((entry) => entry.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function resolveAccountCapabilities(params: {
  cfg?: { accounts?: Record<string, { capabilities?: CapabilitiesConfig }> } & {
    capabilities?: CapabilitiesConfig;
  };
  accountId?: string | null;
}): string[] | undefined {
  const cfg = params.cfg;
  if (!cfg) {
    return undefined;
  }
  const normalizedAccountId = normalizeAccountId(params.accountId);

  const accounts = cfg.accounts;
  if (accounts && typeof accounts === "object") {
    const match = resolveAccountEntry(accounts, normalizedAccountId);
    if (match) {
      return normalizeCapabilities(match.capabilities) ?? normalizeCapabilities(cfg.capabilities);
    }
  }

  return normalizeCapabilities(cfg.capabilities);
}

export function resolveChannelCapabilities(params: {
  cfg?: Partial<OpenClawConfig>;
  channel?: string | null;
  accountId?: string | null;
}): string[] | undefined {
  const cfg = params.cfg;
  const channel = normalizeAnyChannelId(params.channel);
  if (!cfg || !channel) {
    return undefined;
  }

  const channelsConfig = cfg.channels as Record<string, unknown> | undefined;
  const channelConfig = (channelsConfig?.[channel] ?? (cfg as Record<string, unknown>)[channel]) as
    | {
        accounts?: Record<string, { capabilities?: CapabilitiesConfig }>;
        capabilities?: CapabilitiesConfig;
      }
    | undefined;
  return resolveAccountCapabilities({
    cfg: channelConfig,
    accountId: params.accountId,
  });
}
