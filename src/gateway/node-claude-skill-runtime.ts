import { Value } from "typebox/value";
import type { SkillResourceDelivery } from "../../packages/gateway-protocol/src/schema/skill-resources.js";
import {
  getAdmittedRunDelegatedAuthority,
  resolveAdmittedRunActiveAssertion,
} from "../agents/admitted-run-context.js";
import type { PreparedCliRunContext } from "../agents/cli-runner/types.js";
import type { AnyAgentTool } from "../agents/tools/common.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { registerAgentRunDelegatedAuthorityClosedHandler } from "../infra/agent-run-registry.js";
import {
  NODE_CLAUDE_SKILLS_CAPABILITY,
  NODE_CLAUDE_SKILLS_MESSAGE_BYTES,
  NODE_CLAUDE_WORKSHOP_CALL_BYTES,
  NODE_CLAUDE_WORKSHOP_RESULT_BYTES,
  NodeClaudeSkillUpstreamSchema,
  encodeNodeClaudeSkillMessage,
  type NodeClaudeSkillInit,
} from "../infra/node-claude-skill-protocol.js";
import { NODE_AGENT_CLI_CLAUDE_RUN_COMMAND } from "../infra/node-commands.js";
import { createNodeDuplexEndpoint } from "../infra/node-duplex-framing.js";
import { createPluginToolsMcpHandlers } from "../mcp/plugin-tools-handlers.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { prepareSkillResourceDelivery } from "../skills/runtime/resources.js";
import { buildMcpToolSchema } from "./mcp-http.schema.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "./node-command-policy.js";
import type { NodeRegistry, NodeSession } from "./node-registry.js";
import {
  isCurrentPlacementTurnClaim,
  type WorkerSessionTurnClaim,
} from "./worker-environments/placement-record.js";

export type NodeClaudeSkillRuntime = {
  node: NodeSession;
  init: NodeClaudeSkillInit;
  workshop?: AnyAgentTool;
  run: PreparedCliRunContext["params"];
  assertCurrent: () => void;
  signal: AbortSignal;
  close: () => void;
};

/** Captures the real session assignment, connection, and admitted owner before any file work. */
export async function prepareNodeClaudeSkillRuntime(
  context: PreparedCliRunContext,
  signal: AbortSignal,
): Promise<NodeClaudeSkillRuntime | undefined> {
  const run = context.params;
  if (
    run.controlOperation ||
    (!run.skillsSnapshot?.librarySelections?.length && !context.nodeSkillWorkshop)
  ) {
    return undefined;
  }
  const gateway = getPluginRuntimeGatewayRequestScope()?.context;
  const target = context.executionTarget;
  const node =
    target.kind === "node" ? gateway?.nodeRegistry.get(target.placement.nodeId) : undefined;
  if (!gateway || !node || !node.caps.includes(NODE_CLAUDE_SKILLS_CAPABILITY)) {
    throw new Error(
      "Paired node needs claude-cli-skills-v1. Upgrade OpenClaw on the paired node, restart its node host, and retry this turn.",
    );
  }
  const assertRun = resolveAdmittedRunActiveAssertion(run.admittedRunContext, signal);
  if (!assertRun || !run.sessionKey) {
    throw new Error("Paired-node skills require a live admitted session. Send a fresh message.");
  }
  const sessionScope = {
    sessionKey: run.sessionKey,
    agentId: run.agentId,
    storePath: run.storePath,
    hydrateSkillPromptRefs: false,
    readConsistency: "latest" as const,
  };
  const session = loadSessionEntryReadOnly(sessionScope);
  const connectionId = node.connId;
  const pairingGeneration = node.pairingGeneration;
  const caller = getGatewayToolCallerIdentity();
  const placements = gateway.workerSessionPlacementService;
  const readPlacement = () => placements?.getMany([run.sessionId]).get(run.sessionId);
  const placement = readPlacement();
  const persistedClaim = placement?.turnClaim;
  const claim: WorkerSessionTurnClaim | undefined =
    persistedClaim?.owner === "local"
      ? {
          sessionId: run.sessionId,
          claimId: persistedClaim.claimId,
          runId: persistedClaim.runId,
          placementGeneration: persistedClaim.generation,
          owner: {
            kind: "local",
            ...(placement?.environmentId && placement.activeOwnerEpoch !== null
              ? { environmentId: placement.environmentId, ownerEpoch: placement.activeOwnerEpoch }
              : {}),
          },
        }
      : undefined;
  const controller = new AbortController();
  const owner = getAdmittedRunDelegatedAuthority(run.admittedRunContext);
  const stop = registerAgentRunDelegatedAuthorityClosedHandler((closed) => {
    if (closed === owner) {
      controller.abort(new Error("Paired-node skill run authority closed."));
    }
  });
  const stopClaim =
    claim && placement
      ? placements?.registerTurnClaimClosedHandler?.((ended) => {
          if (ended.sessionId === run.sessionId && isCurrentPlacementTurnClaim(placement, ended)) {
            controller.abort(new Error("Paired-node skill placement claim closed."));
          }
        })
      : undefined;
  const combinedSignal = AbortSignal.any([signal, controller.signal]);
  let closed = false;
  const close = () => {
    closed = true;
    stop();
    stopClaim?.();
    controller.abort();
  };
  const assertCurrent = () => {
    assertRun();
    combinedSignal.throwIfAborted();
    const current = loadSessionEntryReadOnly(sessionScope);
    const currentPlacement = readPlacement();
    if (
      closed ||
      gateway.nodeRegistry.get(node.nodeId) !== node ||
      node.connId !== connectionId ||
      node.pairingGeneration !== pairingGeneration ||
      node.client.socket.readyState !== 1 ||
      !node.caps.includes(NODE_CLAUDE_SKILLS_CAPABILITY) ||
      !isNodeCommandAllowed({
        command: NODE_AGENT_CLI_CLAUDE_RUN_COMMAND,
        declaredCommands: node.commands,
        allowlist: resolveNodeCommandAllowlist(gateway.getRuntimeConfig(), {
          ...node,
          approvedCommands: node.commands,
        }),
      }).ok ||
      !session ||
      session.sessionId !== run.sessionId ||
      ((run.expectedLifecycleRevision ?? run.sessionEntry?.lifecycleRevision) !== undefined &&
        session.lifecycleRevision !==
          (run.expectedLifecycleRevision ?? run.sessionEntry?.lifecycleRevision)) ||
      current?.sessionId !== session.sessionId ||
      current.lifecycleRevision !== session.lifecycleRevision ||
      current.execHost !== "node" ||
      current.execNode?.trim() !== node.nodeId ||
      (current.execCwd?.trim() || undefined) !==
        (target.kind === "node" ? target.placement.cwd : undefined) ||
      (caller?.receiptAuthority && caller.receiptAuthority() === false) ||
      currentPlacement?.generation !== placement?.generation ||
      currentPlacement?.environmentId !== placement?.environmentId ||
      currentPlacement?.activeOwnerEpoch !== placement?.activeOwnerEpoch ||
      (placement &&
        (!claim ||
          !stopClaim ||
          claim.runId !== run.runId ||
          !currentPlacement ||
          !isCurrentPlacementTurnClaim(currentPlacement, claim)))
    ) {
      throw new Error(
        "Paired-node skill assignment or run authority changed. Retry from a fresh turn.",
      );
    }
  };
  try {
    assertCurrent();
    const resources: SkillResourceDelivery | undefined = run.skillsSnapshot?.librarySelections
      ?.length
      ? await prepareSkillResourceDelivery(run.skillsSnapshot, assertCurrent)
      : undefined;
    assertCurrent();
    const workshop = context.nodeSkillWorkshop;
    const descriptor = workshop ? buildMcpToolSchema([workshop])[0] : undefined;
    const init: NodeClaudeSkillInit = {
      type: "init",
      ...(resources ? { resources } : {}),
      ...(descriptor
        ? {
            workshop: {
              description: descriptor.description ?? "",
              inputSchema: descriptor.inputSchema,
            },
          }
        : {}),
    };
    encodeNodeClaudeSkillMessage(init, NODE_CLAUDE_SKILLS_MESSAGE_BYTES);
    return { node, run, init, workshop, assertCurrent, signal: combinedSignal, close };
  } catch (error) {
    close();
    throw error;
  }
}

/** One invocation owns resource delivery, stdout, and host-only Workshop callbacks. */
export async function invokeNodeClaudeSkillRuntime(params: {
  registry: NodeRegistry;
  invocation: Parameters<NodeRegistry["invoke"]>[0];
  runtime: NodeClaudeSkillRuntime;
  onProgress: (chunk: string) => void;
}) {
  const { runtime, registry } = params;
  runtime.assertCurrent();
  const controller = new AbortController();
  const signal = AbortSignal.any([runtime.signal, controller.signal]);
  let invokeId: string | undefined;
  let open = true;
  const assertCurrent = () => {
    runtime.assertCurrent();
    signal.throwIfAborted();
    if (
      !open ||
      !invokeId ||
      !registry.isInvokeCurrent(invokeId, runtime.node.nodeId, runtime.node.connId)
    ) {
      throw new Error("Paired-node Workshop invocation is no longer active.");
    }
  };
  const identity = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: runtime.run.admittedRunContext,
    agentId: runtime.run.agentId,
    sessionKey: runtime.run.sessionKey,
    // This same closure reaches the library's synchronous pre-commit guard.
    receiptAuthority: assertCurrent,
  });
  const handlers = createPluginToolsMcpHandlers(runtime.workshop ? [runtime.workshop] : []);
  const calls = new Set<string>();
  const callbacks = new Set<Promise<void>>();
  const endpoint = createNodeDuplexEndpoint({
    requireReady: true,
    maxMessageBytes: NODE_CLAUDE_SKILLS_MESSAGE_BYTES,
    sendFrame(frame) {
      assertCurrent();
      registry.sendInvokeInput(invokeId!, JSON.parse(frame));
    },
    onReady() {
      assertCurrent();
      void endpoint
        .send(encodeNodeClaudeSkillMessage(runtime.init, NODE_CLAUDE_SKILLS_MESSAGE_BYTES))
        .catch((error: unknown) => controller.abort(error));
    },
    onError: (error) => controller.abort(error),
  });
  const receive = async (bytes: Uint8Array) => {
    assertCurrent();
    if (bytes.byteLength > NODE_CLAUDE_WORKSHOP_CALL_BYTES) {
      throw new Error("Paired-node Workshop request exceeds its limit.");
    }
    const message: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    if (!Value.Check(NodeClaudeSkillUpstreamSchema, message)) {
      throw new Error("Invalid paired-node skill message.");
    }
    if (message.type === "stdout") {
      params.onProgress(message.text);
      return;
    }
    if (!runtime.workshop || !identity || calls.has(message.id) || calls.size >= 64) {
      throw new Error(
        "Paired-node Workshop callback is unavailable or already consumed. Send a fresh message.",
      );
    }
    calls.add(message.id);
    const result = await withGatewayToolCallerIdentity(identity, () =>
      handlers.callTool({ name: "skill_workshop", arguments: message.arguments }, signal),
    );
    assertCurrent();
    await endpoint.send(
      encodeNodeClaudeSkillMessage(
        { type: "result", id: message.id, result },
        NODE_CLAUDE_WORKSHOP_RESULT_BYTES,
      ),
    );
  };
  endpoint.onMessage((bytes) => {
    const callback = receive(bytes).finally(() => callbacks.delete(callback));
    callbacks.add(callback);
    return callback;
  });
  const abort = () => endpoint.close();
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await registry.invoke({
      ...params.invocation,
      signal,
      expectedConnId: runtime.node.connId,
      expectedPairingGeneration: runtime.node.pairingGeneration,
      isDispatchAuthorized: () => {
        runtime.assertCurrent();
        return !signal.aborted;
      },
      onDispatchReady: (id) => {
        invokeId = id;
      },
      onProgress: (chunk) => {
        assertCurrent();
        endpoint.receive(chunk);
      },
    });
  } finally {
    // Revoke synchronously before awaiting any callback or artifact cleanup.
    open = false;
    controller.abort();
    signal.removeEventListener("abort", abort);
    endpoint.close();
    await Promise.allSettled(callbacks);
  }
}
