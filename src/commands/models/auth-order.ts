import {
  resolveAgentDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import {
  type AuthProfileStore,
  ensureAuthProfileStore,
  setAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import { loadConfig } from "../../config/config.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { RuntimeEnv } from "../../runtime.js";
import { shortenHomePath } from "../../utils.js";

function resolveTargetAgent(
  cfg: ReturnType<typeof loadConfig>,
  raw?: string,
): {
  agentId: string;
  agentDir: string;
} {
  const agentId = raw?.trim()
    ? normalizeAgentId(raw.trim())
    : resolveDefaultAgentId(cfg);
  const agentDir = resolveAgentDir(cfg, agentId);
  return { agentId, agentDir };
}

function describeOrder(store: AuthProfileStore, provider: string): string[] {
  const providerKey = normalizeProviderId(provider);
  const order = store.order?.[providerKey];
  return Array.isArray(order) ? order : [];
}

export async function modelsAuthOrderGetCommand(
  opts: { provider: string; agent?: string; json?: boolean },
  runtime: RuntimeEnv,
) {
  const rawProvider = opts.provider?.trim();
  if (!rawProvider) throw new Error("Missing --provider.");
  const provider = normalizeProviderId(rawProvider);

  const cfg = loadConfig();
  const { agentId, agentDir } = resolveTargetAgent(cfg, opts.agent);
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const order = describeOrder(store, provider);

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          agentId,
          agentDir,
          provider,
          authStorePath: shortenHomePath(`${agentDir}/auth-profiles.json`),
          order: order.length > 0 ? order : null,
        },
        null,
        2,
      ),
    );
    return;
  }

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log(
    `Auth file: ${shortenHomePath(`${agentDir}/auth-profiles.json`)}`,
  );
  runtime.log(
    order.length > 0
      ? `Order override: ${order.join(", ")}`
      : "Order override: (none)",
  );
}

export async function modelsAuthOrderClearCommand(
  opts: { provider: string; agent?: string },
  runtime: RuntimeEnv,
) {
  const rawProvider = opts.provider?.trim();
  if (!rawProvider) throw new Error("Missing --provider.");
  const provider = normalizeProviderId(rawProvider);

  const cfg = loadConfig();
  const { agentId, agentDir } = resolveTargetAgent(cfg, opts.agent);
  const updated = await setAuthProfileOrder({
    agentDir,
    provider,
    order: null,
  });
  if (!updated)
    throw new Error("Failed to update auth-profiles.json (lock busy?).");

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log("Cleared per-agent order override.");
}

export async function modelsAuthOrderSetCommand(
  opts: { provider: string; agent?: string; order: string[] },
  runtime: RuntimeEnv,
) {
  const rawProvider = opts.provider?.trim();
  if (!rawProvider) throw new Error("Missing --provider.");
  const provider = normalizeProviderId(rawProvider);

  const cfg = loadConfig();
  const { agentId, agentDir } = resolveTargetAgent(cfg, opts.agent);

  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const providerKey = normalizeProviderId(provider);
  const requested = (opts.order ?? [])
    .map((entry) => String(entry).trim())
    .filter(Boolean);
  if (requested.length === 0) {
    throw new Error("Missing profile ids. Provide one or more profile ids.");
  }

  for (const profileId of requested) {
    const cred = store.profiles[profileId];
    if (!cred) {
      throw new Error(`Auth profile "${profileId}" not found in ${agentDir}.`);
    }
    if (normalizeProviderId(cred.provider) !== providerKey) {
      throw new Error(
        `Auth profile "${profileId}" is for ${cred.provider}, not ${provider}.`,
      );
    }
  }

  const updated = await setAuthProfileOrder({
    agentDir,
    provider,
    order: requested,
  });
  if (!updated)
    throw new Error("Failed to update auth-profiles.json (lock busy?).");

  runtime.log(`Agent: ${agentId}`);
  runtime.log(`Provider: ${provider}`);
  runtime.log(`Order override: ${describeOrder(updated, provider).join(", ")}`);
}
