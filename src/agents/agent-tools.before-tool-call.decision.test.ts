import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DecisionReceiptV1 } from "../../packages/gateway-protocol/src/index.js";
import type { ExecutionDecisionWork } from "../audit/execution-decision-work.js";
import { configureExecutionDecisionWorkSink } from "../audit/execution-decision-work.js";
import { createExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import { configureRuntimeActionDecisionSink } from "../audit/runtime-action-decision.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { addTestHook } from "../plugins/hooks.test-fixtures.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { setPluginToolMeta } from "../plugins/tool-metadata.js";
import type { PluginHookRegistration } from "../plugins/types.js";
import { toToolDefinitions } from "./agent-tool-definition-adapter.js";
import {
  bindAssembledAgentToolActionDescriptor,
  copyAgentToolMetadata,
} from "./agent-tool-metadata.js";
import { markToolDecisionRecorded } from "./agent-tools.before-tool-call.decision.js";
import { wrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.js";
import { createCoreCodingTools } from "./core-coding-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";
import { getInternalToolExecutionPreparer } from "./runtime/internal-hooks.js";
import { wrapToolDefinition } from "./sessions/tools/tool-definition-wrapper.js";
import type { AnyAgentTool } from "./tools/common.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

function assembledTool(
  kind: "data" | "tool",
  name: string,
  execute: AnyAgentTool["execute"],
): AnyAgentTool {
  const source = createCoreCodingTools({
    codingRoot: process.cwd(),
    containmentRoot: process.cwd(),
    includeBaseCodingTools: kind === "data",
    includeShellTools: kind === "tool",
    workspaceOnly: false,
    readOnly: false,
    applyPatchEnabled: false,
    applyPatchWorkspaceOnly: true,
    execDefaults: {},
    processDefaults: { scopeKey: "c02-test" },
  }).find((tool) => tool.name === (kind === "data" ? "read" : "exec"));
  if (!source) {
    throw new Error(`missing assembled ${kind} tool`);
  }
  return copyAgentToolMetadata(source, { ...source, name, execute });
}

function assembledPluginTool(params: {
  pluginId: string;
  manifestKind?: "memory";
  execute: AnyAgentTool["execute"];
}): AnyAgentTool {
  const source: AnyAgentTool = {
    name: "owner_declared_name",
    label: "Owner tool",
    description: "Owner tool",
    parameters: { type: "object", properties: {} },
    execute: params.execute,
  };
  setPluginToolMeta(source, {
    pluginId: params.pluginId,
    ...(params.manifestKind ? { kind: params.manifestKind } : {}),
    optional: false,
  });
  bindAssembledAgentToolActionDescriptor(source);
  return copyAgentToolMetadata(source, { ...source, name: "arbitrarily_renamed_owner_tool" });
}

function admittedRun(params: {
  works: ExecutionDecisionWork[];
  authority?: () => boolean | void;
  run: () => Promise<unknown>;
}) {
  const token = createExecutionIdentityAdmissionToken("c02-tool-run", {
    contextId: "c02-tool-context",
    executionId: "c02-tool-execution",
    now: 100,
  });
  const clear = configureExecutionDecisionWorkSink((work) => {
    params.works.push(work);
    return true;
  });
  return withGatewayToolCallerIdentity(
    {
      agentId: "main",
      sessionKey: "agent:main:c02",
      executionIdentityToken: token,
      receiptAuthority: params.authority ?? (() => true),
    },
    params.run,
  ).finally(clear);
}

describe("generic tool action decision receipts", () => {
  beforeEach(() => {
    resetGlobalHookRunner();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });

  afterEach(() => {
    resetGlobalHookRunner();
    setActivePluginRegistry(createEmptyPluginRegistry());
    vi.restoreAllMocks();
  });

  it.each([
    { kind: "data", family: "data", operation: "filesystem" },
    { kind: "tool", family: "tool", operation: "process" },
  ] as const)(
    "records ordinary $kind execution as private attribution independent of name and payload",
    async ({ kind, family, operation }) => {
      vi.spyOn(Date, "now").mockReturnValue(250);
      const works: ExecutionDecisionWork[] = [];
      const execute = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "SECRET_RESULT" }],
        details: { path: "/private/result" },
      });
      const tool = wrapToolWithBeforeToolCallHook(
        assembledTool(kind, "renamed_private_tool", execute),
      );

      await admittedRun({
        works,
        run: () => tool.execute("same-call", { path: "/private/input" }),
      });

      expect(works).toHaveLength(1);
      expect(works[0]).toMatchObject({
        token: {
          contextId: "c02-tool-context",
          executionId: "c02-tool-execution",
          runId: "c02-tool-run",
        },
        receipt: {
          occurredAt: 250,
          action: { family, operation },
          decision: { outcome: "allowed", reasonCode: "generic_action_attributed" },
          enforcement: { coverageState: "attribution-only" },
          source: { owner: "tool-action" },
        },
      });
      expect(works[0]?.refs).toBeUndefined();
      const encoded = JSON.stringify(works);
      expect(encoded).not.toContain("renamed_private_tool");
      expect(encoded).not.toContain("/private/input");
      expect(encoded).not.toContain("SECRET_RESULT");
      expect(encoded).not.toContain("/private/result");
    },
  );

  it.each([
    {
      label: "memory manifest kind",
      pluginId: "arbitrary-memory-owner",
      manifestKind: "memory",
      family: "data",
      operation: "memory",
    },
    {
      label: "browser plugin without a canonical generic kind",
      pluginId: "arbitrary-browser-owner",
      manifestKind: undefined,
      family: "tool",
      operation: "openclaw",
    },
  ] as const)("classifies $label independently of plugin and tool names", async (entry) => {
    const works: ExecutionDecisionWork[] = [];
    const tool = wrapToolWithBeforeToolCallHook(
      assembledPluginTool({
        pluginId: entry.pluginId,
        ...(entry.manifestKind ? { manifestKind: entry.manifestKind } : {}),
        execute: vi.fn().mockResolvedValue({ content: [], details: { ok: true } }),
      }),
    );

    await admittedRun({ works, run: () => tool.execute("plugin-call", {}) });

    expect(works).toHaveLength(1);
    expect(works[0]?.receipt.action).toMatchObject({
      family: entry.family,
      operation: entry.operation,
    });
    expect(JSON.stringify(works)).not.toMatch(/arbitrary|owner_declared|renamed/u);
  });

  it("records a Gateway-shaped tool assembled without its first hook wrapper", async () => {
    const source = createOpenClawTools({
      disablePluginTools: true,
      wrapBeforeToolCallHook: false,
    }).find((tool) => tool.name === "sessions_list");
    if (!source) {
      throw new Error("missing Gateway-shaped sessions_list tool");
    }
    const works: ExecutionDecisionWork[] = [];
    const tool = wrapToolWithBeforeToolCallHook(
      copyAgentToolMetadata(source, {
        ...source,
        execute: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "SECRET_GATEWAY_RESULT" }],
          details: { path: "/private/gateway-result" },
        }),
      }),
    );

    await admittedRun({
      works,
      run: () => tool.execute("gateway-call", { path: "/private/gateway-input" }),
    });

    expect(works).toHaveLength(1);
    expect(works[0]?.receipt).toMatchObject({
      action: { family: "tool", operation: "openclaw" },
      decision: { outcome: "allowed", reasonCode: "generic_action_attributed" },
      enforcement: { coverageState: "attribution-only" },
    });
    expect(JSON.stringify(works)).not.toMatch(/sessions_list|SECRET_GATEWAY|private\/gateway/u);
  });

  it("keeps an execution failure separate from its generic decision", async () => {
    const works: ExecutionDecisionWork[] = [];
    const tool = wrapToolWithBeforeToolCallHook(
      assembledTool(
        "data",
        "throws_after_admission",
        vi.fn().mockRejectedValue(new Error("SECRET")),
      ),
    );

    await expect(
      admittedRun({
        works,
        run: () => tool.execute("failed-call", { secret: "PRIVATE" }),
      }),
    ).rejects.toThrow("SECRET");

    expect(works).toHaveLength(1);
    expect(works[0]?.receipt.decision).toEqual({
      outcome: "allowed",
      reasonCode: "generic_action_attributed",
    });
    expect(JSON.stringify(works)).not.toMatch(/SECRET|PRIVATE/u);
  });

  it("records a generic trusted-policy veto as enforced without owner prose", async () => {
    const registry = createEmptyPluginRegistry();
    registry.trustedToolPolicies = [
      {
        pluginId: "SECRET_PLUGIN",
        source: "test",
        policy: {
          id: "SECRET_POLICY",
          description: "private policy",
          evaluate: () => ({ block: true, blockReason: "SECRET_REASON" }),
        },
      },
    ];
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    const works: ExecutionDecisionWork[] = [];
    const execute = vi.fn();
    const tool = wrapToolWithBeforeToolCallHook(assembledTool("data", "policy_subject", execute));

    const result = await admittedRun({
      works,
      run: () => tool.execute("blocked-call", {}),
    });

    expect(result).toMatchObject({ details: { status: "blocked" } });
    expect(execute).not.toHaveBeenCalled();
    expect(works).toHaveLength(1);
    expect(works[0]?.receipt).toMatchObject({
      decision: { outcome: "denied", reasonCode: "generic_action_policy_denied" },
      enforcement: { coverageState: "enforced" },
      source: { owner: "tool-action" },
    });
    expect(JSON.stringify(works)).not.toMatch(/SECRET_PLUGIN|SECRET_POLICY|SECRET_REASON/u);
  });

  it("does not duplicate a normal plugin-hook decision", async () => {
    const registry = createEmptyPluginRegistry();
    addTestHook({
      registry,
      pluginId: "owner-plugin",
      hookName: "before_tool_call",
      handler: (() => ({
        block: true,
        blockReason: "owned denial",
      })) as PluginHookRegistration["handler"],
    });
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    const works: ExecutionDecisionWork[] = [];
    const ownerReceipts: DecisionReceiptV1[] = [];
    const clearOwnerSink = configureRuntimeActionDecisionSink((receipt) => {
      ownerReceipts.push(receipt);
      return true;
    });
    const tool = wrapToolWithBeforeToolCallHook(assembledTool("data", "hook_subject", vi.fn()));

    try {
      await admittedRun({ works, run: () => tool.execute("hook-call", {}) });
    } finally {
      clearOwnerSink();
    }

    expect(works).toEqual([]);
    expect(ownerReceipts).toHaveLength(1);
    expect(ownerReceipts[0]).toMatchObject({
      decision: { outcome: "denied", reasonCode: "plugin_hook_blocked" },
      source: { owner: "plugin-hook" },
    });
  });

  it.each([
    {
      label: "returns adjusted params",
      result: { params: { ownerAdjusted: true } },
      matcher: undefined,
      toolName: undefined,
      expectedHandlerCalls: 1,
      expectedGenericReceipts: 0,
      expectedOwnerReceipts: 1,
    },
    {
      label: "returns void",
      result: undefined,
      matcher: undefined,
      toolName: undefined,
      expectedHandlerCalls: 1,
      expectedGenericReceipts: 0,
      expectedOwnerReceipts: 1,
    },
    {
      label: "does not match the tool",
      result: undefined,
      matcher: ["exec"],
      toolName: "read",
      expectedHandlerCalls: 0,
      expectedGenericReceipts: 1,
      expectedOwnerReceipts: 0,
    },
  ] as const)(
    "routes generic attribution only when a plugin hook $label",
    async ({ result, ...testCase }) => {
      const registry = createEmptyPluginRegistry();
      const handler = vi.fn(() => result);
      addTestHook({
        registry,
        pluginId: "owner-plugin",
        hookName: "before_tool_call",
        handler: handler as PluginHookRegistration["handler"],
        ...(testCase.matcher ? { matcher: [...testCase.matcher] } : {}),
      });
      setActivePluginRegistry(registry);
      initializeGlobalHookRunner(registry);
      const works: ExecutionDecisionWork[] = [];
      const ownerReceipts: DecisionReceiptV1[] = [];
      const clearOwnerSink = configureRuntimeActionDecisionSink((receipt) => {
        ownerReceipts.push(receipt);
        return true;
      });
      const tool = wrapToolWithBeforeToolCallHook(
        assembledTool(
          "data",
          testCase.toolName ?? "hook_allow_subject",
          vi.fn().mockResolvedValue({ content: [] }),
        ),
      );

      try {
        await admittedRun({ works, run: () => tool.execute("hook-allow-call", {}) });
      } finally {
        clearOwnerSink();
      }

      expect(handler).toHaveBeenCalledTimes(testCase.expectedHandlerCalls);
      expect(works).toHaveLength(testCase.expectedGenericReceipts);
      expect(ownerReceipts).toHaveLength(testCase.expectedOwnerReceipts);
      if (testCase.expectedGenericReceipts === 1) {
        expect(works[0]?.receipt).toMatchObject({
          decision: { outcome: "allowed", reasonCode: "generic_action_attributed" },
          source: { owner: "tool-action" },
        });
      }
      if (testCase.expectedOwnerReceipts === 1) {
        expect(ownerReceipts[0]).toMatchObject({
          decision: { outcome: "allowed", reasonCode: "plugin_hook_allowed" },
          source: { owner: "plugin-hook" },
        });
      }
    },
  );

  it("does not duplicate an owner-native approval receipt", async () => {
    const registry = createEmptyPluginRegistry();
    addTestHook({
      registry,
      pluginId: "owner-plugin",
      hookName: "before_tool_call",
      handler: (() => ({
        requireApproval: { title: "Owner approval", description: "Owner approval" },
      })) as PluginHookRegistration["handler"],
    });
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    const works: ExecutionDecisionWork[] = [];
    const ownerReceipts: DecisionReceiptV1[] = [];
    const clearOwnerSink = configureRuntimeActionDecisionSink((receipt) => {
      ownerReceipts.push(receipt);
      return true;
    });
    const execute = vi.fn();
    const tool = wrapToolWithBeforeToolCallHook(
      assembledTool("data", "approval_subject", execute),
      undefined,
      { approvalMode: "report" },
    );

    try {
      await expect(
        admittedRun({ works, run: () => tool.execute("approval-call", {}) }),
      ).rejects.toThrow();
    } finally {
      clearOwnerSink();
    }

    expect(execute).not.toHaveBeenCalled();
    expect(works).toEqual([]);
    expect(ownerReceipts).toHaveLength(1);
    expect(ownerReceipts[0]).toMatchObject({
      decision: { reasonCode: "plugin_hook_approval_required" },
      source: { owner: "plugin-hook" },
    });
  });

  it("does not duplicate an owner-native decision created during tool execution", async () => {
    const works: ExecutionDecisionWork[] = [];
    const execute = vi.fn(async () => {
      markToolDecisionRecorded();
      return { content: [], details: { ok: true } };
    });
    const tool = wrapToolWithBeforeToolCallHook(
      assembledTool("tool", "late_owner_subject", execute),
    );

    await admittedRun({ works, run: () => tool.execute("late-owner-call", {}) });

    expect(execute).toHaveBeenCalledOnce();
    expect(works).toEqual([]);
  });

  it("records prepareControl disposal as suppression without launching the tool", async () => {
    const works: ExecutionDecisionWork[] = [];
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook(
      assembledTool("data", "disposed_before_launch", execute),
    );
    const definition = toToolDefinitions([tool])[0];
    if (!definition) {
      throw new Error("missing adapted tool definition");
    }
    const preparer = getInternalToolExecutionPreparer(wrapToolDefinition(definition));
    if (!preparer) {
      throw new Error("missing private execution preparer");
    }

    await admittedRun({
      works,
      run: async () => {
        const prepared = await preparer({ toolCallId: "disposed-call", args: {} });
        expect(prepared.kind).toBe("ready");
        prepared.dispose();
        await vi.waitFor(() => expect(works).toHaveLength(1));
      },
    });

    expect(execute).not.toHaveBeenCalled();
    expect(works[0]?.receipt).toMatchObject({
      decision: { outcome: "not-applicable", reasonCode: "generic_action_suppressed" },
      enforcement: { coverageState: "attribution-only" },
      source: { owner: "tool-action" },
    });
  });

  it.each([
    { name: "missing identity", runAdmitted: false, authority: () => true },
    { name: "stale authority", runAdmitted: true, authority: () => false },
    {
      name: "throwing authority",
      runAdmitted: true,
      authority: () => {
        throw new Error("stale");
      },
    },
  ])(
    "suppresses receipts with $name without suppressing the tool",
    async ({ runAdmitted, authority }) => {
      const works: ExecutionDecisionWork[] = [];
      const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
      const tool = wrapToolWithBeforeToolCallHook(
        assembledTool("data", "authority_subject", execute),
      );
      if (runAdmitted) {
        await admittedRun({ works, authority, run: () => tool.execute("authority-call", {}) });
      } else {
        await tool.execute("authority-call", {});
      }
      expect(execute).toHaveBeenCalledOnce();
      expect(works).toEqual([]);
    },
  );

  it("is deterministic for duplicate delivery and harmless without a sink", async () => {
    const works: ExecutionDecisionWork[] = [];
    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const tool = wrapToolWithBeforeToolCallHook(assembledTool("data", "dedupe_subject", execute));

    await admittedRun({
      works,
      run: async () => {
        await tool.execute("duplicate-call", {});
        await tool.execute("duplicate-call", {});
      },
    });
    expect(works).toHaveLength(2);
    expect(works[0]?.receipt.receiptId).toBe(works[1]?.receipt.receiptId);
    expect(works[0]?.receipt.action).toEqual(works[1]?.receipt.action);
    expect(works[0]?.receipt.decision).toEqual(works[1]?.receipt.decision);

    await expect(tool.execute("no-sink-call", {})).resolves.toMatchObject({
      details: { ok: true },
    });
    expect(execute).toHaveBeenCalledTimes(3);
  });
});
