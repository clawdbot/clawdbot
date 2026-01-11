import type { ClawdbotConfig } from "../../config/config.js";
import { listProviderPlugins } from "../../providers/plugins/index.js";
import type { ProviderPlugin } from "../../providers/plugins/types.js";
import {
  DELIVERABLE_MESSAGE_PROVIDERS,
  type DeliverableMessageProvider,
  normalizeMessageProvider,
} from "../../utils/message-provider.js";

export type MessageProviderId = DeliverableMessageProvider;

const MESSAGE_PROVIDERS = [...DELIVERABLE_MESSAGE_PROVIDERS];

function isKnownProvider(value: string): value is MessageProviderId {
  return (MESSAGE_PROVIDERS as readonly string[]).includes(value);
}

function isAccountEnabled(account: unknown): boolean {
  if (!account || typeof account !== "object") return true;
  const enabled = (account as { enabled?: boolean }).enabled;
  return enabled !== false;
}

async function isPluginConfigured(
  plugin: ProviderPlugin,
  cfg: ClawdbotConfig,
): Promise<boolean> {
  const accountIds = plugin.config.listAccountIds(cfg);
  if (accountIds.length === 0) return false;

  for (const accountId of accountIds) {
    const account = plugin.config.resolveAccount(cfg, accountId);
    const enabled = plugin.config.isEnabled
      ? plugin.config.isEnabled(account, cfg)
      : isAccountEnabled(account);
    if (!enabled) continue;
    if (!plugin.config.isConfigured) return true;
    const configured = await plugin.config.isConfigured(account, cfg);
    if (configured) return true;
  }

  return false;
}

export async function listConfiguredMessageProviders(
  cfg: ClawdbotConfig,
): Promise<MessageProviderId[]> {
  const providers: MessageProviderId[] = [];
  for (const plugin of listProviderPlugins()) {
    if (!isKnownProvider(plugin.id)) continue;
    if (await isPluginConfigured(plugin, cfg)) {
      providers.push(plugin.id);
    }
  }
  return providers;
}

export async function resolveMessageProviderSelection(params: {
  cfg: ClawdbotConfig;
  provider?: string | null;
}): Promise<{ provider: MessageProviderId; configured: MessageProviderId[] }> {
  const normalized = normalizeMessageProvider(params.provider);
  if (normalized) {
    if (!isKnownProvider(normalized)) {
      throw new Error(`Unknown provider: ${normalized}`);
    }
    return {
      provider: normalized,
      configured: await listConfiguredMessageProviders(params.cfg),
    };
  }

  const configured = await listConfiguredMessageProviders(params.cfg);
  if (configured.length === 1) {
    return { provider: configured[0], configured };
  }
  if (configured.length === 0) {
    throw new Error("Provider is required (no configured providers detected).");
  }
  throw new Error(
    `Provider is required when multiple providers are configured: ${configured.join(
      ", ",
    )}`,
  );
}
