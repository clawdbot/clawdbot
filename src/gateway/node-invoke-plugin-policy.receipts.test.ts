import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import { configureRuntimeActionDecisionSink } from "../audit/runtime-action-decision.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { OpenClawPluginNodeInvokePolicyContext } from "../plugins/types.js";
import { applyPluginNodeInvokePolicy } from "./node-invoke-plugin-policy.js";
import type { NodeInvokeResult, NodeSession } from "./node-registry.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";

const PLUGIN_ID = "secret-demo-plugin";
const COMMAND = "secret.demo.read";

function createNode(commands = [COMMAND]): NodeSession {
  return {
    nodeId: "secret-node-id",
    connId: "conn-1",
    client: {} as NodeSession["client"],
    declaredCaps: [],
    caps: [],
    declaredCommands: commands,
    commands,
    declaredNodePluginTools: [],
    nodePluginTools: [],
    nodeSkills: [],
    connectedAtMs: 0,
  };
}

function createClient(runId: string, pluginRuntimeAuthority?: () => boolean): GatewayClient {
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  return {
    connId: "caller-conn",
    connect: { client: { id: "caller" }, scopes: ["operator.admin"] },
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "agent:main:test",
        operationalRunInstance,
        delegatedAuthority: {
          kind: "local",
          operationalRunInstance,
          lifecycleGeneration: "test-generation",
          claimId: "test-claim",
        },
        executionIdentity: createExecutionIdentityAdmissionToken(runId, {
          contextId: `context-${runId}`,
          executionId: `execution-${runId}`,
          now: 100,
        }),
      },
      ...(pluginRuntimeAuthority
        ? { pluginRuntimeOwnerId: PLUGIN_ID, pluginRuntimeAuthority }
        : {}),
    },
  } as unknown as GatewayClient;
}

function registerPolicy(handle: PluginRegistry["nodeInvokePolicies"][number]["policy"]["handle"]) {
  const registry = createEmptyPluginRegistry();
  registry.nodeInvokePolicies.push({
    pluginId: PLUGIN_ID,
    policy: { commands: [COMMAND], handle },
    pluginConfig: {},
    source: "test",
  });
  setActivePluginRegistry(registry);
}

function createContext(node: NodeSession) {
  const invoke = vi.fn(
    async (params?: {
      onDispatchReady?: (invokeId: string) => void;
    }): Promise<NodeInvokeResult> => {
      params?.onDispatchReady?.("invoke-1");
      return { ok: true, payload: { ok: true }, payloadJSON: null, error: null };
    },
  );
  return {
    invoke,
    context: {
      getRuntimeConfig: () => ({ gateway: { nodes: { commands: { allow: [COMMAND] } } } }),
      nodeRegistry: { get: () => node, invoke },
      validateAgentRuntimeApprovalAuthority: () => true,
    } as unknown as GatewayRequestContext,
  };
}

async function runPolicy(node = createNode()) {
  const { context, invoke } = createContext(node);
  const receipts: DecisionReceiptV1[] = [];
  const clear = configureRuntimeActionDecisionSink((receipt) => {
    receipts.push(receipt);
    return true;
  });
  try {
    const result = await applyPluginNodeInvokePolicy({
      context,
      client: createClient("run-node-receipt"),
      nodeSession: node,
      command: COMMAND,
      params: { private: "arguments" },
    });
    return { result, receipts, invoke };
  } finally {
    clear();
  }
}

describe("plugin node action receipts", () => {
  beforeEach(resetPluginRuntimeStateForTest);
  afterEach(resetPluginRuntimeStateForTest);

  it("records gate enforcement and successful action as attribution only", async () => {
    registerPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) => ctx.invokeNode());
    const { result, receipts } = await runPolicy();
    expect(result).toMatchObject({ ok: true });
    expect(receipts).toMatchObject([
      {
        decision: { outcome: "allowed", reasonCode: "node_dispatch_gate_allowed" },
        enforcement: { coverageState: "enforced" },
      },
      {
        decision: { outcome: "allowed", reasonCode: "node_action_completed" },
        enforcement: { coverageState: "attribution-only" },
      },
    ]);
    const serialized = JSON.stringify(receipts);
    expect(serialized).not.toContain(PLUGIN_ID);
    expect(serialized).not.toContain(COMMAND);
    expect(serialized).not.toContain("secret-node-id");
  });

  it("records unknown when the policy omits the expected node callback", async () => {
    registerPolicy(async () => ({ ok: true, payload: "done" }));
    const { receipts, invoke } = await runPolicy();
    expect(invoke).not.toHaveBeenCalled();
    expect(receipts).toMatchObject([
      {
        decision: { outcome: "unknown", reasonCode: "node_action_callback_missing" },
        enforcement: { coverageState: "unknown" },
        missingEvidence: ["node.action_callback"],
      },
    ]);
  });

  it("records node capability denial at the owning dispatch gate", async () => {
    registerPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) => ctx.invokeNode());
    const { result, receipts, invoke } = await runPolicy(createNode([]));
    expect(result).toMatchObject({ ok: false, code: "NODE_COMMAND_REVOKED" });
    expect(invoke).not.toHaveBeenCalled();
    expect(receipts).toMatchObject([
      {
        decision: { outcome: "denied", reasonCode: "node_command_revoked" },
        enforcement: { coverageState: "enforced" },
      },
    ]);
  });

  it("rejects plugin dispatch when lifecycle authority closes during pairing recheck", async () => {
    registerPolicy((ctx: OpenClawPluginNodeInvokePolicyContext) => ctx.invokeNode());
    const node = createNode();
    const { context, invoke } = createContext(node);
    let authorityActive = true;
    let releasePairingCheck!: () => void;
    const pairingCheck = new Promise<void>((resolve) => {
      releasePairingCheck = resolve;
    });
    const resultPromise = applyPluginNodeInvokePolicy({
      context,
      client: createClient("run-node-plugin-authority", () => authorityActive),
      nodeSession: node,
      command: COMMAND,
      params: { private: "arguments" },
      isInvocationCurrent: async () => {
        await pairingCheck;
        return true;
      },
    });
    await Promise.resolve();
    authorityActive = false;
    releasePairingCheck();

    await expect(resultPromise).resolves.toMatchObject({
      ok: false,
      code: "APPROVAL_AUTHORITY_CLOSED",
      details: { nodeCommandDispatched: false },
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["allowed", "denied", "throws"] as const)(
    "does not attribute a late %s policy result after runtime authority closes",
    async (outcome) => {
      let releasePolicy: (() => void) | undefined;
      let markPolicyStarted: (() => void) | undefined;
      const policyStarted = new Promise<void>((resolve) => {
        markPolicyStarted = resolve;
      });
      const policyWait = new Promise<void>((resolve) => {
        releasePolicy = resolve;
      });
      registerPolicy(async () => {
        markPolicyStarted?.();
        await policyWait;
        if (outcome === "throws") {
          throw new Error("late policy failure");
        }
        return outcome === "allowed"
          ? { ok: true, payload: "done" }
          : { ok: false, code: "PLUGIN_DENIED", message: "denied" };
      });
      const node = createNode();
      let authorityActive = true;
      const { context, invoke } = createContext(node);
      context.validateAgentRuntimeApprovalAuthority = () => authorityActive;
      const receipts: DecisionReceiptV1[] = [];
      const clear = configureRuntimeActionDecisionSink((receipt) => {
        receipts.push(receipt);
        return true;
      });
      try {
        const resultPromise = applyPluginNodeInvokePolicy({
          context,
          client: createClient(`run-node-policy-${outcome}`),
          nodeSession: node,
          command: COMMAND,
          params: { private: "arguments" },
        });
        await policyStarted;
        authorityActive = false;
        releasePolicy?.();

        if (outcome === "throws") {
          await expect(resultPromise).rejects.toThrow("late policy failure");
        } else {
          await expect(resultPromise).resolves.toMatchObject({ ok: outcome === "allowed" });
        }
        expect(invoke).not.toHaveBeenCalled();
        expect(receipts).toEqual([]);
      } finally {
        clear();
      }
    },
  );
});
