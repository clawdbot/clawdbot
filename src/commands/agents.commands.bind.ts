// Implements agent route binding list/add/remove subcommands.
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { listAgentEntries, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { formatCliCommand } from "../cli/command-format.js";
import { ExpectedCliError } from "../cli/failure-output.js";
import { isRouteBinding, listRouteBindings } from "../config/bindings.js";
import { replaceConfigFile } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import type { AgentRouteBinding } from "../config/types.js";
import { normalizeAgentId, normalizeAgentIdStrict } from "../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { createLazyPromise } from "../shared/lazy-promise.js";
import { describeBinding } from "./agents.binding-format.js";
import { requireValidConfig, requireValidConfigForWrite } from "./config-validation.js";

type AgentConfig = NonNullable<Awaited<ReturnType<typeof requireValidConfig>>>;

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

const loadAgentBindingsModule = createLazyPromise(() => import("./agents.bindings.js"));

function hasAgent(cfg: AgentConfig, agentId: string): boolean {
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

function failAgentBinding(message: string): never {
  throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
}

function resolveTargetAgentId(params: {
  cfg: AgentConfig;
  agentInput: string | undefined;
}): string {
  const normalized =
    params.agentInput === undefined ? null : normalizeAgentIdStrict(params.agentInput);
  if (normalized && !normalized.ok) {
    failAgentBinding(
      `Agent "${params.agentInput}" not found. Run ${formatCliCommand("openclaw agents list")} to see configured agents.`,
    );
  }
  const agentId = normalized?.value ?? resolveDefaultAgentId(params.cfg);
  if (!hasAgent(params.cfg, agentId)) {
    failAgentBinding(
      `Agent "${agentId}" not found. Run ${formatCliCommand("openclaw agents list")} to see configured agents.`,
    );
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

async function resolveParsedBindings(params: {
  cfg: AgentConfig;
  agentId: string;
  bindValues: string[] | undefined;
  emptyMessage: string;
}): Promise<AgentRouteBinding[]> {
  const specs = normalizeStringEntries(params.bindValues);
  if (specs.length === 0) {
    failAgentBinding(params.emptyMessage);
  }

  const { parseBindingSpecs } = await loadAgentBindingsModule();
  const parsed = parseBindingSpecs({ agentId: params.agentId, specs, config: params.cfg });
  if (parsed.errors.length > 0) {
    failAgentBinding(parsed.errors.join("\n"));
  }
  return parsed.bindings;
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

async function resolveConfigAndTargetAgentId(params: {
  runtime: RuntimeEnv;
  agentInput: string | undefined;
}) {
  const writeSnapshot = await requireValidConfigForWrite(params.runtime);
  if (!writeSnapshot) {
    return null;
  }
  const cfg = writeSnapshot.snapshot.sourceConfig;
  const agentId = resolveTargetAgentId({ cfg, agentInput: params.agentInput });
  return { cfg, agentId, writeSnapshot };
}

/** List configured agent route bindings, optionally filtered by target agent. */
export async function agentsBindingsCommand(
  opts: AgentsBindingsListOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime, { skipPluginValidation: true });
  if (!cfg) {
    return;
  }

  const filterAgentId =
    opts.agent === undefined ? undefined : resolveTargetAgentId({ cfg, agentInput: opts.agent });

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

/** Add route bindings for an agent and fail when another agent already owns the route. */
export async function agentsBindCommand(
  opts: AgentsBindOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const resolved = await resolveConfigAndTargetAgentId({
    runtime,
    agentInput: opts.agent,
  });
  if (!resolved) {
    return;
  }
  const { cfg, agentId, writeSnapshot } = resolved;

  const bindings = await resolveParsedBindings({
    cfg,
    agentId,
    bindValues: opts.bind,
    emptyMessage: "Provide at least one --bind <channel[:accountId]>.",
  });

  const { applyAgentBindings } = await loadAgentBindingsModule();
  const result = applyAgentBindings(cfg, bindings);
  if (result.added.length > 0 || result.updated.length > 0) {
    await replaceConfigFile({
      sourceConfig: result.config,
      ...writeSnapshot,
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

/** Remove selected route bindings, or all bindings owned by an agent with `--all`. */
export async function agentsUnbindCommand(
  opts: AgentsUnbindOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const resolved = await resolveConfigAndTargetAgentId({
    runtime,
    agentInput: opts.agent,
  });
  if (!resolved) {
    return;
  }
  const { cfg, agentId, writeSnapshot } = resolved;
  if (opts.all && (opts.bind?.length ?? 0) > 0) {
    failAgentBinding("Use either --all or --bind, not both.");
  }

  if (opts.all) {
    const existing = listRouteBindings(cfg);
    const removed = existing.filter((binding) => normalizeAgentId(binding.agentId) === agentId);
    const keptRoutes = existing.filter((binding) => normalizeAgentId(binding.agentId) !== agentId);
    const nonRoutes = (cfg.bindings ?? []).filter((binding) => !isRouteBinding(binding));
    if (removed.length === 0) {
      if (
        emitJsonPayload({
          runtime,
          json: opts.json,
          payload: {
            agentId,
            removed: [] as string[],
            missing: [] as string[],
            conflicts: [] as string[],
          },
        })
      ) {
        return;
      }
      runtime.log(`No bindings to remove for agent "${agentId}".`);
      return;
    }
    const next = {
      ...cfg,
      bindings:
        [...keptRoutes, ...nonRoutes].length > 0 ? [...keptRoutes, ...nonRoutes] : undefined,
    };
    await replaceConfigFile({
      sourceConfig: next,
      ...writeSnapshot,
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

  const bindings = await resolveParsedBindings({
    cfg,
    agentId,
    bindValues: opts.bind,
    emptyMessage: "Provide at least one --bind <channel[:accountId]> or use --all.",
  });

  const { removeAgentBindings } = await loadAgentBindingsModule();
  const result = removeAgentBindings(cfg, bindings);
  if (result.removed.length > 0) {
    await replaceConfigFile({
      sourceConfig: result.config,
      ...writeSnapshot,
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
