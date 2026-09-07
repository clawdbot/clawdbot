import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../agents/admitted-run-context.js";
import type { PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { OpenClawPluginNodeInvokePolicyContext } from "../plugins/types.js";
import { createTestApprovalManager } from "./exec-approval-manager.test-support.js";
import {
  applyPluginNodeInvokePolicy,
  type PluginNodeInvokePrivateTransport,
} from "./node-invoke-plugin-policy.js";
import {
  createApprovalClientLookup,
  createContext,
  createDemoPolicy,
  createNodeSession,
  createOperatorClient,
  DEMO_COMMAND,
  DEMO_PARAMS,
  expectSinglePendingApproval,
  nodeCommandsConfig,
  setDangerousDemoCommandRegistry,
} from "./node-invoke-plugin-policy.test-helpers.js";

function createPrivateTransport() {
  const invoke = vi.fn<PluginNodeInvokePrivateTransport["invoke"]>(async (request) => {
    request.onDispatchReady("private-invoke");
    return { ok: true, payload: { completed: true } };
  });
  return {
    commands: [DEMO_COMMAND],
    isCurrent: (): boolean => true,
    invoke,
  } satisfies PluginNodeInvokePrivateTransport;
}

describe("private node policy transport", () => {
  beforeEach(resetPluginRuntimeStateForTest);
  afterEach(resetPluginRuntimeStateForTest);

  it("uses the registered risk and approval policy without advertising the private capability", async (testContext) => {
    const manager = createTestApprovalManager<PluginApprovalRequestPayload>(testContext, {
      approvalKind: "plugin",
    });
    const reviewer = createOperatorClient();
    const handle = vi.fn(async (policyContext: OpenClawPluginNodeInvokePolicyContext) => {
      expect(policyContext.risk).toEqual({ level: "high", family: "fixture_mutation" });
      const decision = await policyContext.approvals?.request({
        title: "Private desktop action",
        description: "Approve this action on the selected session desktop",
      });
      if (decision?.decision !== "allow-once") {
        return { ok: false as const, message: "approval required" };
      }
      return await policyContext.invokeNode();
    });
    const registration = createDemoPolicy(handle);
    registration.policy.classifyRisk = vi.fn<NonNullable<typeof registration.policy.classifyRisk>>(
      () => ({ level: "high", family: "fixture_mutation" }),
    );
    setDangerousDemoCommandRegistry([registration]);
    const node = createNodeSession();
    node.commands = [];
    const { context, invoke } = createContext({
      nodeSession: node,
      pluginApprovalManager: manager,
      getApprovalClientConnIds: createApprovalClientLookup([reviewer]),
    });
    const privateTransport = createPrivateTransport();
    const onNodeCommandDispatched = vi.fn();
    const result = applyPluginNodeInvokePolicy({
      context,
      client: reviewer,
      nodeSession: node,
      command: DEMO_COMMAND,
      params: DEMO_PARAMS,
      privateTransport,
      onNodeCommandDispatched,
    });

    const approval = await expectSinglePendingApproval(manager);
    expect(privateTransport.invoke).not.toHaveBeenCalled();
    expect(manager.resolve(approval.id, "allow-once")).toBe(true);
    await expect(result).resolves.toMatchObject({ ok: true, payload: { completed: true } });
    expect(registration.policy.classifyRisk).toHaveBeenCalledOnce();
    expect(handle).toHaveBeenCalledOnce();
    expect(privateTransport.invoke).toHaveBeenCalledOnce();
    expect(onNodeCommandDispatched).toHaveBeenCalledOnce();
    expect(manager.getSnapshot(approval.id)?.consumedDecision).toBe("allow-once");
    expect(node.commands).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["missing-policy", "invalid-risk"] as const)(
    "rejects private dispatch before the policy handler for %s",
    async (failure) => {
      const handle = vi.fn((ctx: OpenClawPluginNodeInvokePolicyContext) => ctx.invokeNode());
      const registration = createDemoPolicy(handle);
      registration.policy.classifyRisk = () => {
        throw new Error("invalid private action");
      };
      setDangerousDemoCommandRegistry(failure === "missing-policy" ? [] : [registration]);
      const { context, invoke } = createContext();
      const privateTransport = createPrivateTransport();

      await expect(
        applyPluginNodeInvokePolicy({
          context,
          client: null,
          nodeSession: createNodeSession(),
          command: DEMO_COMMAND,
          params: DEMO_PARAMS,
          privateTransport,
        }),
      ).resolves.toMatchObject({
        ok: false,
        code:
          failure === "missing-policy"
            ? "PLUGIN_POLICY_MISSING"
            : "PLUGIN_POLICY_RISK_CLASSIFICATION_FAILED",
        details: { nodeCommandDispatched: false },
      });
      expect(handle).not.toHaveBeenCalled();
      expect(privateTransport.invoke).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it.each([
    "owner",
    "plugin",
    "deny",
    "capability",
    "connection",
    "pairing",
    "approval",
    "runtime",
  ] as const)("rejects private dispatch when %s changes during policy work", async (change) => {
    const node = createNodeSession();
    node.commands = [];
    let runtimeCurrent = true;
    let approvalCurrent = true;
    const { context, invoke } = createContext({
      nodeSession: node,
      validateAgentRuntimeApprovalAuthority: () => runtimeCurrent,
    });
    const privateTransport = createPrivateTransport();
    setDangerousDemoCommandRegistry([
      createDemoPolicy(async (ctx) => {
        await Promise.resolve();
        switch (change) {
          case "owner":
            privateTransport.isCurrent = () => false;
            break;
          case "plugin":
            setActivePluginRegistry(createEmptyPluginRegistry());
            break;
          case "deny":
            context.getRuntimeConfig = () => nodeCommandsConfig({ deny: [DEMO_COMMAND] });
            break;
          case "capability":
            privateTransport.commands = [];
            break;
          case "connection":
            context.nodeRegistry.get = () => ({ ...node, connId: "replacement" });
            break;
          case "pairing":
            node.client.invalidated = true;
            break;
          case "approval":
            approvalCurrent = false;
            break;
          case "runtime":
            runtimeCurrent = false;
            break;
        }
        return await ctx.invokeNode();
      }),
    ]);
    const operationalRunInstance = createOperationalRunInstanceRef("private-policy-run");

    await expect(
      applyPluginNodeInvokePolicy({
        context,
        client: {
          ...createOperatorClient(),
          internal: {
            agentRuntimeIdentity: {
              kind: "agentRuntime",
              agentId: "main",
              sessionKey: "agent:main:private-policy",
              operationalRunInstance,
              delegatedAuthority: {
                kind: "local",
                operationalRunInstance,
                lifecycleGeneration: "generation",
                claimId: "claim",
              },
            },
          },
        },
        nodeSession: node,
        command: DEMO_COMMAND,
        params: DEMO_PARAMS,
        privateTransport,
        isApprovalAuthorityActive: () => approvalCurrent,
      }),
    ).resolves.toMatchObject({ ok: false, details: { nodeCommandDispatched: false } });
    expect(privateTransport.invoke).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(["owner", "plugin", "deny", "approval"] as const)(
    "carries the %s gate through the private transport's final send",
    async (change) => {
      setDangerousDemoCommandRegistry([createDemoPolicy((ctx) => ctx.invokeNode())]);
      const node = createNodeSession();
      node.commands = [];
      const { context, invoke } = createContext({ nodeSession: node });
      const privateTransport = createPrivateTransport();
      let approvalCurrent = true;
      const execute = vi.fn();
      privateTransport.invoke.mockImplementationOnce(async (request) => {
        await Promise.resolve();
        if (change === "owner") {
          privateTransport.isCurrent = () => false;
        } else if (change === "plugin") {
          setActivePluginRegistry(createEmptyPluginRegistry());
        } else if (change === "deny") {
          context.getRuntimeConfig = () => nodeCommandsConfig({ deny: [DEMO_COMMAND] });
        } else {
          approvalCurrent = false;
        }
        if (!request.isDispatchAuthorized()) {
          return { ok: false, error: { code: "REVOKED", message: "private dispatch revoked" } };
        }
        execute();
        request.onDispatchReady("private-invoke");
        return { ok: true };
      });
      const onNodeCommandDispatched = vi.fn();

      await expect(
        applyPluginNodeInvokePolicy({
          context,
          client: null,
          nodeSession: node,
          command: DEMO_COMMAND,
          params: DEMO_PARAMS,
          privateTransport,
          isApprovalAuthorityActive: () => approvalCurrent,
          onNodeCommandDispatched,
        }),
      ).resolves.toMatchObject({
        ok: false,
        code: "REVOKED",
        details: { nodeCommandDispatched: false },
      });
      expect(execute).not.toHaveBeenCalled();
      expect(onNodeCommandDispatched).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalled();
    },
  );
});
