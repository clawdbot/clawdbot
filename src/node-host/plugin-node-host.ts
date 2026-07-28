/** Plugin node-host bridge for loading plugin registry commands and dispatching node capabilities. */
import type { NodePluginToolDescriptor } from "../../packages/gateway-protocol/src/schema/nodes.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginNodeHostCommandRegistration } from "../plugins/registry-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import type {
  OpenClawPluginNodeHostCommandAvailabilityContext,
  OpenClawPluginNodeHostCommandIo,
} from "../plugins/types.js";
import type { OpenClawPluginNodeHostCommandContext } from "../plugins/types.node-host.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

/**
 * Plugin node-host command registry bridge.
 *
 * Node hosts load the active plugin registry, expose registered capabilities
 * and commands, and dispatch incoming node-host commands by exact command id.
 */

const loadPluginRegistryLoaderModule = createLazyRuntimeModule(
  () => import("../plugins/runtime/runtime-registry-loader.js"),
);

/** Ensure plugin registry data is loaded before node-host command dispatch. */
export async function ensureNodeHostPluginRegistry(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  (await loadPluginRegistryLoaderModule()).ensurePluginRegistryLoaded({
    scope: "all",
    config: params.config,
    activationSourceConfig: params.config,
    env: params.env,
  });
}

/** List registered node-host capabilities and command ids in deterministic order. */
export function listRegisteredNodeHostCapsAndCommands(
  context: OpenClawPluginNodeHostCommandAvailabilityContext,
  options: { includeDuplex?: boolean } = {},
): {
  caps: string[];
  commands: string[];
  nodePluginTools: NodePluginToolDescriptor[];
} {
  const registry = getActivePluginRegistry();
  const caps = new Set<string>();
  const commands = new Set<string>();
  const nodePluginTools = new Map<string, NodePluginToolDescriptor>();
  for (const entry of registry?.nodeHostCommands ?? []) {
    if (entry.command.duplex === true && options.includeDuplex === false) {
      continue;
    }
    // Availability belongs to the node-local plugin. Gateway policy still keeps
    // the command registered so a differently configured remote node can expose it.
    if (entry.command.isAvailable?.(context) === false) {
      continue;
    }
    if (entry.command.cap) {
      caps.add(entry.command.cap);
    }
    commands.add(entry.command.command);
    const agentTool = buildNodePluginToolDescriptor(entry);
    if (agentTool) {
      nodePluginTools.set(`${agentTool.pluginId}\0${agentTool.name}`, agentTool);
    }
  }
  return {
    caps: [...caps].toSorted((left, right) => left.localeCompare(right)),
    commands: [...commands].toSorted((left, right) => left.localeCompare(right)),
    nodePluginTools: [...nodePluginTools.values()].toSorted(
      (left, right) =>
        left.pluginId.localeCompare(right.pluginId) || left.name.localeCompare(right.name),
    ),
  };
}

/** Watch plugin-owned availability inputs that can change during this process. */
export function watchRegisteredNodeHostCommandAvailability(
  context: OpenClawPluginNodeHostCommandAvailabilityContext,
  onChange: () => void,
): () => void {
  const registry = getActivePluginRegistry();
  const cleanups: Array<() => void> = [];
  for (const entry of registry?.nodeHostCommands ?? []) {
    const cleanup = entry.command.watchAvailability?.(context, onChange);
    if (cleanup) {
      cleanups.push(cleanup);
    }
  }
  return () => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  };
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isProviderSafeToolName(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
}

function buildNodePluginToolDescriptor(
  entry: PluginNodeHostCommandRegistration,
): NodePluginToolDescriptor | null {
  const agentTool = entry.command.agentTool;
  if (!agentTool) {
    return null;
  }
  const name = normalizeString(agentTool.name);
  const description = normalizeString(agentTool.description);
  if (!isProviderSafeToolName(name) || !description) {
    return null;
  }
  const mcpServer = normalizeString(agentTool.mcp?.server);
  const mcpTool = normalizeString(agentTool.mcp?.tool);
  return {
    pluginId: entry.pluginId,
    name,
    description,
    parameters: normalizeRecord(agentTool.parameters) ?? {
      type: "object",
      properties: {},
      additionalProperties: true,
    },
    command: entry.command.command,
    ...(mcpServer && mcpTool ? { mcp: { server: mcpServer, tool: mcpTool } } : {}),
  };
}

/** Invoke a registered node-host plugin command, or return null for unknown commands. */
export async function invokeRegisteredNodeHostCommand(
  command: string,
  paramsJSON?: string | null,
  io?: OpenClawPluginNodeHostCommandIo,
  context?: OpenClawPluginNodeHostCommandContext,
): Promise<string | null> {
  const registry = getActivePluginRegistry();
  const match = (registry?.nodeHostCommands ?? []).find(
    (entry) => entry.command.command === command,
  );
  if (!match) {
    return null;
  }
  if (match.command.duplex === true) {
    if (!io) {
      throw new Error(`node command requires duplex transport: ${command}`);
    }
    return context
      ? await match.command.handle(paramsJSON, io, context)
      : await match.command.handle(paramsJSON, io);
  }
  return context
    ? await match.command.handle(paramsJSON, undefined, context)
    : await match.command.handle(paramsJSON);
}

export function isRegisteredNodeHostCommandDuplex(command: string): boolean {
  const registry = getActivePluginRegistry();
  return (
    (registry?.nodeHostCommands ?? []).find((entry) => entry.command.command === command)?.command
      .duplex === true
  );
}
