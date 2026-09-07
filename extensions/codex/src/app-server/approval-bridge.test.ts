import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reviewExecRequestWithConfiguredModel } from "openclaw/plugin-sdk/agent-harness-exec-review-runtime";
import {
  callGatewayTool,
  buildAgentHookContextChannelFields,
  hasNativeHookRelayInvocation,
  invokeNativeHookRelay,
  resolveNativeHookRelayDeferredToolApproval,
  runBeforeToolCallHook,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { prepareSystemRunMutableFileApproval } from "openclaw/plugin-sdk/plugin-test-runtime";
// Codex tests cover approval bridge plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCodexAppServerApprovalRequest } from "./approval-bridge.js";
import { codexTestTurnIds } from "./codex-app-server.test-fixtures.js";
import {
  codexApprovalTimeoutText,
  requestPluginApproval,
  waitForPluginApprovalDecision,
} from "./plugin-approval-roundtrip.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  callGatewayTool: vi.fn(),
  hasNativeHookRelayInvocation: vi.fn(() => false),
  invokeNativeHookRelay: vi.fn(),
  resolveNativeHookRelayDeferredToolApproval: vi.fn(),
  runBeforeToolCallHook: vi.fn(async ({ params }: { params: unknown }) => ({
    blocked: false,
    params,
  })),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-exec-review-runtime", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("openclaw/plugin-sdk/agent-harness-exec-review-runtime")
  >()),
  reviewExecRequestWithConfiguredModel: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);
const mockHasNativeHookRelayInvocation = vi.mocked(hasNativeHookRelayInvocation);
const mockInvokeNativeHookRelay = vi.mocked(invokeNativeHookRelay);
const mockResolveNativeHookRelayDeferredToolApproval = vi.mocked(
  resolveNativeHookRelayDeferredToolApproval,
);
const mockReviewExecRequestWithConfiguredModel = vi.mocked(reviewExecRequestWithConfiguredModel);
const mockRunBeforeToolCallHook = vi.mocked(runBeforeToolCallHook);

const requireRecord = createRequireRecord("record", "expected-label-capitalized");
type AgentHarnessHostCapabilities = EmbeddedRunAttemptParams["hostCapabilities"];

const prepareApprovalWithoutMutableFile: AgentHarnessHostCapabilities["prepareMutableFileApproval"] =
  async () => ({
    ok: true,
    requiresOneShot: false,
    revalidate: async () => ({ ok: true }),
  });

function gatewayCallAt(callIndex = 0) {
  const call = mockCallGatewayTool.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected gateway call ${callIndex + 1}`);
  }
  return call;
}

function gatewayRequestPayload(callIndex = 0) {
  return requireRecord(gatewayCallAt(callIndex)[2], `gateway request payload ${callIndex + 1}`);
}

function gatewayCallOptions(callIndex = 0) {
  return gatewayCallAt(callIndex)[3];
}

function gatewayCallMethod(callIndex = 0) {
  return gatewayCallAt(callIndex)[0];
}

function findApprovalEvent(
  params: EmbeddedRunAttemptParams,
  fields: {
    status?: string;
    approvalId?: string;
    command?: string;
    reason?: string;
    message?: string;
  },
) {
  const onAgentEvent = params.onAgentEvent as unknown as { mock?: { calls?: unknown[][] } };
  const calls = onAgentEvent.mock?.calls;
  if (!Array.isArray(calls)) {
    throw new Error("Expected onAgentEvent mock calls");
  }
  for (const call of calls) {
    const event = requireRecord(call[0], "agent event");
    if (event.stream !== "approval") {
      continue;
    }
    const data = requireRecord(event.data, "approval event data");
    if (
      (!fields.status || data.status === fields.status) &&
      (!fields.approvalId || data.approvalId === fields.approvalId) &&
      (!fields.command || data.command === fields.command) &&
      (!fields.reason || data.reason === fields.reason) &&
      (!fields.message || data.message === fields.message)
    ) {
      return data;
    }
  }
  throw new Error(`Expected approval event ${JSON.stringify(fields)}`);
}

function createParams(): EmbeddedRunAttemptParams {
  const params = {
    sessionKey: "agent:main:session-1",
    agentId: "main",
    messageChannel: "telegram",
    currentChannelId: "chat-1",
    agentAccountId: "default",
    currentThreadTs: "thread-ts",
    onAgentEvent: vi.fn(),
  } as unknown as EmbeddedRunAttemptParams;
  const hostCapabilities: AgentHarnessHostCapabilities = {
    kind: "agent-harness-host-capability",
    version: 1,
    assertActive: () => {},
    bindToolSurface: (tools) => tools,
    prepareMutableFileApproval: prepareSystemRunMutableFileApproval,
    runBeforeToolCall: async ({ approvalMode = "request", ...request }) => {
      const requester = {
        ...((params.messageChannel ?? params.messageProvider)
          ? { channel: params.messageChannel ?? params.messageProvider ?? undefined }
          : {}),
        ...(params.agentAccountId ? { accountId: params.agentAccountId } : {}),
        ...(params.senderId ? { senderId: params.senderId } : {}),
        ...(params.senderIsOwner !== undefined ? { senderIsOwner: params.senderIsOwner } : {}),
        ...(params.memberRoleIds?.length ? { roleIds: [...params.memberRoleIds] } : {}),
      };
      return await runBeforeToolCallHook({
        ...request,
        approvalMode,
        ctx: {
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          ...buildAgentHookContextChannelFields(params),
          ...(Object.keys(requester).length > 0 ? { requester } : {}),
          turnSourceChannel: params.messageChannel,
          turnSourceTo: params.currentChannelId,
          turnSourceAccountId: params.agentAccountId,
          turnSourceThreadId: params.currentThreadTs,
        },
      });
    },
    requestApproval: async (request) =>
      (await callGatewayTool(
        "plugin.approval.request",
        { timeoutMs: request.timeoutMs },
        {
          pluginId: "codex",
          ...request,
          timeoutMs: 120_000,
          twoPhase: true,
        },
        { expectFinal: false },
      )) as Awaited<ReturnType<AgentHarnessHostCapabilities["requestApproval"]>>,
    waitForApproval: async (request) => {
      const result = (await callGatewayTool(
        "plugin.approval.waitDecision",
        { timeoutMs: request.timeoutMs },
        { id: request.approvalId },
      )) as { id?: string } & Partial<
        NonNullable<Awaited<ReturnType<AgentHarnessHostCapabilities["waitForApproval"]>>>
      >;
      return result?.id === request.approvalId
        ? { decision: result.decision, terminalReason: result.terminalReason }
        : undefined;
    },
  };
  return Object.assign(params, { hostCapabilities });
}

describe("Codex app-server approval bridge", () => {
  beforeEach(() => {
    mockCallGatewayTool.mockReset();
    mockHasNativeHookRelayInvocation.mockReset();
    mockHasNativeHookRelayInvocation.mockReturnValue(false);
    mockInvokeNativeHookRelay.mockReset();
    mockResolveNativeHookRelayDeferredToolApproval.mockReset();
    mockResolveNativeHookRelayDeferredToolApproval.mockResolvedValue(undefined);
    mockReviewExecRequestWithConfiguredModel.mockReset();
    mockReviewExecRequestWithConfiguredModel.mockResolvedValue({
      decision: "ask",
      rationale: "test reviewer asks for approval",
      risk: "unknown",
    });
    mockRunBeforeToolCallHook.mockReset();
    mockRunBeforeToolCallHook.mockImplementation(async ({ params }) => ({
      blocked: false,
      params,
    }));
  });

  it.each([
    ["command", "Command approval timed out before an operator responded."],
    ["file-change", "File change approval timed out before an operator responded."],
    ["permissions", "Permission approval timed out before an operator responded."],
    ["other", "Approval timed out before an operator responded."],
  ] as const)("formats %s approval timeout evidence", (kind, expected) => {
    expect(codexApprovalTimeoutText(kind)).toBe(expected);
  });

  it("only offers operator decisions that the native command request can enforce", async () => {
    const params = createParams();
    params.hostCapabilities = {
      ...params.hostCapabilities,
      prepareMutableFileApproval: prepareApprovalWithoutMutableFile,
    };
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-native-once", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-native-once",
        decision: "allow-once",
      });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-native-once",
        command: "git status",
        availableDecisions: ["accept", "cancel"],
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "accept" });
    expect(gatewayRequestPayload().allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("offers session approval only when the native command request can preserve it", async () => {
    const params = createParams();
    params.hostCapabilities = {
      ...params.hostCapabilities,
      prepareMutableFileApproval: prepareApprovalWithoutMutableFile,
    };
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-native-session", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-native-session",
        decision: "allow-always",
      });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-native-session",
        command: "git status",
        availableDecisions: ["accept", "acceptForSession", "decline", "cancel"],
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "acceptForSession" });
    expect(gatewayRequestPayload().allowedDecisions).toEqual([
      "allow-once",
      "allow-always",
      "deny",
    ]);
  });

  it.each([
    ["operator denial", false, "decline"],
    ["run cancellation", true, "cancel"],
  ] as const)("maps %s to a native command rejection", async (_label, abortRun, expected) => {
    const params = createParams();
    params.hostCapabilities = {
      ...params.hostCapabilities,
      prepareMutableFileApproval: prepareApprovalWithoutMutableFile,
    };
    const controller = new AbortController();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-native-cancel", status: "accepted" })
      .mockImplementationOnce(async () => {
        if (abortRun) {
          controller.abort("client_closed");
        }
        return { id: "plugin:approval-native-cancel", decision: "deny" };
      });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-native-cancel",
        command: "git status",
        availableDecisions: ["accept", "cancel"],
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      signal: controller.signal,
    });

    expect(result).toEqual({ decision: expected });
    expect(gatewayRequestPayload().allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it.each([
    ["allow-once", "accept"],
    ["allow-always", "acceptForSession"],
    ["deny", "decline"],
  ] as const)(
    "maps file operator decision %s to native %s",
    async (gatewayDecision, nativeDecision) => {
      const params = createParams();
      mockCallGatewayTool
        .mockResolvedValueOnce({ id: `plugin:file-${gatewayDecision}`, status: "accepted" })
        .mockResolvedValueOnce({
          id: `plugin:file-${gatewayDecision}`,
          decision: gatewayDecision,
        });

      const result = await handleCodexAppServerApprovalRequest({
        method: "item/fileChange/requestApproval",
        requestParams: {
          ...codexTestTurnIds(),
          itemId: `file-${gatewayDecision}`,
          reason: "update generated output",
        },
        paramsForRun: params,
        ...codexTestTurnIds(),
      });

      expect(result).toEqual({ decision: nativeDecision });
      expect(gatewayRequestPayload().allowedDecisions).toEqual([
        "allow-once",
        "allow-always",
        "deny",
      ]);
    },
  );

  it("keeps unrelated command approval policy unchanged for scheduled app authority", async () => {
    const params = {
      ...createParams(),
      trigger: "cron",
      scheduledRuntimeAuthority: {
        version: 1,
        runtimeId: "codex",
        namespace: "codex.apps",
        payload: { version: 1 },
      },
    } as EmbeddedRunAttemptParams;
    params.hostCapabilities = {
      ...params.hostCapabilities,
      prepareMutableFileApproval: prepareApprovalWithoutMutableFile,
    };

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "scheduled-command",
        command: "git status",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      autoApprove: true,
    });

    expect(result).toEqual({ decision: "acceptForSession" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(mockRunBeforeToolCallHook).toHaveBeenCalled();
  });

  it("auto-accepts app-server command approvals in yolo mode without opening plugin approvals", async () => {
    const params = createParams();

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-yolo",
        command: "/bin/bash -lc 'node -v'",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      autoApprove: true,
    });

    expect(result).toEqual({ decision: "acceptForSession" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(mockRunBeforeToolCallHook).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "exec",
        approvalMode: "request",
      }),
    );
    findApprovalEvent(params, {
      status: "approved",
      message: "Codex app-server approval auto-approved by runtime policy.",
    });
  });

  it("auto-accepts app-server file approvals in yolo mode without opening plugin approvals", async () => {
    const params = createParams();

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/fileChange/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "patch-yolo",
        reason: "needs write access",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      autoApprove: true,
    });

    expect(result).toEqual({ decision: "acceptForSession" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "approved",
      reason: "needs write access",
      message: "Codex app-server approval auto-approved by runtime policy.",
    });
  });

  it("cancels native approval when permissions change during final file revalidation", async () => {
    const params = createParams();
    const controller = new AbortController();
    params.hostCapabilities = {
      ...params.hostCapabilities,
      prepareMutableFileApproval: async () => ({
        ok: true,
        requiresOneShot: false,
        revalidate: async () => {
          controller.abort("permission-change");
          return { ok: true };
        },
      }),
    };

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-permission-change",
        command: "node script.js",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      autoApprove: true,
      signal: controller.signal,
    });

    expect(result).toEqual({ decision: "cancel" });
    expect(params.onAgentEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "approved" }) }),
    );
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("keeps permission grants on the human path under full-auto runtime policy", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:permission-policy-allow", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:permission-policy-allow",
        decision: "allow-once",
      });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "permission-policy-allow",
        permissions: {
          network: { enabled: true },
          fileSystem: { write: ["/workspace"] },
        },
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      autoApprove: true,
    });

    expect(result).toEqual({
      permissions: {
        network: { enabled: true },
        fileSystem: { write: ["/workspace"] },
      },
      scope: "turn",
    });
    expect(mockRunBeforeToolCallHook).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "codex_permission_approval" }),
    );
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("routes command approvals through plugin approvals and accepts allowed commands", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-1", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-1", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-1",
        command: "pnpm test extensions/codex/src/app-server",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(gatewayCallMethod()).toBe("plugin.approval.request");
    expect(typeof gatewayCallAt(0)[1]).toBe("object");
    const requestPayload = gatewayRequestPayload();
    expect(requestPayload.pluginId).toBe("codex");
    expect(requestPayload.title).toBe("Codex app-server command approval");
    expect(requestPayload.twoPhase).toBe(true);
    expect(requestPayload.turnSourceChannel).toBeUndefined();
    expect(requestPayload.turnSourceTo).toBeUndefined();
    expect(gatewayCallOptions()).toEqual({ expectFinal: false });
    expect(mockRunBeforeToolCallHook).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "exec",
        params: {
          command: "pnpm test extensions/codex/src/app-server",
          approval: {
            ...codexTestTurnIds(),
            itemId: "cmd-1",
            command: "pnpm test extensions/codex/src/app-server",
          },
        },
        toolCallId: "cmd-1",
        approvalMode: "request",
        signal: undefined,
        ctx: expect.objectContaining({
          agentId: "main",
          sessionKey: "agent:main:session-1",
          channelId: "chat-1",
          requester: {
            channel: "telegram",
            accountId: "default",
          },
          turnSourceChannel: "telegram",
          turnSourceTo: "chat-1",
          turnSourceAccountId: "default",
          turnSourceThreadId: "thread-ts",
        }),
      }),
    );
    findApprovalEvent(params, { status: "pending", approvalId: "plugin:approval-1" });
    findApprovalEvent(params, { status: "approved", approvalId: "plugin:approval-1" });
  });

  it("denies command approval when a script operand changes before the decision", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-script-drift-"));
    const scriptPath = path.join(tempDir, "script.sh");
    try {
      await fs.writeFile(scriptPath, "#!/bin/sh\necho approved\n");
      const params = createParams();
      params.hostCapabilities = {
        ...params.hostCapabilities,
        prepareMutableFileApproval: prepareSystemRunMutableFileApproval,
      };
      mockCallGatewayTool
        .mockResolvedValueOnce({ id: "plugin:script-drift", status: "accepted" })
        .mockImplementationOnce(async () => {
          await fs.writeFile(scriptPath, "#!/bin/sh\necho mutated\n");
          return { id: "plugin:script-drift", decision: "allow-once" };
        });

      const result = await handleCodexAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          ...codexTestTurnIds(),
          itemId: "cmd-script-drift",
          command: `sh ${scriptPath}`,
          cwd: tempDir,
        },
        paramsForRun: params,
        ...codexTestTurnIds(),
      });

      expect(result).toEqual({ decision: "decline" });
      findApprovalEvent(params, {
        status: "denied",
        approvalId: "plugin:script-drift",
        message: "SYSTEM_RUN_DENIED: approval script operand changed before execution",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts command approval when the bound script operand is unchanged", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-script-stable-"));
    const scriptPath = path.join(tempDir, "script.sh");
    try {
      await fs.writeFile(scriptPath, "#!/bin/sh\necho approved\n");
      const params = createParams();
      params.hostCapabilities = {
        ...params.hostCapabilities,
        prepareMutableFileApproval: prepareSystemRunMutableFileApproval,
      };
      mockCallGatewayTool
        .mockResolvedValueOnce({ id: "plugin:script-stable", status: "accepted" })
        .mockResolvedValueOnce({ id: "plugin:script-stable", decision: "allow-once" });

      const result = await handleCodexAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          ...codexTestTurnIds(),
          itemId: "cmd-script-stable",
          command: `sh ${scriptPath}`,
          cwd: tempDir,
          availableDecisions: ["accept", "acceptForSession", "cancel"],
        },
        paramsForRun: params,
        ...codexTestTurnIds(),
      });

      expect(result).toEqual({ decision: "accept" });
      expect(gatewayRequestPayload().allowedDecisions).toEqual(["allow-once", "deny"]);
      findApprovalEvent(params, {
        status: "approved",
        approvalId: "plugin:script-stable",
        message: "Codex app-server approval granted for this turn.",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("denies command approval when a script operand cannot be snapshotted", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-script-missing-"));
    try {
      const params = createParams();
      params.hostCapabilities = {
        ...params.hostCapabilities,
        prepareMutableFileApproval: prepareSystemRunMutableFileApproval,
      };
      const result = await handleCodexAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          ...codexTestTurnIds(),
          itemId: "cmd-script-missing",
          command: `sh ${path.join(tempDir, "missing.sh")}`,
          cwd: tempDir,
        },
        paramsForRun: params,
        ...codexTestTurnIds(),
      });

      expect(result).toEqual({ decision: "decline" });
      expect(mockCallGatewayTool).not.toHaveBeenCalled();
      findApprovalEvent(params, {
        status: "denied",
        message: "SYSTEM_RUN_DENIED: approval requires an existing script operand",
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps configured exec auto-review on the human approval route", async () => {
    const params = createParams();
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
            timeoutMs: 12_000,
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "read-only version check",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-auto-review", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-auto-review", decision: "deny" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-auto-review",
        command: "node --version",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    findApprovalEvent(params, { status: "denied", approvalId: "plugin:approval-auto-review" });
  });

  it("falls back to plugin approval when no exec auto-review model is configured", async () => {
    const params = createParams();
    params.config = {
      tools: {
        exec: {
          mode: "auto",
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-no-reviewer", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-no-reviewer", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-auto-review-missing",
        command: "node --version",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it.each([false, true])(
    "keeps commandless managed-network approvals on the human route when autoApprove=%s",
    async (autoApprove) => {
      const params = createParams();
      params.config = {
        tools: {
          exec: {
            mode: "auto",
            reviewer: {
              model: "openai/gpt-5.5-mini",
            },
          },
        },
      } as EmbeddedRunAttemptParams["config"];
      mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
        decision: "allow-once",
        rationale: "network request looks fine",
        risk: "low",
      });
      mockCallGatewayTool
        .mockResolvedValueOnce({ id: "plugin:approval-network", status: "accepted" })
        .mockResolvedValueOnce({ id: "plugin:approval-network", decision: "allow-once" });

      const result = await handleCodexAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          ...codexTestTurnIds(),
          itemId: "cmd-auto-review-network",
          networkApprovalContext: {
            host: "example.test",
            protocol: "https",
          },
        },
        paramsForRun: params,
        ...codexTestTurnIds(),
        autoApprove,
      });

      expect(result).toEqual({ decision: "accept" });
      expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
      expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
        "plugin.approval.request",
        "plugin.approval.waitDecision",
      ]);
      expect(gatewayRequestPayload()).toMatchObject({
        title: "Codex app-server network approval",
        description: "Network: https://example.test",
        toolName: "codex_network_approval",
      });
      expect(mockRunBeforeToolCallHook).toHaveBeenCalledWith(
        expect.objectContaining({
          toolName: "codex_network_approval",
          params: expect.objectContaining({
            approval: expect.objectContaining({
              networkApprovalContext: { host: "example.test", protocol: "https" },
            }),
          }),
        }),
      );
    },
  );

  it.each(["lmstudio/local-model", "local-model"])(
    "falls back to plugin approval for unsafe exec auto-review model %s",
    async (model) => {
      const params = createParams();
      params.config = {
        tools: {
          exec: {
            mode: "auto",
            reviewer: {
              model,
            },
          },
        },
      } as unknown as EmbeddedRunAttemptParams["config"];
      mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
        decision: "allow-once",
        rationale: "unsafe self review",
        risk: "low",
      });
      mockCallGatewayTool
        .mockResolvedValueOnce({ id: "plugin:approval-local-reviewer", status: "accepted" })
        .mockResolvedValueOnce({ id: "plugin:approval-local-reviewer", decision: "allow-once" });

      const result = await handleCodexAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          ...codexTestTurnIds(),
          itemId: "cmd-auto-review-local",
          command: "node --version",
        },
        paramsForRun: params,
        ...codexTestTurnIds(),
      });

      expect(result).toEqual({ decision: "accept" });
      expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
      expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
        "plugin.approval.request",
        "plugin.approval.waitDecision",
      ]);
    },
  );

  it.each([
    {
      name: "provider base URL",
      reviewerModel: "openai/gpt-5.5-mini",
      models: {
        providers: {
          openai: {
            baseUrl: "http://127.0.0.1:11434/v1",
            models: [],
          },
        },
      },
    },
    {
      name: "provider key casing with custom base URL",
      reviewerModel: "openai/gpt-5.5-mini",
      models: {
        providers: {
          OpenAI: {
            baseUrl: "http://localhost:8080/v1",
            models: [],
          },
        },
      },
    },
    {
      name: "provider local service",
      reviewerModel: "openai/gpt-5.5-mini",
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            localService: { command: "local-openai-compatible" },
            models: [],
          },
        },
      },
    },
    {
      name: "model base URL",
      reviewerModel: "openai/gpt-5.5-mini@work",
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-5.5-mini",
                name: "Local GPT-compatible reviewer",
                baseUrl: "http://localhost:8080/v1",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 8_192,
              },
            ],
          },
        },
      },
    },
  ])(
    "falls back to plugin approval for OpenAI reviewer with custom $name",
    async ({ models, reviewerModel }) => {
      const params = createParams();
      params.config = {
        tools: {
          exec: {
            mode: "auto",
            reviewer: {
              model: reviewerModel,
            },
          },
        },
        models,
      } as unknown as EmbeddedRunAttemptParams["config"];
      mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
        decision: "allow-once",
        rationale: "custom endpoint reviewer",
        risk: "low",
      });
      mockCallGatewayTool
        .mockResolvedValueOnce({ id: "plugin:approval-custom-openai", status: "accepted" })
        .mockResolvedValueOnce({ id: "plugin:approval-custom-openai", decision: "allow-once" });

      const result = await handleCodexAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          ...codexTestTurnIds(),
          itemId: "cmd-auto-review-custom-openai",
          command: "node --version",
        },
        paramsForRun: params,
        ...codexTestTurnIds(),
      });

      expect(result).toEqual({ decision: "accept" });
      expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
      expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
        "plugin.approval.request",
        "plugin.approval.waitDecision",
      ]);
    },
  );

  it("falls back to plugin approval when an OpenAI-looking reviewer is a configured model alias", async () => {
    const params = createParams();
    params.config = {
      agents: {
        defaults: {
          models: {
            "lmstudio/local-reviewer": {
              alias: "OpenAI/Reviewer",
            },
          },
        },
      },
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/reviewer@work",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "aliased local reviewer",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-aliased-openai", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-aliased-openai", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-auto-review-aliased-openai",
        command: "node --version",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("keeps agent-scoped exec reviewer configuration on the human approval route", async () => {
    const params = createParams();
    params.config = {
      agents: {
        list: [
          {
            id: "sidecar",
            models: {
              "lmstudio/local-reviewer": {
                alias: "openai/gpt-5.5-mini",
              },
            },
          },
        ],
      },
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini@work",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "real OpenAI reviewer",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-agent-reviewer", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-agent-reviewer", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-auto-review-agent-alias",
        command: "node --version",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("falls back to plugin approval when OpenAI reviewer uses a custom environment base URL", async () => {
    const params = createParams();
    vi.stubEnv("OPENAI_BASE_URL", "http://127.0.0.1:11434/v1");
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "custom env endpoint reviewer",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-env-openai", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-env-openai", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-auto-review-env-openai",
        command: "node --version",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("falls back to plugin approval when Codex native OpenAI config uses a local base URL", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-approval-"));
    try {
      await fs.mkdir(path.join(tempDir, "codex-home"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, "codex-home", "config.toml"),
        'openai_base_url = "http://127.0.0.1:11434/v1"\n',
      );
      const params = createParams();
      params.agentDir = tempDir;
      params.config = {
        tools: {
          exec: {
            mode: "auto",
            reviewer: {
              model: "openai/gpt-5.5-mini",
            },
          },
        },
      } as EmbeddedRunAttemptParams["config"];
      mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
        decision: "allow-once",
        rationale: "custom native endpoint reviewer",
        risk: "low",
      });
      mockCallGatewayTool
        .mockResolvedValueOnce({ id: "plugin:approval-native-openai", status: "accepted" })
        .mockResolvedValueOnce({ id: "plugin:approval-native-openai", decision: "allow-once" });

      const result = await handleCodexAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          ...codexTestTurnIds(),
          itemId: "cmd-auto-review-native-openai",
          command: "node --version",
        },
        paramsForRun: params,
        ...codexTestTurnIds(),
      });

      expect(result).toEqual({ decision: "accept" });
      expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
      expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
        "plugin.approval.request",
        "plugin.approval.waitDecision",
      ]);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps permission amendment command approvals on the plugin approval route", async () => {
    const params = createParams();
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "safe command",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-amendment", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-amendment", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-auto-review-amendment",
        command: "node --version",
        additionalPermissions: {
          network: {
            allowHosts: ["example.com"],
          },
        },
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    expect(gatewayRequestPayload().description).toContain("Additional permissions: network");
  });

  it("keeps object-shaped execpolicy amendment command approvals on the plugin approval route", async () => {
    const params = createParams();
    params.hostCapabilities = {
      ...params.hostCapabilities,
      prepareMutableFileApproval: prepareApprovalWithoutMutableFile,
    };
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "safe command",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-execpolicy-object", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-execpolicy-object", decision: "allow-always" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-auto-review-execpolicy-object",
        command: "node --version",
        proposedExecpolicyAmendment: {
          permissions: [{ permission: "allow", command: ["node"] }],
        },
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "acceptForSession" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("keeps unbound shell command approvals on the plugin approval route", async () => {
    const params = createParams();
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "safe command",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-unbound", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-unbound", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-auto-review-unbound",
        command: "node --version && echo ok",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it.each([
    "/approve abc123 allow-once",
    "bash -lc '/approve abc123 allow-once'",
    "openclaw channels login --channel whatsapp",
    "sudo -EH bash -lc 'openclaw channels login --channel whatsapp'",
  ])("fails closed or routes unsafe control command approval: %s", async (command) => {
    const params = createParams();
    if (!command.startsWith("/approve ")) {
      params.hostCapabilities = {
        ...params.hostCapabilities,
        prepareMutableFileApproval: prepareApprovalWithoutMutableFile,
      };
    }
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "unsafe control command",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-control-command", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-control-command", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-auto-review-control-command",
        command,
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    const bindable = !command.startsWith("/approve ");
    expect(result).toEqual({ decision: bindable ? "accept" : "decline" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual(
      bindable ? ["plugin.approval.request", "plugin.approval.waitDecision"] : [],
    );
  });

  it("keeps security audit suppression edits on the plugin approval route", async () => {
    const params = createParams();
    params.hostCapabilities = {
      ...params.hostCapabilities,
      prepareMutableFileApproval: prepareApprovalWithoutMutableFile,
    };
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "safe command",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-security-suppression", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-security-suppression",
        decision: "allow-once",
      });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-auto-review-security-suppression",
        command: "openclaw config set security.audit.suppressions '[]'",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("keeps amendment-only decision command approvals on the plugin approval route", async () => {
    const params = createParams();
    params.hostCapabilities = {
      ...params.hostCapabilities,
      prepareMutableFileApproval: prepareApprovalWithoutMutableFile,
    };
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: "openai/gpt-5.5-mini",
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "allow-once",
      rationale: "safe command",
      risk: "low",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-amendment-only", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-amendment-only", decision: "allow-always" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-auto-review-amendment-only",
        command: "node --version",
        availableDecisions: [
          {
            acceptWithExecpolicyAmendment: {
              patterns: ["node"],
            },
          },
        ],
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({
      decision: {
        acceptWithExecpolicyAmendment: {
          patterns: ["node"],
        },
      },
    });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("declines a denied execve approval instead of cancelling the turn", async () => {
    const params = createParams();
    params.hostCapabilities = {
      ...params.hostCapabilities,
      prepareMutableFileApproval: prepareApprovalWithoutMutableFile,
    };
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-execve-denied", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-execve-denied", decision: "deny" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-execve-denied",
        approvalId: "execve-approval-1",
        command: "git status",
        availableDecisions: ["accept", "cancel"],
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "decline" });
  });

  it("does not invoke the exec auto-review model before plugin approval", async () => {
    const params = createParams();
    params.config = {
      tools: {
        exec: {
          mode: "auto",
          reviewer: {
            model: { primary: "openai/gpt-5.5-mini" },
          },
        },
      },
    } as EmbeddedRunAttemptParams["config"];
    mockReviewExecRequestWithConfiguredModel.mockResolvedValueOnce({
      decision: "ask",
      rationale: "needs human review",
      risk: "medium",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-reviewer-ask", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-reviewer-ask", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-auto-review-ask",
        command: "git status",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockReviewExecRequestWithConfiguredModel).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("normalizes prefixed channel targets for OpenClaw tool policy context", async () => {
    const params = createParams();
    params.messageChannel = "telegram";
    params.messageProvider = "telegram";
    params.currentChannelId = "telegram:-100123";
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-prefixed", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-prefixed", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-prefixed",
        command: "pnpm test extensions/codex/src/app-server",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(mockRunBeforeToolCallHook).toHaveBeenCalledWith(
      expect.objectContaining({
        ctx: expect.objectContaining({
          channelId: "-100123",
        }),
      }),
    );
    expect(gatewayRequestPayload().turnSourceTo).toBeUndefined();
  });

  it("denies command approvals before prompting when OpenClaw tool policy blocks", async () => {
    const params = createParams();
    mockRunBeforeToolCallHook.mockResolvedValueOnce({
      blocked: true,
      kind: "veto",
      deniedReason: "plugin-before-tool-call",
      reason: "blocked by policy",
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-blocked",
        command: "cat /tmp/private_key",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, { status: "denied" });
  });

  it("passes the exact native command cwd to the host policy capability", async () => {
    const params = createParams();
    params.cwd = "/attempt/worktree";
    const runBeforeToolCall: AgentHarnessHostCapabilities["runBeforeToolCall"] = vi.fn(
      async ({ params: toolParams }) => ({
        blocked: true as const,
        kind: "veto" as const,
        deniedReason: "plugin-before-tool-call" as const,
        reason: "blocked by policy",
        params: toolParams,
      }),
    );
    params.hostCapabilities = { ...params.hostCapabilities, runBeforeToolCall };

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-native-cwd",
        command: "pwd",
        cwd: "/native/action/worktree",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "decline" });
    expect(runBeforeToolCall).toHaveBeenCalledWith(
      expect.objectContaining({ nativeOperation: { cwd: "/native/action/worktree" } }),
    );
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
  });

  it("routes command approvals through the active native hook relay before prompting", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockResolvedValueOnce({
      stdout: `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "blocked by native relay",
        },
      })}\n`,
      stderr: "",
      exitCode: 0,
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-native-relay",
        command: "cat /tmp/private_key",
        cwd: "/workspace",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      autoApprove: true,
      nativeHookRelay: {
        relayId: "relay-1",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledWith({
      provider: "codex",
      relayId: "relay-1",
      generation: "generation-1",
      event: "pre_tool_use",
      rawPayload: {
        hook_event_name: "PreToolUse",
        openclaw_approval_mode: "report",
        tool_name: "exec_command",
        tool_use_id: "cmd-native-relay",
        cwd: "/workspace",
        turn_id: "turn-1",
        tool_input: {
          command: "cat /tmp/private_key",
          cwd: "/workspace",
          approval: {
            ...codexTestTurnIds(),
            itemId: "cmd-native-relay",
            command: "cat /tmp/private_key",
            cwd: "/workspace",
          },
          cmd: "cat /tmp/private_key",
        },
      },
      requireGeneration: true,
    });
    findApprovalEvent(params, {
      status: "denied",
      message: "blocked by native relay",
    });
  });

  it("fails closed when native relay policy resolves after host capability closure", async () => {
    const params = createParams();
    let active = true;
    params.hostCapabilities = {
      ...params.hostCapabilities,
      assertActive: () => {
        if (!active) {
          throw new Error("agent harness host capability is no longer active");
        }
      },
    };
    mockInvokeNativeHookRelay.mockImplementationOnce(async () => {
      active = false;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    mockHasNativeHookRelayInvocation.mockReturnValueOnce(false).mockReturnValueOnce(true);

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-native-relay-late",
        command: "git status",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      autoApprove: true,
      nativeHookRelay: {
        relayId: "relay-late",
        generation: "generation-late",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, { status: "denied" });
  });

  it("fails closed when deferred native approval resolves after host capability closure", async () => {
    const params = createParams();
    let active = true;
    params.hostCapabilities = {
      ...params.hostCapabilities,
      assertActive: () => {
        if (!active) {
          throw new Error("agent harness host capability is no longer active");
        }
      },
    };
    mockHasNativeHookRelayInvocation.mockReturnValueOnce(true);
    mockResolveNativeHookRelayDeferredToolApproval.mockImplementationOnce(async () => {
      active = false;
      return { handled: true, outcome: "approved-once" };
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-native-relay-deferred-late",
        command: "git status",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      nativeHookRelay: {
        relayId: "relay-deferred-late",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, { status: "unavailable" });
  });

  it("correlates distinct execve approvals by approvalId instead of parent itemId", async () => {
    const params = createParams();
    const seenToolUseIds = new Set<string>();
    mockHasNativeHookRelayInvocation.mockImplementation(({ toolUseId }) =>
      toolUseId ? seenToolUseIds.has(toolUseId) : false,
    );
    mockInvokeNativeHookRelay.mockImplementation(async ({ rawPayload }) => {
      const toolUseId = requireRecord(rawPayload, "native relay payload").tool_use_id;
      if (typeof toolUseId === "string") {
        seenToolUseIds.add(toolUseId);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-execve-1", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-execve-1", decision: "allow-once" })
      .mockResolvedValueOnce({ id: "plugin:approval-execve-2", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-execve-2", decision: "allow-once" });
    const nativeHookRelay = {
      relayId: "relay-1",
      generation: "generation-1",
      allowedEvents: ["pre_tool_use" as const],
    };

    for (const [approvalId, command] of [
      ["execve-approval-1", "git status"],
      ["execve-approval-2", "rm -rf /tmp/work"],
    ] as const) {
      await handleCodexAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          ...codexTestTurnIds(),
          itemId: "parent-command-item",
          approvalId,
          command,
          cwd: "/workspace",
        },
        paramsForRun: params,
        ...codexTestTurnIds(),
        nativeHookRelay,
      });
    }

    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(2);
    expect(
      mockInvokeNativeHookRelay.mock.calls.map(
        ([call]) => requireRecord(call.rawPayload, "native relay payload").tool_use_id,
      ),
    ).toEqual(["execve-approval-1", "execve-approval-2"]);
    expect(mockHasNativeHookRelayInvocation).toHaveBeenNthCalledWith(1, {
      relayId: "relay-1",
      event: "pre_tool_use",
      toolUseId: "execve-approval-1",
    });
    expect(mockHasNativeHookRelayInvocation).toHaveBeenNthCalledWith(2, {
      relayId: "relay-1",
      event: "pre_tool_use",
      toolUseId: "execve-approval-2",
    });
  });

  it("falls through to plugin approval when the native hook relay has no decision", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockResolvedValueOnce({
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-native-noop", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-native-noop", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-native-relay-noop",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      nativeHookRelay: {
        relayId: "relay-1",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(1);
    expect(mockResolveNativeHookRelayDeferredToolApproval).toHaveBeenCalledWith({
      relayId: "relay-1",
      toolUseId: "cmd-native-relay-noop",
      signal: undefined,
    });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    findApprovalEvent(params, {
      status: "pending",
      approvalId: "plugin:approval-native-noop",
    });
    findApprovalEvent(params, {
      status: "approved",
      approvalId: "plugin:approval-native-noop",
    });
  });

  it("does not invoke the app-server relay when native PreToolUse already ran", async () => {
    const params = createParams();
    mockHasNativeHookRelayInvocation.mockReturnValueOnce(true);
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-native-observed", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-native-observed", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-native-relay-observed",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      nativeHookRelay: {
        relayId: "relay-1",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockHasNativeHookRelayInvocation).toHaveBeenCalledWith({
      relayId: "relay-1",
      event: "pre_tool_use",
      toolUseId: "cmd-native-relay-observed",
    });
    expect(mockResolveNativeHookRelayDeferredToolApproval).toHaveBeenCalledWith({
      relayId: "relay-1",
      toolUseId: "cmd-native-relay-observed",
      signal: undefined,
    });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("accepts command approvals from deferred native PreToolUse plugin approvals", async () => {
    const params = createParams();
    mockHasNativeHookRelayInvocation.mockReturnValueOnce(true);
    mockResolveNativeHookRelayDeferredToolApproval.mockResolvedValueOnce({
      handled: true,
      outcome: "approved-once",
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-native-relay-deferred",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      nativeHookRelay: {
        relayId: "relay-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).not.toHaveBeenCalled();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "approved",
      message: "Codex app-server approval granted for this turn.",
    });
  });

  it("preserves a deferred native approval failure for lifecycle projection", async () => {
    const params = createParams();
    const onNativeToolFailureDisposition = vi.fn();
    mockHasNativeHookRelayInvocation.mockReturnValueOnce(true);
    mockResolveNativeHookRelayDeferredToolApproval.mockResolvedValueOnce({
      handled: true,
      outcome: "denied",
      reason: "Approval cancelled because the run stopped",
      failureDisposition: "cancelled",
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-native-relay-deferred-failure",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      nativeHookRelay: {
        relayId: "relay-1",
        allowedEvents: ["pre_tool_use"],
      },
      onNativeToolFailureDisposition,
    });

    expect(result).toEqual({ decision: "decline" });
    expect(onNativeToolFailureDisposition).toHaveBeenCalledWith(
      "cmd-native-relay-deferred-failure",
      "cancelled",
    );
  });

  it("fails closed when the native hook relay returns unreadable approval output", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockResolvedValueOnce({
      stdout: "not-json",
      stderr: "",
      exitCode: 0,
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-native-relay-unreadable",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      autoApprove: true,
      nativeHookRelay: {
        relayId: "relay-1",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(1);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message:
        "OpenClaw native hook relay returned an unreadable Codex app-server approval result.",
    });
  });

  it("fails closed when the native hook relay returns a non-deny decision", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockResolvedValueOnce({
      stdout:
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
          },
        }) + "\n",
      stderr: "",
      exitCode: 0,
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-native-relay-allow",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      nativeHookRelay: {
        relayId: "relay-1",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(1);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message: "OpenClaw native hook relay returned a non-deny Codex app-server approval decision.",
    });
  });

  it("fails closed when the native hook relay exits non-zero", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockResolvedValueOnce({
      stdout: "ignored stdout",
      stderr: "blocked from stderr",
      exitCode: 1,
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-native-relay-exit",
        command: "pnpm test extensions/codex/src/app-server",
        cwd: "/workspace",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      nativeHookRelay: {
        relayId: "relay-1",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(1);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message: "blocked from stderr",
    });
  });

  it("fails closed when the expected native hook relay cannot be invoked", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockRejectedValueOnce(new Error("native hook relay not found"));

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-native-relay-missing",
        command: "cat /tmp/private_key",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      nativeHookRelay: {
        relayId: "relay-missing",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(1);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message:
        "OpenClaw native hook relay unavailable for Codex app-server approval: native hook relay not found",
    });
  });

  it("auto-approves when the expected native hook relay is unavailable in full-auto", async () => {
    const params = createParams();
    mockInvokeNativeHookRelay.mockRejectedValueOnce(new Error("native hook relay not found"));

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-native-relay-full-auto-missing",
        command: "pwd",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      autoApprove: true,
      nativeHookRelay: {
        relayId: "relay-missing",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "acceptForSession" });
    expect(mockRunBeforeToolCallHook).toHaveBeenCalledTimes(1);
    expect(mockInvokeNativeHookRelay).toHaveBeenCalledTimes(1);
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "approved",
      message: "Codex app-server approval auto-approved by runtime policy.",
    });
  });

  it("fails closed when the native hook relay fails after invocation in full-auto", async () => {
    const params = createParams();
    mockHasNativeHookRelayInvocation.mockReturnValueOnce(false).mockReturnValueOnce(true);
    mockInvokeNativeHookRelay.mockRejectedValueOnce(new Error("native hook relay handler failed"));

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-native-relay-handler-failure",
        command: "pwd",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      autoApprove: true,
      nativeHookRelay: {
        relayId: "relay-1",
        generation: "generation-1",
        allowedEvents: ["pre_tool_use"],
      },
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message:
        "OpenClaw native hook relay unavailable for Codex app-server approval: native hook relay handler failed",
    });
  });

  it("keeps non-command approvals on the app-server approval route when a native relay is registered", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:file-approval", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:file-approval", decision: "allow-once" })
      .mockResolvedValueOnce({ id: "plugin:permission-approval", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:permission-approval", decision: "deny" });
    const nativeHookRelay = {
      relayId: "relay-1",
      generation: "generation-1",
      allowedEvents: ["pre_tool_use" as const],
    };

    await handleCodexAppServerApprovalRequest({
      method: "item/fileChange/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "patch-native-relay-registered",
        reason: "needs write access",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      nativeHookRelay,
    });
    await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "permission-native-relay-registered",
        permissions: {
          network: { allowHosts: ["example.com"] },
        },
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      nativeHookRelay,
    });

    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("denies command approvals when OpenClaw tool policy rewrites params", async () => {
    const params = createParams();
    mockRunBeforeToolCallHook.mockResolvedValueOnce({
      blocked: false,
      params: {
        command: "echo rewritten",
        approval: {
          ...codexTestTurnIds(),
          itemId: "cmd-rewritten",
          command: "echo rewritten",
        },
      },
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-rewritten",
        command: "cat /tmp/private_key",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message:
        "OpenClaw tool policy rewrote Codex app-server approval params; refusing original request.",
    });
  });

  it("keeps OpenClaw plugin allow-always approvals scoped to one Codex request", async () => {
    const params = createParams();
    mockRunBeforeToolCallHook.mockResolvedValueOnce({
      blocked: false,
      params: {
        command: "pnpm test",
        approval: {
          ...codexTestTurnIds(),
          itemId: "cmd-needs-approval",
          command: "pnpm test",
        },
      },
      approvalResolution: "allow-always",
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-needs-approval",
        command: "pnpm test",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "approved",
      message: "Codex app-server approval granted for this turn.",
    });
  });

  it("denies command approvals when OpenClaw tool policy requires approval", async () => {
    const params = createParams();
    mockRunBeforeToolCallHook.mockResolvedValueOnce({
      blocked: true,
      kind: "failure",
      disposition: "blocked",
      deniedReason: "plugin-approval",
      reason: "Plugin approval required",
    });
    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-needs-approval",
        command: "pnpm test",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    findApprovalEvent(params, {
      status: "denied",
      message: "Plugin approval required",
    });
  });

  it.each(["failed", "cancelled", "timed_out"] as const)(
    "preserves a %s pre-execution failure for native lifecycle projection",
    async (disposition) => {
      const params = createParams();
      const onNativeToolFailureDisposition = vi.fn();
      mockRunBeforeToolCallHook.mockResolvedValueOnce({
        blocked: true,
        kind: "failure",
        disposition,
        deniedReason: "plugin-before-tool-call",
        reason: "Tool call blocked because before_tool_call hook failed",
      });

      const result = await handleCodexAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          ...codexTestTurnIds(),
          itemId: "cmd-policy-failure",
          command: "pnpm test",
        },
        paramsForRun: params,
        ...codexTestTurnIds(),
        onNativeToolFailureDisposition,
      });

      expect(result).toEqual({ decision: "decline" });
      expect(onNativeToolFailureDisposition).toHaveBeenCalledWith(
        "cmd-policy-failure",
        disposition,
      );
    },
  );

  it.each([
    { reason: "turn_progress_idle_timeout", disposition: "timed_out" },
    { reason: "turn_completion_idle_timeout", disposition: "timed_out" },
    { reason: "turn_terminal_idle_timeout", disposition: "timed_out" },
    { reason: "client_closed", disposition: "failed" },
  ] as const)(
    "normalizes aborted approval reason $reason as $disposition",
    async ({ reason, disposition }) => {
      const params = createParams();
      const controller = new AbortController();
      controller.abort(reason);
      const onNativeToolFailureDisposition = vi.fn();
      mockRunBeforeToolCallHook.mockResolvedValueOnce({
        blocked: true,
        kind: "failure",
        disposition: "cancelled",
        deniedReason: "plugin-before-tool-call",
        reason: "Approval cancelled because the run stopped",
      });

      const result = await handleCodexAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          ...codexTestTurnIds(),
          itemId: "cmd-aborted-policy",
          command: "pnpm test",
        },
        paramsForRun: params,
        ...codexTestTurnIds(),
        signal: controller.signal,
        onNativeToolFailureDisposition,
      });

      expect(result).toEqual({ decision: "cancel" });
      expect(onNativeToolFailureDisposition).toHaveBeenCalledWith(
        "cmd-aborted-policy",
        disposition,
      );
    },
  );

  it("describes command approvals from parsed command actions when available", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-actions", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-actions", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-actions",
        command: "bash -lc 'pnpm test extensions/codex'",
        commandActions: [{ command: "pnpm test extensions/codex" }],
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    const requestPayload = gatewayRequestPayload();
    expect(String(requestPayload.description)).toContain("Command: pnpm test extensions/codex");
    expect(String(requestPayload.description)).not.toContain("bash -lc");
    expect(mockRunBeforeToolCallHook.mock.calls.at(0)?.[0]).toMatchObject({
      toolName: "exec",
      params: {
        command: "bash -lc 'pnpm test extensions/codex'",
      },
    });
    findApprovalEvent(params, { command: "pnpm test extensions/codex" });
  });

  it("describes command approval permission and policy amendments", async () => {
    const params = createParams();
    params.hostCapabilities = {
      ...params.hostCapabilities,
      prepareMutableFileApproval: prepareApprovalWithoutMutableFile,
    };
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-command-permissions", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-command-permissions",
        decision: "allow-always",
      });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-permissions",
        command: "npm install",
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: {
            write: ["/"],
          },
        },
        proposedExecpolicyAmendment: ["npm install"],
        proposedNetworkPolicyAmendments: [{ host: "registry.npmjs.org", action: "allow" }],
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "acceptForSession" });
    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("Command: npm install");
    expect(description).toContain("Additional permissions: network, fileSystem");
    expect(description).toContain("High-risk targets: network access, filesystem root");
    expect(description).toContain("Network enabled: true");
    expect(description).toContain("File system write: /");
    expect(description).toContain("Proposed exec policy: npm install");
    expect(description).toContain("Proposed network policy: allow registry.npmjs.org");
  });

  it("keeps command approval permission details visible after long command previews", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-long-command-permissions", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-long-command-permissions",
        decision: "allow-always",
      });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-long-permissions",
        command: `${"npm install ".repeat(500)} --unsafe-perm`,
        additionalPermissions: {
          network: { enabled: true },
          fileSystem: {
            write: ["/"],
          },
        },
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("[preview truncated or unsafe content omitted]");
    expect(description).toContain("Additional permissions: network, fileSystem");
    expect(description).toContain("High-risk targets: network access, filesystem root");
  });

  it("sanitizes command previews before forwarding approval text and events", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-sanitized-command", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-sanitized-command", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-sanitized",
        command: "printf safe",
        commandActions: [
          { command: "pnpm test\n--watch \u001b[31mextensions/codex/src/app-server\u001b[0m" },
        ],
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(gatewayRequestPayload().description).toBe(
      "Command: pnpm test --watch extensions/codex/src/app-server",
    );
    findApprovalEvent(params, {
      status: "pending",
      command: "pnpm test --watch extensions/codex/src/app-server",
    });
  });

  it("escapes command approval previews before forwarding approval text and events", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-escaped-command", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-escaped-command", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-escaped",
        command: "printf '<@U123> [trusted](https://evil) @here'",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    const description = String(gatewayRequestPayload().description);
    expect(description).toContain(
      "printf '&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here'",
    );
    expect(description).not.toContain("<@U123>");
    expect(description).not.toContain("[trusted](https://evil)");
    expect(description).not.toContain("@here");
    findApprovalEvent(params, {
      command: "printf '&lt;\uff20U123&gt; \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here'",
    });
  });

  it("preserves visible OSC-8 link labels in command previews", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-osc", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-osc", decision: "allow-once" });
    const esc = "\u001b";

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-osc",
        command: "printf safe",
        commandActions: [
          {
            command: `prefix ${esc}]8;;https://example.com${esc}\\VISIBLE${esc}]8;;${esc}\\ suffix`,
          },
        ],
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(gatewayRequestPayload().description).toBe("Command: prefix VISIBLE suffix");
    findApprovalEvent(params, { command: "prefix VISIBLE suffix" });
  });

  it("strips bidi and invisible formatting controls from command previews", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-bidi", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-bidi", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-bidi",
        command: "echo safe\u202e cod.exe\u2066 hidden\u2069 \ufeffdone\u{e0100}",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(gatewayRequestPayload().description).toBe("Command: echo safe cod.exe hidden done");
    findApprovalEvent(params, { command: "echo safe cod.exe hidden done" });
  });

  it("marks oversized unsafe command previews as omitted", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-omitted-command", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-omitted-command", decision: "allow-once" });
    const esc = "\u001b";
    const oversizedPrefix = `${esc}]8;;https://example.com${esc}\\`.repeat(300);

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-omitted",
        command: "printf safe",
        commandActions: [{ command: oversizedPrefix }, { command: "TAIL" }],
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(gatewayRequestPayload().description).toBe(
      "Command: [preview truncated or unsafe content omitted]",
    );
    const omittedEvent = findApprovalEvent(params, {});
    expect(omittedEvent.commandPreviewOmitted).toBe(true);
  });

  it("marks clipped command previews even when a safe prefix remains", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-clipped-command", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-clipped-command", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-clipped",
        command: "printf safe",
        commandActions: [{ command: `${"a".repeat(5000)} tail` }],
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("[preview truncated or unsafe content omitted]");
    const omittedEvent = findApprovalEvent(params, {});
    expect(omittedEvent.commandPreviewOmitted).toBe(true);
  });

  it("does not trust request-time decisions for two-phase command approvals", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({
        id: "plugin:approval-untrusted",
        status: "accepted",
        decision: "allow-always",
      })
      .mockResolvedValueOnce({ id: "plugin:approval-untrusted", decision: "deny" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-untrusted",
        command: "pnpm test",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    findApprovalEvent(params, {
      status: "denied",
      approvalId: "plugin:approval-untrusted",
    });
  });

  it("only treats own null data-property request decisions as no-route", async () => {
    const params = createParams();
    const inheritedDecisionResult = Object.assign(Object.create({ decision: null }), {
      id: "plugin:approval-inherited",
      status: "accepted",
    });
    mockCallGatewayTool
      .mockResolvedValueOnce(inheritedDecisionResult)
      .mockResolvedValueOnce({ id: "plugin:approval-inherited", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-inherited",
        command: "pnpm test",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "accept" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });

  it("does not invoke request-time decision accessors", async () => {
    const params = createParams();
    const requestResult = {
      id: "plugin:approval-accessor",
      status: "accepted",
      get decision() {
        throw new Error("decision getter must not run");
      },
    };
    mockCallGatewayTool
      .mockResolvedValueOnce(requestResult)
      .mockResolvedValueOnce({ id: "plugin:approval-accessor", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-accessor",
        command: "pnpm test",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "accept" });
  });

  it("does not fail when request-time decision descriptors throw", async () => {
    const params = createParams();
    const requestResult = new Proxy(
      { id: "plugin:approval-proxy", status: "accepted" },
      {
        getOwnPropertyDescriptor(target, property) {
          if (property === "decision") {
            throw new Error("descriptor trap must not fail approval");
          }
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    mockCallGatewayTool
      .mockResolvedValueOnce(requestResult)
      .mockResolvedValueOnce({ id: "plugin:approval-proxy", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-proxy",
        command: "pnpm test",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "accept" });
  });

  it("fails closed when no approval route is available", async () => {
    const params = createParams();
    const onNativeToolFailureDisposition = vi.fn();
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "plugin:approval-2",
      decision: null,
    });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/fileChange/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "patch-1",
        reason: "needs write access",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      onNativeToolFailureDisposition,
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool).toHaveBeenCalledTimes(1);
    expect(onNativeToolFailureDisposition).toHaveBeenCalledWith("patch-1", "failed");
    findApprovalEvent(params, { status: "unavailable", reason: "needs write access" });
  });

  it("fails closed when waitDecision reports a stale approval id", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-stale", status: "accepted" })
      .mockRejectedValueOnce(new Error("approval expired or not found"));

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/fileChange/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "patch-stale",
        reason: "needs write access",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({ decision: "decline" });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    findApprovalEvent(params, {
      status: "unavailable",
      approvalId: "plugin:approval-stale",
      reason: "needs write access",
      message: "Codex app-server approval unavailable.",
    });
  });

  it("does not classify a matching abort reason as a stale gateway wait", async () => {
    const controller = new AbortController();
    mockCallGatewayTool.mockImplementationOnce(() => new Promise(() => {}));

    const pending = waitForPluginApprovalDecision({
      hostCapabilities: createParams().hostCapabilities,
      approvalId: "plugin:approval-abort",
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mockCallGatewayTool).toHaveBeenCalledOnce());
    controller.abort(new Error("approval expired or not found"));

    await expect(pending).rejects.toThrow("approval expired or not found");
  });

  it("uses the gateway terminal reason as the authoritative approval timeout", async () => {
    const params = createParams();
    const onNativeToolFailureDisposition = vi.fn();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-expired", status: "accepted" })
      .mockResolvedValueOnce({
        id: "plugin:approval-expired",
        decision: "deny",
        terminalReason: "timeout",
      });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-expired",
        command: "pnpm test",
        availableDecisions: ["accept", "cancel"],
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      onNativeToolFailureDisposition,
    });

    expect(result).toEqual({ decision: "decline" });
    expect(onNativeToolFailureDisposition).toHaveBeenCalledWith(
      "cmd-expired",
      "timed_out",
      "command",
    );
    findApprovalEvent(params, {
      status: "denied",
      approvalId: "plugin:approval-expired",
      message: codexApprovalTimeoutText("command"),
    });
  });

  it("ignores waitDecision replies bound to a different approval id", async () => {
    const params = createParams();
    const onNativeToolFailureDisposition = vi.fn();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-mismatch", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-other", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-mismatch",
        command: "pnpm test",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
      onNativeToolFailureDisposition,
    });

    // A misrouted allow for another approval must not release this gate.
    expect(result).toEqual({ decision: "decline" });
    expect(onNativeToolFailureDisposition).toHaveBeenCalledWith("cmd-mismatch", "failed");
    findApprovalEvent(params, {
      status: "unavailable",
      approvalId: "plugin:approval-mismatch",
    });
  });

  it("sanitizes reason previews before forwarding approval text and events", async () => {
    const params = createParams();
    mockCallGatewayTool.mockResolvedValueOnce({
      id: "plugin:approval-sanitized-reason",
      decision: null,
    });

    await handleCodexAppServerApprovalRequest({
      method: "item/fileChange/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "patch-sanitized",
        reason: "needs write access\nfor \u001b[31m/tmp\u001b[0m\tplease",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(gatewayRequestPayload().description).toBe("Reason: needs write access for /tmp please");
    findApprovalEvent(params, {
      status: "unavailable",
      reason: "needs write access for /tmp please",
    });
  });

  it("routes unknown approval methods to the human path and still fails closed", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:future-approval", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:future-approval", decision: "deny" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "future/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "future-1",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({
      decision: "decline",
      reason: "OpenClaw codex app-server bridge does not grant native approvals yet.",
    });
    expect(mockRunBeforeToolCallHook).not.toHaveBeenCalled();
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
    findApprovalEvent(params, {
      status: "denied",
      approvalId: "plugin:future-approval",
    });
  });
  it("labels permission approvals explicitly with permission detail", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-3", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-3", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "perm-1",
        permissions: {
          network: { allowHosts: ["example.com", "*.internal"] },
          fileSystem: { roots: ["/"], writePaths: ["/home/simone"] },
        },
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({
      permissions: {
        network: { allowHosts: ["example.com", "*.internal"] },
        fileSystem: { roots: ["/"], writePaths: ["/home/simone"] },
      },
      scope: "turn",
    });
    expect(gatewayCallMethod()).toBe("plugin.approval.request");
    expect(typeof gatewayCallAt(0)[1]).toBe("object");
    const requestPayload = gatewayRequestPayload();
    expect(requestPayload.title).toBe("Codex app-server permission approval");
    expect(requestPayload.toolName).toBe("codex_permission_approval");
    const description = String(requestPayload.description);
    expect(description).toContain("Permissions: network, fileSystem");
    expect(gatewayCallOptions()).toEqual({ expectFinal: false });
    expect(description).toContain("Network allowHosts: example.com, *.internal");
    expect(description).toContain("File system roots: /; writePaths: ~");
    expect(description).toContain(
      "High-risk targets: wildcard hosts, private-network wildcards, filesystem root",
    );
    expect(description).not.toContain("agent:main:session-1");
  });

  it("keeps permission detail bounded with truncated and compacted target samples", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-4", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-4", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "perm-2",
        permissions: {
          network: {
            allowHosts: [
              "https://secret-token@example.com/private",
              "*.internal",
              "very-long-service-name.example.corp",
              "third.example.com",
            ],
          },
          fileSystem: {
            roots: ["/", "/workspace/project", "/Users/simone/Documents"],
            readPaths: ["/Users/simone/.ssh/id_rsa", "/etc/hosts", "/var/log/system.log"],
            writePaths: ["/tmp/output", "/var/log/app", "/home/simone/private"],
          },
        },
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    const description = String(gatewayRequestPayload().description);
    expect(description.length).toBeLessThanOrEqual(700);
    expect(description).toContain("example.com");
    expect(description).not.toContain("secret-token");
    expect(description).not.toContain("simone");
    expect(description).toContain("*.internal");
    expect(description).toContain("/workspace/project");
    expect(description).toContain("High-risk targets:");
    expect(description).toContain("readPaths: ~/.ssh/id_rsa, /etc/hosts");
  });

  it("describes current protocol network and filesystem permission grants", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-current-permissions", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-current-permissions", decision: "allow-once" });

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "perm-current",
        permissions: {
          network: { enabled: true },
          fileSystem: {
            read: ["/Users/simone/.ssh/id_rsa"],
            write: ["/"],
            entries: [
              { path: "/workspace/project", access: "read" },
              { path: "/tmp/output", access: "write" },
              { path: "/ignored", access: "none" },
            ],
          },
        },
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toEqual({
      permissions: {
        network: { enabled: true },
        fileSystem: {
          read: ["/Users/simone/.ssh/id_rsa"],
          write: ["/"],
          entries: [
            { path: "/workspace/project", access: "read" },
            { path: "/tmp/output", access: "write" },
            { path: "/ignored", access: "none" },
          ],
        },
      },
      scope: "turn",
    });
    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("Network enabled: true");
    expect(description).toContain("File system read: ~/.ssh/id_rsa; write: /");
    expect(description).toContain("entries: read /workspace/project, write /tmp/output (+1 more)");
    expect(description).toContain("High-risk targets: network access, filesystem root");
  });

  it("compacts Windows home paths in permission descriptions", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-windows-home", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-windows-home", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "perm-windows-home",
        permissions: {
          fileSystem: {
            roots: ["C:/Users/alice"],
            readPaths: ["C:\\Users\\alice\\.ssh\\id_rsa", "c:/users/bob/project"],
          },
        },
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("File system roots: ~; readPaths: ~/.ssh/id_rsa, ~/project");
    expect(description).not.toContain("High-risk targets");
  });

  it("strips terminal and invisible controls from permission descriptions", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-permission-controls", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-permission-controls", decision: "allow-once" });

    await handleCodexAppServerApprovalRequest({
      method: "item/permissions/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "perm-controls",
        permissions: {
          network: { allowHosts: ["exa\u009b31mmple.com", "safe\u202e.example.com"] },
          fileSystem: { roots: ["/tmp/\u001b[31mproject\u001b[0m"] },
        },
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    const description = String(gatewayRequestPayload().description);
    expect(description).toContain("example.com");
    expect(description).toContain("safe .example.com");
    expect(description).toContain("/tmp/project");
    expect(description).not.toContain("\u009b");
    expect(description).not.toContain("\u202e");
    expect(description).not.toContain("\u001b");
  });

  it("ignores approval requests that are missing explicit thread or turn ids", async () => {
    const params = createParams();

    const result = await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        itemId: "cmd-2",
        command: "pnpm test",
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    expect(result).toBeUndefined();
    expect(mockCallGatewayTool).not.toHaveBeenCalled();
    expect(params.onAgentEvent).not.toHaveBeenCalled();
  });

  it("does not split surrogate pairs when truncating command previews", async () => {
    const params = createParams();
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-utf16-safe", status: "accepted" })
      .mockResolvedValueOnce({ id: "plugin:approval-utf16-safe", decision: "allow-once" });

    // 176 "a" + "😀" + "tail" = 182 chars. The emoji at positions 176-177 crosses the
    // 180-char truncate() boundary (180 - 3 = 177). Old raw slice(0, 177) would keep the
    // lone high surrogate; truncateUtf16Safe backs off to 176.
    const command = `${"a".repeat(176)}😀tail`;

    await handleCodexAppServerApprovalRequest({
      method: "item/commandExecution/requestApproval",
      requestParams: {
        ...codexTestTurnIds(),
        itemId: "cmd-utf16",
        command: "printf safe",
        commandActions: [{ command }],
      },
      paramsForRun: params,
      ...codexTestTurnIds(),
    });

    const event = findApprovalEvent(params, { status: "pending" });
    expect(event.command).toBe(`${"a".repeat(176)}...`);

    const description = String(gatewayRequestPayload().description);
    expect(description).toContain(`${"a".repeat(176)}...`);
  });

  it.each([
    ["string command", { command: `${"\u0000".repeat(4095)}😀tail` }],
    ["command array", { command: [`${"\u0000".repeat(4095)}😀tail`] }],
    [
      "command actions",
      {
        command: "printf safe",
        commandActions: [{ command: `${"\u0000".repeat(4095)}😀tail` }],
      },
    ],
  ])(
    "does not expose split surrogate pairs from the preview scan cap: %s",
    async (label, input) => {
      const params = createParams();
      mockCallGatewayTool
        .mockResolvedValueOnce({ id: "plugin:approval-utf16-scan", status: "accepted" })
        .mockResolvedValueOnce({ id: "plugin:approval-utf16-scan", decision: "allow-once" });

      await handleCodexAppServerApprovalRequest({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          ...codexTestTurnIds(),
          itemId: "cmd-utf16-scan",
          ...input,
        },
        paramsForRun: params,
        ...codexTestTurnIds(),
      });

      const bindable = label === "command actions";
      const event = findApprovalEvent(params, { status: bindable ? "pending" : "denied" });
      expect(event.commandPreviewOmitted).toBe(true);
      expect(event.command).toBeUndefined();
      if (bindable) {
        const description = String(gatewayRequestPayload().description);
        expect(description).not.toContain(String.fromCharCode(0xd83d));
        expect(() => encodeURIComponent(description)).not.toThrow();
      } else {
        expect(mockCallGatewayTool).not.toHaveBeenCalled();
        expect(() => encodeURIComponent(JSON.stringify(event))).not.toThrow();
      }
    },
  );

  it("does not split surrogate pairs at gateway title and description caps", async () => {
    mockCallGatewayTool.mockResolvedValueOnce({ id: "plugin:approval-utf16-gateway" });

    await requestPluginApproval({
      hostCapabilities: createParams().hostCapabilities,
      title: `${"t".repeat(76)}😀tail`,
      description: `${"d".repeat(508)}😀tail`,
      severity: "warning",
      toolName: "codex_utf16_test",
    });

    const payload = gatewayRequestPayload();
    expect(payload.title).toBe(`${"t".repeat(76)}...`);
    expect(payload.description).toBe(`${"d".repeat(508)}...`);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
