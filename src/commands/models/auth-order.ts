/** Commands for viewing and editing per-agent provider auth profile order. */
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import {
  type AuthProfileStore,
  externalCliDiscoveryForProviderAuth,
  ensureAuthProfileStore,
  resolveAuthStatePathForDisplay,
  setAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { findNormalizedProviderValue } from "../../agents/model-selection.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";
import { refreshRunningGatewayAuthState } from "./auth-refresh.js";
import { loadModelsConfig } from "./load-config.js";
import { resolveModelsTargetAgent } from "./shared.js";

function describeOrder(store: AuthProfileStore, provider: string, cfg: OpenClawConfig): string[] {
  const providerKey = resolveProviderIdForAuth(provider, { config: cfg });
  const order =
    store.order?.[providerKey] ??
    Object.entries(store.order ?? {}).find(
      ([storedProvider]) =>
        resolveProviderIdForAuth(storedProvider, { config: cfg }) === providerKey,
    )?.[1];
  return Array.isArray(order) ? order : [];
}

function describeOrderFallback(cfg: OpenClawConfig, provider: string): string {
  const authProvider = resolveProviderIdForAuth(provider, { config: cfg });
  const configuredOrder =
    findNormalizedProviderValue(cfg.auth?.order, authProvider) ??
    findNormalizedProviderValue(cfg.auth?.order, provider);
  if (configuredOrder === undefined) {
    return "selecting automatically";
  }
  return configuredOrder.length > 0
    ? `using order from config: ${configuredOrder.join(", ")}`
    : "config selects no profiles";
}

async function resolveAuthOrderContext(
  opts: { provider: string; agent?: string },
  runtime: RuntimeEnv,
) {
  const rawProvider = opts.provider?.trim();
  if (!rawProvider) {
    throw new Error(
      `Missing --provider. Run ${formatCliCommand("openclaw models auth list")} to see saved provider profiles.`,
    );
  }
  const cfg = await loadModelsConfig({ commandName: "models auth-order", runtime });
  // Alias model providers share the canonical credential owner's account order.
  const provider = resolveProviderIdForAuth(rawProvider, { config: cfg });
  const { agentId, agentDir } = resolveModelsTargetAgent(cfg, opts.agent);
  return { cfg, agentId, agentDir, provider };
}

/** Shows the configured auth profile priority order for a provider. */
export async function modelsAuthOrderGetCommand(
  opts: { provider: string; agent?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const { cfg, agentId, agentDir, provider } = await resolveAuthOrderContext(opts, runtime);
  const store = ensureAuthProfileStore(agentDir, {
    externalCli: externalCliDiscoveryForProviderAuth({ cfg, provider }),
  });
  const order = describeOrder(store, provider, cfg);

  if (opts.json) {
    writeRuntimeJson(runtime, {
      agentId,
      agentDir,
      provider,
      authStatePath: shortenHomePath(resolveAuthStatePathForDisplay(agentDir)),
      order: order.length > 0 ? order : null,
    });
    return;
  }

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log(`Auth state store: ${shortenHomePath(resolveAuthStatePathForDisplay(agentDir))}`);
  runtime.log(
    order.length > 0
      ? `Auth profile order override: ${order.join(", ")}`
      : `Auth profile order override: none (${describeOrderFallback(cfg, provider)})`,
  );
}

/** Clears the configured auth profile priority order for a provider. */
export async function modelsAuthOrderClearCommand(
  opts: { provider: string; agent?: string },
  runtime: RuntimeEnv,
) {
  const { cfg, agentId, agentDir, provider } = await resolveAuthOrderContext(opts, runtime);
  const updated = await setAuthProfileOrder({
    agentDir,
    config: cfg,
    provider,
    order: null,
  });
  if (!updated) {
    throw new Error(
      `Failed to update auth state; the auth state lock may be busy. Wait a moment and rerun ${formatCliCommand("openclaw models auth order clear --provider " + provider)}.`,
    );
  }

  await refreshRunningGatewayAuthState();

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log(`Auth profile order override cleared; ${describeOrderFallback(cfg, provider)}.`);
}

/** Sets the provider auth profile priority order after validating each profile id. */
export async function modelsAuthOrderSetCommand(
  opts: { provider: string; agent?: string; order: string[] },
  runtime: RuntimeEnv,
) {
  const { cfg, agentId, agentDir, provider } = await resolveAuthOrderContext(opts, runtime);

  const store = ensureAuthProfileStore(agentDir, {
    externalCli: externalCliDiscoveryForProviderAuth({ cfg, provider }),
  });
  const requested = normalizeStringEntries(opts.order ?? []);
  if (requested.length === 0) {
    throw new Error(
      `Missing profile ids. Run ${formatCliCommand("openclaw models auth list --provider " + provider)} to choose one or more profile ids.`,
    );
  }

  for (const profileId of requested) {
    const cred = store.profiles[profileId];
    if (!cred) {
      throw new Error(
        `Auth profile "${profileId}" not found in ${shortenHomePath(agentDir)}. Run ${formatCliCommand("openclaw models auth list --provider " + provider)} to see saved profiles.`,
      );
    }
    if (resolveProviderIdForAuth(cred.provider, { config: cfg }) !== provider) {
      throw new Error(`Auth profile "${profileId}" is for ${cred.provider}, not ${provider}.`);
    }
  }

  const updated = await setAuthProfileOrder({
    agentDir,
    config: cfg,
    provider,
    order: requested,
  });
  if (!updated) {
    throw new Error(
      `Failed to update auth state; the auth state lock may be busy. Wait a moment and rerun ${formatCliCommand("openclaw models auth order set --provider " + provider + " <profileIds...>")}.`,
    );
  }

  await refreshRunningGatewayAuthState();

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log(`Auth profile order override: ${describeOrder(updated, provider, cfg).join(", ")}`);
}
