import { randomUUID } from "node:crypto";
import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import type { ComputerToolTransport } from "../../agents/tools/computer-tool.js";
import {
  getActiveAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { NODE_WORKER_DESKTOP_COMPUTER_COMMAND } from "../../infra/node-commands.js";
import { parseComputerUseCapabilityDescriptor } from "../../plugins/computer-use-contract.js";
import { getActivePluginGatewayNodePolicyRegistry } from "../../plugins/runtime.js";
import type { WorkerComputerLaunchDescriptor } from "../../worker/launch-descriptor.js";
import { parseNodeWorkerComputerInput } from "../../worker/node-computer-protocol.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import { applyPluginNodeInvokePolicy } from "../node-invoke-plugin-policy.js";
import { invokeNodeWithReadinessRetry } from "../node-invoke-readiness.js";
import type { NodeWorkerSupervisorTransport } from "../node-registry-private.js";
import type { GatewayContextResolver } from "../server-methods/types.js";
import type { WorkerSessionPlacementStore, WorkerSessionTurnClaim } from "./placement-store.js";
import type { WorkerEnvironmentStore } from "./store.js";
import { WorkerRunnerUnavailableError } from "./tunnel-contract.js";
import type { WorkerComputerExecutor } from "./worker-turn-computer-rpc.js";

const COMPUTER_COMMANDS = ["screen.snapshot", "computer.act"] as const;

type InvokeResult = Awaited<ReturnType<NodeWorkerSupervisorTransport["invoke"]>>;

function payload(result: InvokeResult): unknown {
  if (!result.ok) {
    throw new Error(result.error?.message ?? "Session desktop command failed");
  }
  return result.payloadJSON ? JSON.parse(result.payloadJSON) : result.payload;
}

type WorkerComputerTransport = Omit<ComputerToolTransport, "invoke"> & {
  invoke(
    request: Parameters<ComputerToolTransport["invoke"]>[0],
    assertAuthorized?: () => void,
  ): Promise<unknown>;
};

export type PreparedWorkerComputer = {
  descriptor: WorkerComputerLaunchDescriptor;
  bind(operationalRunInstance: OperationalRunInstanceRef): WorkerComputerTransport;
  close(reason: string): Promise<void>;
};

/** Captures one placement's desktop; neither model input nor a copied run ID selects a node. */
export function createWorkerComputerTransportOwner(options: {
  store: Pick<WorkerEnvironmentStore, "get">;
  placements: Pick<WorkerSessionPlacementStore, "get" | "validateTurnClaim">;
  resolveGatewayContext: GatewayContextResolver;
  getNodeTransport: () => NodeWorkerSupervisorTransport | undefined;
  warn: (message: string) => void;
}) {
  return async (claim: WorkerSessionTurnClaim): Promise<PreparedWorkerComputer | undefined> => {
    const placement = options.placements.get(claim.sessionId);
    if (placement?.state !== "active" || !options.placements.validateTurnClaim(claim)) {
      throw new Error("Session desktop placement is no longer active");
    }
    const environment = options.store.get(placement.environmentId);
    if (!environment?.nodeDeviceId || (!environment.desktop && !environment.sharedHost)) {
      return undefined;
    }
    const context = options.resolveGatewayContext();
    const nodeTransport = options.getNodeTransport();
    if (!context || !nodeTransport) {
      throw new Error("Session desktop Gateway is unavailable");
    }
    const node = context.nodeRegistry.get(environment.nodeDeviceId);
    if (!node) {
      throw new WorkerRunnerUnavailableError();
    }
    const environmentIsCurrent = () => {
      const current = options.store.get(environment.environmentId);
      const currentNode = context.nodeRegistry.get(node.nodeId);
      return (
        options.resolveGatewayContext() === context &&
        options.getNodeTransport() === nodeTransport &&
        current?.leaseId === environment.leaseId &&
        current?.ownerEpoch === environment.ownerEpoch &&
        current?.nodeDeviceId === node.nodeId &&
        currentNode?.connId === node.connId &&
        currentNode?.pairingGeneration === node.pairingGeneration &&
        currentNode.client.invalidated !== true
      );
    };
    const placementIsCurrent = () => {
      const current = options.placements.get(claim.sessionId);
      const currentEnvironment = options.store.get(environment.environmentId);
      return (
        environmentIsCurrent() &&
        options.placements.validateTurnClaim(claim) &&
        current?.state === "active" &&
        current.generation === claim.placementGeneration &&
        current.sessionKey === placement.sessionKey &&
        current.agentId === placement.agentId &&
        current.environmentId === environment.environmentId &&
        current.activeOwnerEpoch === environment.ownerEpoch &&
        currentEnvironment?.state === "attached" &&
        currentEnvironment.destroyRequestedAtMs === null &&
        currentEnvironment.attachedSessionIds.length === 1 &&
        currentEnvironment.attachedSessionIds[0] === claim.sessionId
      );
    };
    const assertPlacement = () => {
      if (!placementIsCurrent()) {
        throw new Error("Session desktop placement authority changed");
      }
    };
    assertPlacement();
    // Shared paired hosts retain their approved public contract; disposable workers use only
    // their private endpoint. A failed private probe never selects another connected computer.
    const privateNode = environment.sharedHost
      ? undefined
      : (await nodeTransport.listCurrentNodes()).find(
          (candidate) => candidate.nodeId === node.nodeId,
        );
    assertPlacement();
    if (!environment.sharedHost && !privateNode) {
      throw new Error("Session desktop node lacks the current private worker protocol");
    }
    let computerUse = node.computerUse;
    if (privateNode) {
      const result = await nodeTransport.invoke({
        node: privateNode,
        command: NODE_WORKER_DESKTOP_COMPUTER_COMMAND,
        params: { operation: "capabilities" },
        isDispatchAuthorized: placementIsCurrent,
      });
      assertPlacement();
      if (!nodeTransport.isCurrent(privateNode)) {
        throw new Error("Session desktop private node owner changed");
      }
      if (!result.ok) {
        options.warn(
          "Session computer control is unavailable; enable the desktop provider and reprovision the worker.",
        );
        return undefined;
      }
      computerUse = parseComputerUseCapabilityDescriptor(payload(result));
    } else if (!COMPUTER_COMMANDS.every((command) => node.commands.includes(command))) {
      return undefined;
    }
    if (!computerUse) {
      return undefined;
    }
    const registry = getActivePluginGatewayNodePolicyRegistry();
    if (
      privateNode &&
      !registry?.nodeInvokePolicies.some((entry) => entry.policy.commands.includes("computer.act"))
    ) {
      options.warn(
        "Session computer control is unavailable; enable its provider plugin on the Gateway.",
      );
      return undefined;
    }
    const policyOwners = COMPUTER_COMMANDS.map((command) => {
      const entry = registry?.nodeInvokePolicies.find((item) =>
        item.policy.commands.includes(command),
      );
      const policy = entry?.policy;
      const plugin = registry?.plugins.find((item) => item.id === entry?.pluginId);
      return () =>
        registry?.nodeInvokePolicies.find((item) => item.policy.commands.includes(command)) ===
          entry &&
        entry?.policy === policy &&
        (!plugin ||
          (registry?.plugins.includes(plugin) && plugin.enabled && plugin.status === "loaded"));
    });
    const descriptor = { nodeId: node.nodeId, computerUse };
    const providerGeneration = computerUse.provider.generation;
    let closed = false;
    let closing: Promise<void> | undefined;
    const activeBindings = new Set<{ close(reason: string): Promise<unknown> }>();
    const resourceBindingIsCurrent = () =>
      environmentIsCurrent() && (!privateNode || nodeTransport.isCurrent(privateNode));
    const bindingIsCurrent = () =>
      resourceBindingIsCurrent() &&
      getActivePluginGatewayNodePolicyRegistry() === registry &&
      policyOwners.every((isCurrent) => isCurrent()) &&
      (privateNode !== undefined ||
        context.nodeRegistry.get(node.nodeId)?.computerUse?.provider.generation ===
          providerGeneration);

    const parseRequest = (request: Parameters<ComputerToolTransport["invoke"]>[0]) => {
      if (request.nodeId !== node.nodeId) {
        throw new Error("Computer control is bound to this session's desktop");
      }
      const close =
        request.command === "computer.act" && request.commandParams.action === "__close_execution";
      const input = parseNodeWorkerComputerInput(
        JSON.stringify(
          close
            ? {
                operation: "close",
                executionId: request.commandParams.executionId,
                reason: request.commandParams.reason,
              }
            : {
                operation: request.command === "screen.snapshot" ? "snapshot" : "act",
                providerGeneration,
                params: request.commandParams,
              },
        ),
      );
      if (input.operation === "capabilities") {
        throw new Error("Session computer cannot request another capability probe");
      }
      return input;
    };

    const send = async (
      input: ReturnType<typeof parseRequest>,
      params: {
        timeoutMs?: number;
        signal?: AbortSignal;
        idempotencyKey?: string;
        isDispatchAuthorized: () => boolean;
        onDispatchReady?: (invokeId: string) => void;
      },
    ): Promise<InvokeResult> => {
      const isCurrent = () => resourceBindingIsCurrent() && params.isDispatchAuthorized();
      if (!isCurrent()) {
        throw new Error("Session computer authority closed before dispatch");
      }
      const command = input.operation === "snapshot" ? "screen.snapshot" : "computer.act";
      const commandParams =
        input.operation === "close"
          ? { action: "__close_execution", executionId: input.executionId, reason: input.reason }
          : input.params;
      return privateNode
        ? await nodeTransport.invoke({
            node: privateNode,
            command: NODE_WORKER_DESKTOP_COMPUTER_COMMAND,
            params: input,
            ...params,
            isDispatchAuthorized: isCurrent,
          })
        : await invokeNodeWithReadinessRetry(
            input.operation === "close"
              ? {
                  invoke: (request) =>
                    context.nodeRegistry.invokeLifecycle({
                      ...request,
                      isDispatchAuthorized: isCurrent,
                    }),
                }
              : context.nodeRegistry,
            {
              nodeId: node.nodeId,
              expectedConnId: node.connId,
              expectedPairingGeneration: node.pairingGeneration,
              command,
              params: commandParams,
              sessionKey: placement.sessionKey,
              ...params,
              isDispatchAuthorized: isCurrent,
            },
          );
    };

    return {
      descriptor,
      bind(operationalRunInstance) {
        const authority = getActiveAgentRunDelegatedAuthority(operationalRunInstance);
        if (!authority || operationalRunInstance.runId !== claim.runId) {
          throw new Error("Session computer requires the exact admitted run");
        }
        const identity: AgentRuntimeIdentity = {
          kind: "agentRuntime",
          agentId: placement.agentId,
          sessionKey: placement.sessionKey,
          operationalRunInstance,
          delegatedAuthority:
            claim.owner.kind === "worker"
              ? { ...authority, kind: "worker", turnClaim: claim }
              : { ...authority, kind: "local" },
        };
        // Tool construction can also build a schema-only projection. Only an actual
        // operation opens a binding; independent projections never retire the active tool.
        let execution: { logicalId: string; physicalId: string } | undefined;
        let bindingClosed = false;
        let bindingClosing: Promise<unknown> | undefined;
        const inFlight = new Set<Promise<unknown>>();
        const lifetime = new AbortController();
        const assertCurrent = () => {
          if (
            closed ||
            bindingClosed ||
            !bindingIsCurrent() ||
            !validateAgentRunDelegatedAuthority(authority)
          ) {
            throw new Error("Session computer run authority closed");
          }
          assertPlacement();
        };
        assertCurrent();
        const execute = async (
          input: Exclude<ReturnType<typeof parseRequest>, { operation: "close" }>,
          request: Pick<
            Parameters<ComputerToolTransport["invoke"]>[0],
            "timeoutMs" | "signal" | "idempotencyKey"
          >,
          assertAuthorized: (() => void) | undefined,
        ) => {
          // RPC tool grants can close independently of the run or placement.
          // Carry their exact authority through policy work and the final dispatch.
          const assertInvocationCurrent = () => {
            assertCurrent();
            assertAuthorized?.();
          };
          const command = input.operation === "snapshot" ? "screen.snapshot" : "computer.act";
          const commandParams = input.params;
          const isCurrent = () => {
            try {
              assertInvocationCurrent();
              return true;
            } catch {
              return false;
            }
          };
          assertInvocationCurrent();
          const signal = request.signal
            ? AbortSignal.any([request.signal, lifetime.signal])
            : lifetime.signal;
          const dispatch = async (
            params: Parameters<typeof send>[1] & { params: unknown },
          ): Promise<InvokeResult> => {
            const actual = parseNodeWorkerComputerInput(
              JSON.stringify({ ...input, params: params.params }),
            );
            if (
              actual.operation === "capabilities" ||
              actual.operation === "close" ||
              actual.params.executionId !== execution?.physicalId
            ) {
              throw new Error("Computer policy cannot replace the session execution owner");
            }
            return await send(actual, {
              timeoutMs: params.timeoutMs,
              signal: params.signal,
              idempotencyKey: params.idempotencyKey,
              isDispatchAuthorized: () => isCurrent() && params.isDispatchAuthorized(),
              onDispatchReady: params.onDispatchReady,
            });
          };
          const commandIsAllowed = () => {
            const currentNode = context.nodeRegistry.get(node.nodeId);
            const declaredCommands = privateNode
              ? [...COMPUTER_COMMANDS]
              : (currentNode?.commands ?? []);
            return isNodeCommandAllowed({
              command,
              declaredCommands,
              allowlist: resolveNodeCommandAllowlist(context.getRuntimeConfig(), {
                ...currentNode,
                approvedCommands: declaredCommands,
              }),
            }).ok;
          };
          const result = await applyPluginNodeInvokePolicy({
            context,
            client: null,
            agentRuntimeIdentity: identity,
            nodeSession: node,
            command,
            params: commandParams,
            sessionKey: placement.sessionKey,
            timeoutMs: request.timeoutMs,
            idempotencyKey: request.idempotencyKey,
            signal,
            isInvocationCurrent: isCurrent,
            isApprovalAuthorityActive: isCurrent,
            privateTransport: {
              ...(privateNode ? { commands: COMPUTER_COMMANDS } : {}),
              isCurrent,
              invoke: dispatch,
            },
          });
          assertInvocationCurrent();
          if (result) {
            if (!result.ok) {
              throw new Error(result.message ?? "Session computer action denied");
            }
            return result.payloadJSON ? JSON.parse(result.payloadJSON) : result.payload;
          }
          if ((privateNode && command === "computer.act") || !commandIsAllowed()) {
            throw new Error("Session computer command has no active policy or permission");
          }
          const raw = await dispatch({
            params: commandParams,
            timeoutMs: request.timeoutMs,
            signal,
            idempotencyKey: request.idempotencyKey,
            isDispatchAuthorized: () => isCurrent() && commandIsAllowed(),
          });
          assertInvocationCurrent();
          return payload(raw);
        };
        const binding = {
          close(reason: string): Promise<unknown> {
            if (bindingClosing) {
              return bindingClosing;
            }
            bindingClosed = true;
            lifetime.abort();
            bindingClosing = (async () => {
              await Promise.allSettled(inFlight);
              if (!execution || !resourceBindingIsCurrent()) {
                activeBindings.delete(binding);
                return { ok: true };
              }
              // Releasing an owned native execution survives input-policy revocation.
              // Only this fixed physical close crosses the lease/connection guard;
              // no plugin handler, caller override, approval, or input is revived.
              const result = await send(
                {
                  operation: "close",
                  executionId: execution.physicalId,
                  reason: reason.slice(0, 64),
                },
                { isDispatchAuthorized: resourceBindingIsCurrent },
              );
              if (!resourceBindingIsCurrent()) {
                throw new Error("Session computer cleanup owner changed");
              }
              const output = payload(result);
              activeBindings.delete(binding);
              return output;
            })();
            return bindingClosing;
          },
        };
        return {
          computerUse,
          async resolveNode(query, signal) {
            signal?.throwIfAborted();
            assertCurrent();
            if (query !== undefined && query !== node.nodeId) {
              throw new Error("Computer control is bound to this session's desktop");
            }
            return descriptor;
          },
          async invoke(request, assertAuthorized) {
            const input = parseRequest(request);
            const logicalId =
              input.operation === "close" ? input.executionId : input.params.executionId;
            if (execution && logicalId !== execution.logicalId) {
              throw new Error("Session computer execution owner changed");
            }
            if (input.operation === "close") {
              return binding.close(input.reason);
            }
            assertCurrent();
            request.signal?.throwIfAborted();
            // Remote execution IDs are correlation only. The Gateway alone mints
            // the native owner, so a copied UUID cannot join or close another binding.
            execution ??= { logicalId, physicalId: randomUUID() };
            activeBindings.add(binding);
            input.params.executionId = execution.physicalId;
            const operation = execute(input, request, assertAuthorized);
            inFlight.add(operation);
            void operation.finally(() => inFlight.delete(operation)).catch(() => {});
            return operation;
          },
        };
      },
      close(reason) {
        if (closing) {
          return closing;
        }
        closed = true;
        closing = (async () => {
          const results = await Promise.allSettled(
            [...activeBindings].map((binding) => binding.close(reason)),
          );
          const failures = results.filter((result) => result.status === "rejected");
          if (failures.length) {
            throw new AggregateError(
              failures.map((failure) => failure.reason),
              "Session computer cleanup failed",
            );
          }
        })();
        return closing;
      },
    };
  };
}

export function createWorkerComputerService(
  options: Parameters<typeof createWorkerComputerTransportOwner>[0] & {
    placements: Pick<
      WorkerSessionPlacementStore,
      "get" | "validateTurnClaim" | "registerTurnClaimClosedHandler"
    >;
  },
) {
  const create = createWorkerComputerTransportOwner(options);
  type Owner = {
    claimId: string;
    prepared: Promise<PreparedWorkerComputer | undefined>;
    transport?: WorkerComputerTransport;
    connection?: { signal: AbortSignal; abort: () => void };
    closeComputer?: PreparedWorkerComputer["close"];
    closing?: Promise<void>;
  };
  const owners = new Map<string, Owner>();
  const closeOwner = (owner: Owner, reason: string) => {
    if (owner.closing) {
      return owner.closing;
    }
    owner.transport = undefined;
    owner.connection?.signal.removeEventListener("abort", owner.connection.abort);
    // Fence this exact owner immediately, but retain cleanup custody until the
    // native ACK so concurrent claim closure or Gateway stop joins the same close.
    owner.closing = (async () => {
      try {
        await owner.prepared;
        await owner.closeComputer?.(reason);
      } finally {
        if (owners.get(owner.claimId) === owner) {
          owners.delete(owner.claimId);
        }
      }
    })();
    return owner.closing;
  };
  const unregister = options.placements.registerTurnClaimClosedHandler((claim) => {
    const owner = owners.get(claim.claimId);
    if (owner) {
      void closeOwner(owner, "turn-closed").catch(() =>
        options.warn("Session computer cleanup failed after turn closure."),
      );
    }
  });
  let stopped = false;
  return {
    prepare: (claim: WorkerSessionTurnClaim) => {
      if (stopped || !options.placements.validateTurnClaim(claim)) {
        return Promise.reject(new Error("Session computer owner closed"));
      }
      const prior = owners.get(claim.claimId);
      if (prior) {
        return prior.prepared;
      }
      const prepared = create(claim).then((computer) => {
        if (!computer) {
          return undefined;
        }
        owner.closeComputer = (reason) => computer.close(reason);
        const assertOwner = () => {
          if (stopped || owner.closing || owners.get(claim.claimId) !== owner) {
            throw new Error("Session computer owner replaced");
          }
        };
        return {
          ...computer,
          bind(run: OperationalRunInstanceRef) {
            assertOwner();
            const transport = computer.bind(run);
            const bound: WorkerComputerTransport = {
              computerUse: transport.computerUse,
              async resolveNode(query, signal) {
                assertOwner();
                const result = await transport.resolveNode(query, signal);
                assertOwner();
                return result;
              },
              async invoke(request, assertAuthorized) {
                assertOwner();
                const result = await transport.invoke(request, () => {
                  assertOwner();
                  assertAuthorized?.();
                });
                assertOwner();
                return result;
              },
            };
            owner.transport = bound;
            return bound;
          },
          close: (reason: string) => closeOwner(owner, reason),
        };
      });
      const owner: Owner = { claimId: claim.claimId, prepared };
      owners.set(claim.claimId, owner);
      return prepared;
    },
    execute: (async ({ identity, request, signal, assertCurrent }) => {
      assertCurrent();
      const claim = identity.turnClaim;
      const owner = claim ? owners.get(claim.claimId) : undefined;
      const computer = await owner?.prepared;
      assertCurrent();
      if (
        !computer ||
        !owner?.transport ||
        owner.closing ||
        owners.get(owner.claimId) !== owner ||
        !signal ||
        (owner.connection && owner.connection.signal !== signal)
      ) {
        throw new Error("Session computer connection is unavailable; start a new turn");
      }
      signal.throwIfAborted();
      if (!owner.connection) {
        // The worker socket owns input between requests too. Reconnects cannot
        // adopt this execution; Codex's local prepare/bind path has no socket owner.
        const abort = () => {
          void closeOwner(owner, "worker-disconnect").catch(() =>
            options.warn("Session computer cleanup failed after worker disconnect."),
          );
        };
        owner.connection = { signal, abort };
        signal.addEventListener("abort", abort, { once: true });
      }
      const result = await owner.transport.invoke(
        {
          nodeId: computer.descriptor.nodeId,
          command: request.command,
          commandParams: JSON.parse(request.paramsJson),
          timeoutMs: request.timeoutMs,
          idempotencyKey: request.idempotencyKey,
          signal,
        },
        assertCurrent,
      );
      assertCurrent();
      return { resultJson: JSON.stringify(result) };
    }) satisfies WorkerComputerExecutor,
    close: async () => {
      stopped = true;
      unregister();
      const results = await Promise.allSettled(
        [...owners.values()].map((owner) => closeOwner(owner, "gateway-stop")),
      );
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length) {
        throw new AggregateError(
          failures.map((failure) => failure.reason),
          "Session computer cleanup failed",
        );
      }
    },
  };
}
