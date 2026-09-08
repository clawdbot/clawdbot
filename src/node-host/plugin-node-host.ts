/** Plugin node-host bridge for loading plugin registry commands and dispatching node capabilities. */
import { asOptionalRecord as normalizeRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { NodePluginToolDescriptor } from "../../packages/gateway-protocol/src/schema/nodes.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  parseComputerUseCapabilityDescriptor,
  type ComputerUseCapabilityDescriptor,
} from "../plugins/computer-use-contract.js";
import type {
  PluginNodeHostCommandRegistration,
  PluginRegistry,
} from "../plugins/registry-types.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type {
  OpenClawPluginNodeHostCommandAvailabilityContext,
  OpenClawPluginNodeHostCommandIo,
} from "../plugins/types.js";
import type { OpenClawPluginNodeHostCommandContext } from "../plugins/types.node-host.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { preparePluginExecAuthorization } from "./plugin-exec-policy.js";

/**
 * Plugin node-host command registry bridge.
 *
 * Node hosts load the active plugin registry, expose registered capabilities
 * and commands, and dispatch incoming node-host commands by exact command id.
 */

const loadPluginRegistryLoaderModule = createLazyRuntimeModule(
  () => import("../plugins/loader.js"),
);
let nodeHostPluginRegistry: PluginRegistry | undefined;

function resolveNodeHostPluginRegistry() {
  return nodeHostPluginRegistry ?? getActivePluginRegistry() ?? undefined;
}

/** Ensure plugin registry data is loaded before node-host command dispatch. */
export async function ensureNodeHostPluginRegistry(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const registry = (await loadPluginRegistryLoaderModule()).loadPluginRegistryHandle({
    config: params.config,
    activationSourceConfig: params.config,
    env: params.env,
  });
  // Resolve this registry's native readiness before publishing the first manifest.
  // No process-wide preparation cache: a replacement registry owns fresh resources.
  await withPluginRuntimeRegistryScope(registry, async () => {
    const prepare = new Set(registry.nodeHostCommands.map((entry) => entry.command.prepare));
    await Promise.all(
      [...prepare].map(async (callback) =>
        callback?.({ config: params.config, env: params.env ?? process.env }),
      ),
    );
  });
  nodeHostPluginRegistry = registry;
}

/** List registered node-host capabilities and command ids in deterministic order. */
export function listRegisteredNodeHostCapsAndCommands(
  context: OpenClawPluginNodeHostCommandAvailabilityContext,
  options: { includeDuplex?: boolean } = {},
): {
  caps: string[];
  commands: string[];
  computerUse?: ComputerUseCapabilityDescriptor;
  nodePluginTools: NodePluginToolDescriptor[];
} {
  const registry = resolveNodeHostPluginRegistry();
  return withPluginRuntimeRegistryScope(registry, () => {
    const caps = new Set<string>();
    const commands = new Set<string>();
    let computerUse: ComputerUseCapabilityDescriptor | undefined;
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
      if (entry.command.computerUse) {
        computerUse = parseComputerUseCapabilityDescriptor(entry.command.computerUse(context));
      }
      const agentTool = buildNodePluginToolDescriptor(entry);
      if (agentTool) {
        nodePluginTools.set(`${agentTool.pluginId}\0${agentTool.name}`, agentTool);
      }
    }
    return {
      caps: [...caps].toSorted((left, right) => left.localeCompare(right)),
      commands: [...commands].toSorted((left, right) => left.localeCompare(right)),
      ...(computerUse ? { computerUse } : {}),
      nodePluginTools: [...nodePluginTools.values()].toSorted(
        (left, right) =>
          left.pluginId.localeCompare(right.pluginId) || left.name.localeCompare(right.name),
      ),
    };
  });
}

/** Watch plugin-owned availability inputs that can change during this process. */
export function watchRegisteredNodeHostCommandAvailability(
  context: OpenClawPluginNodeHostCommandAvailabilityContext,
  onChange: () => void,
): () => void {
  const registry = resolveNodeHostPluginRegistry();
  const cleanups: Array<() => void> = [];
  withPluginRuntimeRegistryScope(registry, () => {
    for (const entry of registry?.nodeHostCommands ?? []) {
      const cleanup = entry.command.watchAvailability?.(context, () =>
        withPluginRuntimeRegistryScope(registry, onChange),
      );
      if (cleanup) {
        cleanups.push(cleanup);
      }
    }
  });
  return () =>
    withPluginRuntimeRegistryScope(registry, () => {
      for (const cleanup of cleanups.splice(0)) {
        cleanup();
      }
    });
}

/** Release plugin command state before a reconnected Gateway can invoke it again. */
export async function notifyRegisteredNodeHostCommandDisconnect(): Promise<void> {
  const registry = resolveNodeHostPluginRegistry();
  const callbacks = new Set(
    (registry?.nodeHostCommands ?? [])
      .map((entry) => entry.command.onDisconnect)
      .filter((callback): callback is () => Promise<void> | void => callback !== undefined),
  );
  await withPluginRuntimeRegistryScope(registry, async () => {
    const results = await Promise.allSettled(
      [...callbacks].map(async (callback) => await callback()),
    );
    const failures = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) {
      const failure = failures[0];
      throw failure instanceof Error
        ? failure
        : new Error("node-host plugin disconnect cleanup failed", { cause: failure });
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "node-host plugin disconnect cleanup failed");
    }
  });
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
  const name = normalizeOptionalString(agentTool.name) ?? "";
  const description = normalizeOptionalString(agentTool.description) ?? "";
  if (!isProviderSafeToolName(name) || !description) {
    return null;
  }
  const mcpServer = normalizeOptionalString(agentTool.mcp?.server) ?? "";
  const mcpTool = normalizeOptionalString(agentTool.mcp?.tool) ?? "";
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
  const registry = resolveNodeHostPluginRegistry();
  const match = (registry?.nodeHostCommands ?? []).find(
    (entry) => entry.command.command === command,
  );
  if (!match) {
    return null;
  }
  let active = true;
  const registeredCommand = match.command;
  const pluginRecord = registry?.plugins.find((record) => record.id === match.pluginId);
  const assertActive = () => {
    if (
      !active ||
      match.command !== registeredCommand ||
      io?.signal.aborted ||
      context?.signal?.aborted ||
      resolveNodeHostPluginRegistry() !== registry ||
      !registry?.nodeHostCommands.includes(match) ||
      !pluginRecord ||
      !registry.plugins.includes(pluginRecord) ||
      !pluginRecord.enabled ||
      pluginRecord.status !== "loaded"
    ) {
      throw new Error("node plugin invocation authority is closed");
    }
  };
  const invokeContext = context
    ? {
        ...context,
        prepareExecAuthorization: (source: "human-approved" | "session-full") =>
          preparePluginExecAuthorization({
            source,
            command,
            sessionKey: context.sessionKey,
            assertActive,
          }),
      }
    : undefined;
  try {
    return await withPluginRuntimeRegistryScope(registry, async () => {
      if (match.command.duplex === true) {
        if (!io) {
          throw new Error(`node command requires duplex transport: ${command}`);
        }
        return invokeContext
          ? await match.command.handle(paramsJSON, io, invokeContext)
          : await match.command.handle(paramsJSON, io);
      }
      return invokeContext
        ? await match.command.handle(paramsJSON, undefined, invokeContext)
        : await match.command.handle(paramsJSON);
    });
  } finally {
    active = false;
  }
}

export function isRegisteredNodeHostCommandDuplex(command: string): boolean {
  const registry = resolveNodeHostPluginRegistry();
  return (
    (registry?.nodeHostCommands ?? []).find((entry) => entry.command.command === command)?.command
      .duplex === true
  );
}

function resetNodeHostPluginRegistry(): void {
  nodeHostPluginRegistry = undefined;
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.nodeHostPluginTestApi")] = {
    getNodeHostPluginRegistry: () => nodeHostPluginRegistry,
    resetNodeHostPluginRegistry,
  };
}
