import { listAgentEntries, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { isRouteBinding, listRouteBindings } from "../config/bindings.js";
import { replaceConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import type { AgentRouteBinding } from "../config/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { describeBinding } from "./agents.binding-format.js";
import { requireValidConfig, requireValidConfigFileSnapshot } from "./agents.command-shared.js";

type AgentBindingsModule = typeof import("./agents.bindings.js");

type AgentsBindingsListOptions = {
  agent?: string;
  json?: boolean;
};

type AgentsBindOptions = {
  agent?: string;
  bind?: string[];
  json?: boolean;
};

type AgentsUnbindOptions = {
  agent?: string;
  bind?: string[];
  all?: boolean;
  json?: boolean;
};

const agentBindingsModuleLoader = createLazyImportLoader<AgentBindingsModule>(
  () => import("./agents.bindings.js"),
);

function loadAgentBindingsModule(): Promise<AgentBindingsModule> {
  return agentBindingsModuleLoader.load();
}

function resolveAgentId(
  cfg: Awaited<ReturnType<typeof requireValidConfig>>,
  agentInput: string | undefined,
  params?: { fallbackToDefault?: boolean },
): string | null {
  if (!cfg) {
    return null;
  }
  if (agentInput?.trim()) {
    return normalizeAgentId(agentInput);
  }
  if (params?.fallbackToDefault) {
    return resolveDefaultAgentId(cfg);
  }
  return null;
}

function hasAgent(cfg: Awaited<ReturnType<typeof requireValidConfig>>, agentId: string): boolean {
  if (!cfg) {
    return false;
  }
  const targetAgentId = normalizeAgentId(agentId);
  const agents = listAgentEntries(cfg);
  if (agents.length === 0) {
    return targetAgentId === normalizeAgentId(resolveDefaultAgentId(cfg));
  }
  return agents.some((agent) => normalizeAgentId(agent.id) === targetAgentId);
}

function formatBindingOwnerLine(binding: AgentRouteBinding): string {
  return `${normalizeAgentId(binding.agentId)} <- ${describeBinding(binding)}`;
}

function resolveTargetAgentIdOrExit(params: {
  cfg: Awaited<ReturnType<typeof requireValidConfig>>;
  runtime: RuntimeEnv;
  agentInput: string | undefined;
}): string | null {
  const agentId = resolveAgentId(params.cfg, params.agentInput?.trim(), {
    fallbackToDefault: true,
  });
  if (!agentId) {
    params.runtime.error("Unable to resolve agent id.");
    params.runtime.exit(1);
    return null;
  }
  if (!hasAgent(params.cfg, agentId)) {
    params.runtime.error(`Agent "${agentId}" not found.`);
    params.runtime.exit(1);
    return null;
  }
  return agentId;
}

function formatBindingConflicts(
  conflicts: Array<{ binding: AgentRouteBinding; existingAgentId: string }>,
): string[] {
  return conflicts.map(
    (conflict) => `${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`,
  );
}

async function resolveParsedBindingsOrExit(params: {
  runtime: RuntimeEnv;
  cfg: NonNullable<Awaited<ReturnType<typeof requireValidConfig>>>;
  agentId: string;
  bindValues: string[] | undefined;
  emptyMessage: string;
}): Promise<{
  bindings: AgentRouteBinding[];
  errors: string[];
} | null> {
  const specs = (params.bindValues ?? []).map((value) => value.trim()).filter(Boolean);
  if (specs.length === 0) {
    params.runtime.error(params.emptyMessage);
    params.runtime.exit(1);
    return null;
  }

  const { parseBindingSpecs } = await loadAgentBindingsModule();
  const parsed = parseBindingSpecs({ agentId: params.agentId, specs, config: params.cfg });
  if (parsed.errors.length > 0) {
    params.runtime.error(parsed.errors.join("\n"));
    params.runtime.exit(1);
    return null;
  }
  return parsed;
}

function emitJsonPayload(params: {
  runtime: RuntimeEnv;
  json: boolean | undefined;
  payload: unknown;
  conflictCount?: number;
}): boolean {
  if (!params.json) {
    return false;
  }
  writeRuntimeJson(params.runtime, params.payload);
  if ((params.conflictCount ?? 0) > 0) {
    params.runtime.exit(1);
  }
  return true;
}

async function resolveConfigAndTargetAgentIdOrExit(params: {
  runtime: RuntimeEnv;
  agentInput: string | undefined;
}): Promise<{
  cfg: NonNullable<Awaited<ReturnType<typeof requireValidConfig>>>;
  agentId: string;
  baseHash?: string;
} | null> {
  const configSnapshot = await requireValidConfigFileSnapshot(params.runtime);
  if (!configSnapshot) {
    return null;
  }
  const cfg = configSnapshot.sourceConfig ?? configSnapshot.config;
  const agentId = resolveTargetAgentIdOrExit({
    cfg,
    runtime: params.runtime,
    agentInput: params.agentInput,
  });
  if (!agentId) {
    return null;
  }
  return { cfg, agentId, baseHash: configSnapshot.hash };
}

export async function agentsBindingsCommand(
  opts: AgentsBindingsListOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) {
    return;
  }

  const filterAgentId = resolveAgentId(cfg, opts.agent?.trim());
  if (opts.agent && !filterAgentId) {
    runtime.error("Agent id is required.");
    runtime.exit(1);
    return;
  }
  if (filterAgentId && !hasAgent(cfg, filterAgentId)) {
    runtime.error(`Agent "${filterAgentId}" not found.`);
    runtime.exit(1);
    return;
  }

  const filtered = listRouteBindings(cfg).filter(
    (binding) => !filterAgentId || normalizeAgentId(binding.agentId) === filterAgentId,
  );
  if (opts.json) {
    writeRuntimeJson(
      runtime,
      filtered.map((binding) => ({
        agentId: normalizeAgentId(binding.agentId),
        match: binding.match,
        description: describeBinding(binding),
      })),
    );
    return;
  }

  if (filtered.length === 0) {
    runtime.log(
      filterAgentId ? `No routing bindings for agent "${filterAgentId}".` : "No routing bindings.",
    );
    return;
  }

  runtime.log(
    [
      "Routing bindings:",
      ...filtered.map((binding) => `- ${formatBindingOwnerLine(binding)}`),
    ].join("\n"),
  );
}

export async function agentsBindCommand(
  opts: AgentsBindOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const resolved = await resolveConfigAndTargetAgentIdOrExit({
    runtime,
    agentInput: opts.agent,
  });
  if (!resolved) {
    return;
  }
  const { cfg, agentId, baseHash } = resolved;

  const parsed = await resolveParsedBindingsOrExit({
    runtime,
    cfg,
    agentId,
    bindValues: opts.bind,
    emptyMessage: "Provide at least one --bind <channel[:accountId]>.",
  });
  if (!parsed) {
    return;
  }

  const { applyAgentBindings } = await loadAgentBindingsModule();
  const result = applyAgentBindings(cfg, parsed.bindings);
  if (result.added.length > 0 || result.updated.length > 0) {
    await replaceConfigFile({
      nextConfig: result.config,
      ...(baseHash !== undefined ? { baseHash } : {}),
    });
    if (!opts.json) {
      logConfigUpdated(runtime);
    }
  }

  const payload = {
    agentId,
    added: result.added.map(describeBinding),
    updated: result.updated.map(describeBinding),
    skipped: result.skipped.map(describeBinding),
    conflicts: formatBindingConflicts(result.conflicts),
  };
  if (
    emitJsonPayload({ runtime, json: opts.json, payload, conflictCount: result.conflicts.length })
  ) {
    return;
  }

  if (result.added.length > 0) {
    runtime.log("Added bindings:");
    for (const binding of result.added) {
      runtime.log(`- ${describeBinding(binding)}`);
    }
  } else if (result.updated.length === 0) {
    runtime.log("No new bindings added.");
  }

  if (result.updated.length > 0) {
    runtime.log("Updated bindings:");
    for (const binding of result.updated) {
      runtime.log(`- ${describeBinding(binding)}`);
    }
  }

  if (result.skipped.length > 0) {
    runtime.log("Already present:");
    for (const binding of result.skipped) {
      runtime.log(`- ${describeBinding(binding)}`);
    }
  }

  if (result.conflicts.length > 0) {
    runtime.error("Skipped bindings already claimed by another agent:");
    for (const conflict of result.conflicts) {
      runtime.error(`- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`);
    }
    runtime.exit(1);
  }
}

export async function agentsUnbindCommand(
  opts: AgentsUnbindOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const resolved = await resolveConfigAndTargetAgentIdOrExit({
    runtime,
    agentInput: opts.agent,
  });
  if (!resolved) {
    return;
  }
  const { cfg, agentId, baseHash } = resolved;
  if (opts.all && (opts.bind?.length ?? 0) > 0) {
    runtime.error("Use either --all or --bind, not both.");
    runtime.exit(1);
    return;
  }

  if (opts.all) {
    const existing = listRouteBindings(cfg);
    const removed = existing.filter((binding) => normalizeAgentId(binding.agentId) === agentId);
    const keptRoutes = existing.filter((binding) => normalizeAgentId(binding.agentId) !== agentId);
    const nonRoutes = (cfg.bindings ?? []).filter((binding) => !isRouteBinding(binding));
    if (removed.length === 0) {
      runtime.log(`No bindings to remove for agent "${agentId}".`);
      return;
    }
    const next = {
      ...cfg,
      bindings:
        [...keptRoutes, ...nonRoutes].length > 0 ? [...keptRoutes, ...nonRoutes] : undefined,
    };
    await replaceConfigFile({
      nextConfig: next,
      ...(baseHash !== undefined ? { baseHash } : {}),
    });
    if (!opts.json) {
      logConfigUpdated(runtime);
    }
    const payload = {
      agentId,
      removed: removed.map(describeBinding),
      missing: [] as string[],
      conflicts: [] as string[],
    };
    if (emitJsonPayload({ runtime, json: opts.json, payload })) {
      return;
    }
    runtime.log(`Removed ${removed.length} binding(s) for "${agentId}".`);
    return;
  }

  const parsed = await resolveParsedBindingsOrExit({
    runtime,
    cfg,
    agentId,
    bindValues: opts.bind,
    emptyMessage: "Provide at least one --bind <channel[:accountId]> or use --all.",
  });
  if (!parsed) {
    return;
  }

  const { removeAgentBindings } = await loadAgentBindingsModule();
  const result = removeAgentBindings(cfg, parsed.bindings);
  if (result.removed.length > 0) {
    await replaceConfigFile({
      nextConfig: result.config,
      ...(baseHash !== undefined ? { baseHash } : {}),
    });
    if (!opts.json) {
      logConfigUpdated(runtime);
    }
  }

  const payload = {
    agentId,
    removed: result.removed.map(describeBinding),
    missing: result.missing.map(describeBinding),
    conflicts: formatBindingConflicts(result.conflicts),
  };
  if (
    emitJsonPayload({ runtime, json: opts.json, payload, conflictCount: result.conflicts.length })
  ) {
    return;
  }

  if (result.removed.length > 0) {
    runtime.log("Removed bindings:");
    for (const binding of result.removed) {
      runtime.log(`- ${describeBinding(binding)}`);
    }
  } else {
    runtime.log("No bindings removed.");
  }
  if (result.missing.length > 0) {
    runtime.log("Not found:");
    for (const binding of result.missing) {
      runtime.log(`- ${describeBinding(binding)}`);
    }
  }
  if (result.conflicts.length > 0) {
    runtime.error("Bindings are owned by another agent:");
    for (const conflict of result.conflicts) {
      runtime.error(`- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`);
    }
    runtime.exit(1);
  }
}
