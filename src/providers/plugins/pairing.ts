import type { ClawdbotConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  getProviderPlugin,
  listProviderPlugins,
  normalizeProviderId,
  type ProviderId,
} from "./index.js";
import type { ProviderPairingAdapter } from "./types.js";

export function listPairingProviders(): ProviderId[] {
  // Provider docking: pairing support is declared via plugin.pairing.
  return listProviderPlugins()
    .filter((plugin) => plugin.pairing)
    .map((plugin) => plugin.id);
}

export function getPairingAdapter(
  providerId: ProviderId,
): ProviderPairingAdapter | null {
  const plugin = getProviderPlugin(providerId);
  return plugin?.pairing ?? null;
}

export function requirePairingAdapter(
  providerId: ProviderId,
): ProviderPairingAdapter {
  const adapter = getPairingAdapter(providerId);
  if (!adapter) {
    throw new Error(`Provider ${providerId} does not support pairing`);
  }
  return adapter;
}

export function resolvePairingProvider(raw: unknown): ProviderId {
  const value = (
    typeof raw === "string"
      ? raw
      : typeof raw === "number" || typeof raw === "boolean"
        ? String(raw)
        : ""
  )
    .trim()
    .toLowerCase();
  const normalized = normalizeProviderId(value);
  const providers = listPairingProviders();
  if (!normalized || !providers.includes(normalized)) {
    throw new Error(
      `Invalid provider: ${value || "(empty)"} (expected one of: ${providers.join(", ")})`,
    );
  }
  return normalized;
}

export async function notifyPairingApproved(params: {
  providerId: ProviderId;
  id: string;
  cfg: ClawdbotConfig;
  runtime?: RuntimeEnv;
}): Promise<void> {
  const adapter = requirePairingAdapter(params.providerId);
  if (!adapter.notifyApproval) return;
  await adapter.notifyApproval({
    cfg: params.cfg,
    id: params.id,
    runtime: params.runtime,
  });
}
