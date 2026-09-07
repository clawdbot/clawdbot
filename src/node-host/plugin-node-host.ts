/** Plugin node-host bridge for loading plugin registry commands and dispatching node capabilities. */
import { asOptionalRecord as normalizeRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { NodePluginToolDescriptor } from "../../packages/gateway-protocol/src/schema/nodes.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { toErrorObject } from "../infra/errors.js";
import {
  parseComputerUseCapabilityDescriptor,
  type ComputerUseCapabilityDescriptor,
} from "../plugins/computer-use-contract.js";
import {
  PluginRegistryResourceScope,
  createPluginRegistryResourceLease,
  releasePluginRegistryResourcesAfter,
} from "../plugins/registry-resources.js";
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
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
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
type NodeHostPluginRegistryOwner = Omit<
  ReturnType<typeof bindNodeHostPluginResources>,
  "release"
> & {
  release: () => Promise<void>;
  closed: boolean;
  watcherCleanups: Set<() => Promise<void>>;
};
type NodeHostPluginRegistryHost = { current?: NodeHostPluginRegistryOwner };

const nodeHostPluginRegistryHost = resolveGlobalSingleton<NodeHostPluginRegistryHost>(
  Symbol.for("openclaw.nodeHostPluginRegistryHost"),
  () => ({}),
  resetNodeHostPluginRegistry,
);

function resolveNodeHostPluginRegistry() {
  const owner = nodeHostPluginRegistryHost.current;
  return owner
    ? owner.closed
      ? undefined
      : owner.registry
    : (getActivePluginRegistry() ?? undefined);
}

function bindNodeHostPluginResources(
  registry: PluginRegistry | undefined,
  resources: PluginRegistryResourceScope,
) {
  const lease = createPluginRegistryResourceLease(resources);
  return {
    registry,
    resources,
    release: lease.release,
    run: <T>(operation: () => T): T =>
      lease.run(() => withPluginRuntimeRegistryScope(registry, operation)),
  };
}

function acquireNodeHostPluginResources(registry: PluginRegistry | undefined) {
  const owner = nodeHostPluginRegistryHost.current;
  // Preparation may acquire another registry's resources for later command callbacks.
  const resources =
    owner && owner.registry === registry
      ? owner.resources.fork()
      : new PluginRegistryResourceScope();
  if (registry) {
    resources.retain(registry);
  }
  return bindNodeHostPluginResources(registry, resources);
}

function withNodeHostPluginResources<T>(registry: PluginRegistry | undefined, run: () => T): T {
  const lease = acquireNodeHostPluginResources(registry);
  try {
    return lease.run(run);
  } finally {
    lease.release();
  }
}

/** Ensure plugin registry data is loaded before node-host command dispatch. */
export async function ensureNodeHostPluginRegistry(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ release: () => void | Promise<void> }> {
  const loaded = (await loadPluginRegistryLoaderModule()).loadPluginRegistryHandle({
    config: params.config,
    activationSourceConfig: params.config,
    env: params.env,
  });
  const resources = new PluginRegistryResourceScope();
  const registry = resources.adopt(loaded);
  const lease = bindNodeHostPluginResources(registry, resources);
  let releasePromise: Promise<void> | undefined;
  const handle: NodeHostPluginRegistryOwner = {
    ...lease,
    closed: false,
    watcherCleanups: new Set(),
    release: () => {
      handle.closed = true;
      releasePromise ??= (async () => {
        const results = await Promise.allSettled(
          [...handle.watcherCleanups].map(async (cleanup) => await cleanup()),
        );
        throwNodeHostCleanupFailures(
          results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
        );
        lease.release();
        await resources.waitForDisposals();
      })().catch((error: unknown) => {
        releasePromise = undefined;
        throw error;
      });
      return releasePromise;
    },
  };
  try {
    // Resolve this registry's native readiness before publishing the first manifest.
    // No process-wide preparation cache: a replacement registry owns fresh resources.
    await handle.run(async () => {
      const prepare = new Set(registry.nodeHostCommands.map((entry) => entry.command.prepare));
      const results = await Promise.allSettled(
        [...prepare].map(async (callback) =>
          callback?.({ config: params.config, env: params.env ?? process.env }),
        ),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        throw failure.reason;
      }
    });
    const previous = nodeHostPluginRegistryHost.current;
    if (previous) {
      await previous.release();
      if (nodeHostPluginRegistryHost.current && nodeHostPluginRegistryHost.current !== previous) {
        throw new Error("Node-host registry was replaced during resource retirement");
      }
    }
    nodeHostPluginRegistryHost.current = handle;
    return {
      release: async () => {
        await handle.release();
        if (nodeHostPluginRegistryHost.current === handle) {
          nodeHostPluginRegistryHost.current = undefined;
        }
      },
    };
  } catch (error) {
    try {
      await handle.release();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "node-host preparation and cleanup failed", {
        cause: cleanupError,
      });
    }
    throw error;
  }
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
  return withNodeHostPluginResources(registry, () => {
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
  onChange: () => void | Promise<void>,
): () => Promise<void> {
  const registry = resolveNodeHostPluginRegistry();
  const lease = acquireNodeHostPluginResources(registry);
  const owner = nodeHostPluginRegistryHost.current;
  const watcherCleanups = owner && owner.registry === registry ? owner.watcherCleanups : undefined;
  let cleanups: Array<() => void | Promise<void>> = [];
  let stopped = false;
  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped = true;
    stopping ??= (async () => {
      const results = await Promise.all(
        cleanups.map(async (cleanup) => {
          try {
            await lease.run(cleanup);
            return { ok: true, cleanup } as const;
          } catch (error) {
            return { ok: false, cleanup, error } as const;
          }
        }),
      );
      cleanups = results.flatMap((result) => (result.ok ? [] : [result.cleanup]));
      // Failed teardown still owns resources and is retryable through stop or host release.
      throwNodeHostCleanupFailures(results.flatMap((result) => (result.ok ? [] : [result.error])));
      watcherCleanups?.delete(stop);
      lease.release();
      await lease.resources.waitForDisposals();
    })().catch((error: unknown) => {
      stopping = undefined;
      throw error;
    });
    return stopping;
  };
  watcherCleanups?.add(stop);
  try {
    lease.run(() => {
      for (const entry of registry?.nodeHostCommands ?? []) {
        const cleanup = entry.command.watchAvailability?.(context, () => {
          if (!stopped) {
            void lease.run(onChange);
          }
        });
        if (cleanup) {
          cleanups.push(cleanup);
        }
      }
    });
  } catch (error) {
    // Registration stays synchronous; the existing host retains failed rollback for awaited release.
    void stop().catch(() => {});
    throw error;
  }
  return stop;
}

function throwNodeHostCleanupFailures(failures: unknown[]): void {
  if (failures.length === 1) {
    throw toErrorObject(failures[0], "node-host watcher cleanup failed");
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, "node-host watcher cleanup failed");
  }
}

/** Release plugin command state before a reconnected Gateway can invoke it again. */
export async function notifyRegisteredNodeHostCommandDisconnect(): Promise<void> {
  const registry = resolveNodeHostPluginRegistry();
  await withNodeHostPluginResources(registry, async () => {
    const callbacks = new Set(
      (registry?.nodeHostCommands ?? [])
        .map((entry) => entry.command.onDisconnect)
        .filter((callback): callback is () => Promise<void> | void => callback !== undefined),
    );
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
  /** The invocation owner also settles already accepted input and framed deliveries. */
  resourceCompletion?: Promise<unknown>,
): Promise<string | null> {
  const registry = resolveNodeHostPluginRegistry();
  const match = (registry?.nodeHostCommands ?? []).find(
    (entry) => entry.command.command === command,
  );
  if (!match) {
    return null;
  }
  let active = true;
  const lease = acquireNodeHostPluginResources(registry);
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
  const frames = io?.frames;
  const scopedFrames: OpenClawPluginNodeHostCommandIo["frames"] = frames && {
    send: (message) => frames.send(message),
    onMessage: (callback) => frames.onMessage((message) => lease.run(() => callback(message))),
  };
  const scopedIo: OpenClawPluginNodeHostCommandIo | undefined = io && {
    signal: io.signal,
    emitChunk: (chunk) => io.emitChunk(chunk),
    onInput: (callback) => io.onInput((payload) => lease.run(() => callback(payload))),
    ...(scopedFrames ? { frames: scopedFrames } : {}),
  };
  try {
    return await lease.run(async () => {
      if (match.command.duplex === true) {
        if (!scopedIo) {
          throw new Error(`node command requires duplex transport: ${command}`);
        }
        return invokeContext
          ? await match.command.handle(paramsJSON, scopedIo, invokeContext)
          : await match.command.handle(paramsJSON, scopedIo);
      }
      return invokeContext
        ? await match.command.handle(paramsJSON, undefined, invokeContext)
        : await match.command.handle(paramsJSON);
    });
  } finally {
    active = false;
    // Authority ends with handle; accepted frame delivery can still own resource work.
    if (resourceCompletion) {
      releasePluginRegistryResourcesAfter(lease.resources, resourceCompletion);
    } else {
      lease.release();
    }
  }
}

export function isRegisteredNodeHostCommandDuplex(command: string): boolean {
  const registry = resolveNodeHostPluginRegistry();
  return (
    (registry?.nodeHostCommands ?? []).find((entry) => entry.command.command === command)?.command
      .duplex === true
  );
}

async function resetNodeHostPluginRegistry(
  host: NodeHostPluginRegistryHost = nodeHostPluginRegistryHost,
): Promise<void> {
  const handle = host.current;
  await handle?.release();
  if (host.current === handle) {
    host.current = undefined;
  }
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.nodeHostPluginTestApi")] = {
    getNodeHostPluginRegistry: () => nodeHostPluginRegistryHost.current?.registry,
    resetNodeHostPluginRegistry,
  };
}
