import { resolveAgentDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  type AuthProfileStore,
  externalCliDiscoveryForProviderAuth,
  ensureAuthProfileStore,
  resolveAuthStatePathForDisplay,
  setAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { shortenHomePath } from "../../utils.js";
import { loadModelsConfig } from "./load-config.js";
import { resolveKnownAgentId } from "./shared.js";

function resolveTargetAgent(
  cfg: Awaited<ReturnType<typeof loadModelsConfig>>,
  raw?: string,
): {
  agentId: string;
  agentDir: string;
} {
  const agentId = resolveKnownAgentId({ cfg, rawAgentId: raw }) ?? resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  return { agentId, agentDir };
}

function describeOrder(store: AuthProfileStore, provider: string): string[] {
  const providerKey = normalizeProviderId(provider);
  const order = store.order?.[providerKey];
  return Array.isArray(order) ? order : [];
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
  const provider = normalizeProviderId(rawProvider);
  const cfg = await loadModelsConfig({ commandName: "models auth-order", runtime });
  const { agentId, agentDir } = resolveTargetAgent(cfg, opts.agent);
  return { cfg, agentId, agentDir, provider };
}

export async function modelsAuthOrderGetCommand(
  opts: { provider: string; agent?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const { cfg, agentId, agentDir, provider } = await resolveAuthOrderContext(opts, runtime);
  const store = ensureAuthProfileStore(agentDir, {
    externalCli: externalCliDiscoveryForProviderAuth({ cfg, provider }),
  });
  const order = describeOrder(store, provider);

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
  runtime.log(`Auth state file: ${shortenHomePath(resolveAuthStatePathForDisplay(agentDir))}`);
  runtime.log(order.length > 0 ? `Order override: ${order.join(", ")}` : "Order override: (none)");
}

export async function modelsAuthOrderClearCommand(
  opts: { provider: string; agent?: string },
  runtime: RuntimeEnv,
) {
  const { agentId, agentDir, provider } = await resolveAuthOrderContext(opts, runtime);
  const updated = await setAuthProfileOrder({
    agentDir,
    provider,
    order: null,
  });
  if (!updated) {
    throw new Error(
      `Failed to update auth-state.json; the auth state lock may be busy. Wait a moment and rerun ${formatCliCommand("openclaw models auth order clear --provider " + provider)}.`,
    );
  }

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log("Cleared per-agent order override.");
}

export async function modelsAuthOrderSetCommand(
  opts: { provider: string; agent?: string; order: string[] },
  runtime: RuntimeEnv,
) {
  const { cfg, agentId, agentDir, provider } = await resolveAuthOrderContext(opts, runtime);

  const store = ensureAuthProfileStore(agentDir, {
    externalCli: externalCliDiscoveryForProviderAuth({ cfg, provider }),
  });
  const providerKey = provider;
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
    if (normalizeProviderId(cred.provider) !== providerKey) {
      throw new Error(`Auth profile "${profileId}" is for ${cred.provider}, not ${provider}.`);
    }
  }

  const updated = await setAuthProfileOrder({
    agentDir,
    provider,
    order: requested,
  });
  if (!updated) {
    throw new Error(
      `Failed to update auth-state.json; the auth state lock may be busy. Wait a moment and rerun ${formatCliCommand("openclaw models auth order set --provider " + provider + " <profileIds...>")}.`,
    );
  }

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log(`Order override: ${describeOrder(updated, provider).join(", ")}`);
}
