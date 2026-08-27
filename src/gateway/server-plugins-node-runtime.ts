import { NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS } from "../infra/node-commands.js";
import { createNodeDuplexEndpoint } from "../infra/node-duplex-framing.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "./node-command-policy.js";
import type { GatewayNodeInvokeStream } from "./server-methods/shared-types.js";
import type { GatewayContextResolver, GatewayRequestContext } from "./server-methods/types.js";
import { getInProcessGatewayRequestContext } from "./server-plugin-in-process-dispatch.js";

export function hasInProcessGatewayContext(
  resolveGatewayContext?: GatewayContextResolver,
): boolean {
  return Boolean(getInProcessGatewayRequestContext(resolveGatewayContext));
}

/** Opens one lifecycle-fenced binary channel through the canonical node invocation owner. */
export async function openGatewayNodeDuplex(options: {
  params: Parameters<PluginRuntime["nodes"]["openDuplex"]>[0];
  invokeNode: (
    params: Parameters<PluginRuntime["nodes"]["invoke"]>[0],
    stream?: GatewayNodeInvokeStream,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  resolveGatewayContext?: GatewayContextResolver;
  runtimeLifetime?: AbortSignal;
}): ReturnType<PluginRuntime["nodes"]["openDuplex"]> {
  const { params, resolveGatewayContext, runtimeLifetime, invokeNode } = options;
  const scope = getPluginRuntimeGatewayRequestScope();
  if (!scope?.pluginId?.trim()) {
    throw new Error("Plugin node duplex commands require an active owning plugin identity.");
  }
  const registrations = scope.pluginRegistry?.nodeHostCommands.filter(
    (entry) => entry.command.command === params.command,
  );
  if (
    registrations?.length !== 1 ||
    registrations[0]?.pluginId !== scope.pluginId ||
    registrations[0]?.command.duplex !== true
  ) {
    throw new Error(
      `Node command "${params.command}" must be registered exactly once by plugin "${scope.pluginId}" and declare duplex: true.`,
    );
  }
  const callerIdentity = scope.client?.internal?.agentRuntimeIdentity;
  const context = getInProcessGatewayRequestContext(resolveGatewayContext);
  if (!context?.nodeRegistry) {
    throw new Error("Plugin node duplex commands require an active Gateway node registry.");
  }
  const controller = new AbortController();
  const signals = [controller.signal, runtimeLifetime, params.signal].filter(
    (candidate): candidate is AbortSignal => candidate !== undefined,
  );
  const signal = AbortSignal.any(signals);
  const abortError = () =>
    signal.reason instanceof Error ? signal.reason : new Error("Node duplex invocation cancelled.");
  if (signal.aborted) {
    throw abortError();
  }
  let invokeId: string | undefined;
  let framedReady = false;
  const ready = createDeferredCore();
  const isRuntimeCurrent = () =>
    !signal.aborted &&
    (!resolveGatewayContext || resolveGatewayContext() === context) &&
    (!callerIdentity || context.validateAgentRuntimeApprovalAuthority?.(callerIdentity) === true);
  const assertRuntimeCurrent = () => {
    if (!isRuntimeCurrent()) {
      const error = signal.aborted
        ? abortError()
        : new Error("Plugin Gateway runtime authority is no longer current.");
      controller.abort(error);
      throw error;
    }
  };
  const endpoint = createNodeDuplexEndpoint({
    requireReady: true,
    maxMessageBytes: params.maxMessageBytes,
    maxOutstandingDeliveryBytes: params.maxOutstandingDeliveryBytes,
    sendFrame(frame) {
      assertRuntimeCurrent();
      if (!invokeId || !framedReady) {
        throw new Error("Node duplex command is not ready for binary messages.");
      }
      context.nodeRegistry.sendInvokeInput(invokeId, JSON.parse(frame));
    },
    onReady() {
      if (!invokeId) {
        throw new Error("Node duplex command announced readiness before its dispatch.");
      }
      framedReady = true;
      ready.resolve();
    },
    onError: (error) => controller.abort(error),
  });
  const onAbort = () => endpoint.close();
  signal.addEventListener("abort", onAbort, { once: true });
  const closed = invokeNode(
    params,
    {
      onProgress: (chunk) => {
        assertRuntimeCurrent();
        endpoint.receive(chunk);
      },
      onDispatchReady: (id) => {
        assertRuntimeCurrent();
        invokeId = id;
      },
      isRuntimeCurrent,
      idleTimeoutMs: NODE_DUPLEX_INVOKE_IDLE_TIMEOUT_MS,
    },
    signal,
  )
    .then(async (result) => {
      if (!invokeId || !framedReady) {
        throw new Error("Node command completed without opening a ready duplex invocation.");
      }
      await endpoint.drain();
      return result;
    })
    .finally(() => {
      signal.removeEventListener("abort", onAbort);
      endpoint.close();
      controller.abort(new Error("Node duplex command has closed."));
    });
  void closed.catch(ready.reject);
  await ready.promise;
  return {
    send: (message) => endpoint.send(message),
    onMessage: (listener) => {
      assertRuntimeCurrent();
      return endpoint.onMessage(listener);
    },
    closed,
    close: () => controller.abort(new Error("Node duplex channel closed by its caller.")),
  };
}

export function projectGatewayRuntimeNodes(
  nodes: unknown[],
  context: GatewayRequestContext | undefined,
): unknown[] {
  return nodes.map((node) => {
    if (
      !node ||
      typeof node !== "object" ||
      Array.isArray(node) ||
      !context?.nodeRegistry?.get ||
      !context.getRuntimeConfig
    ) {
      return node;
    }
    const nodeRecord = node as Record<string, unknown>;
    const nodeId = typeof nodeRecord.nodeId === "string" ? nodeRecord.nodeId : "";
    const liveNode = nodeId ? context.nodeRegistry.get(nodeId) : undefined;
    if (!liveNode) {
      return node;
    }
    const allowlist = resolveNodeCommandAllowlist(context.getRuntimeConfig(), {
      ...liveNode,
      approvedCommands: liveNode.commands,
    });
    const invocableCommands = liveNode.commands.filter(
      (command) =>
        isNodeCommandAllowed({
          command,
          declaredCommands: liveNode.commands,
          allowlist,
        }).ok,
    );
    return Object.assign({}, nodeRecord, { invocableCommands });
  });
}
