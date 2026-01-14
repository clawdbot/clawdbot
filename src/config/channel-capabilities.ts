import { normalizeChannelId } from "../channels/registry.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { ClawdbotConfig } from "./config.js";

function normalizeCapabilities(
  capabilities: string[] | undefined,
): string[] | undefined {
  if (!capabilities) return undefined;
  const normalized = capabilities.map((entry) => entry.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function resolveAccountCapabilities(params: {
  cfg?: { accounts?: Record<string, { capabilities?: string[] }> } & {
    capabilities?: string[];
  };
  accountId?: string | null;
}): string[] | undefined {
  const cfg = params.cfg;
  if (!cfg) return undefined;
  const normalizedAccountId = normalizeAccountId(params.accountId);

  const accounts = cfg.accounts;
  if (accounts && typeof accounts === "object") {
    const direct = accounts[normalizedAccountId];
    if (direct) {
      return (
        normalizeCapabilities(direct.capabilities) ??
        normalizeCapabilities(cfg.capabilities)
      );
    }
    const matchKey = Object.keys(accounts).find(
      (key) => key.toLowerCase() === normalizedAccountId.toLowerCase(),
    );
    const match = matchKey ? accounts[matchKey] : undefined;
    if (match) {
      return (
        normalizeCapabilities(match.capabilities) ??
        normalizeCapabilities(cfg.capabilities)
      );
    }
  }

  return normalizeCapabilities(cfg.capabilities);
}

export function resolveChannelCapabilities(params: {
  cfg?: ClawdbotConfig;
  channel?: string | null;
  accountId?: string | null;
}): string[] | undefined {
  const cfg = params.cfg;
  const channel = normalizeChannelId(params.channel);
  if (!cfg || !channel) return undefined;

  const channelsConfig = cfg.channels as Record<string, unknown> | undefined;
  const channelConfig = (channelsConfig?.[channel] ??
    (cfg as Record<string, unknown>)[channel]) as
    | {
        accounts?: Record<string, { capabilities?: string[] }>;
        capabilities?: string[];
      }
    | undefined;
  return resolveAccountCapabilities({
    cfg: channelConfig,
    accountId: params.accountId,
  });
}
