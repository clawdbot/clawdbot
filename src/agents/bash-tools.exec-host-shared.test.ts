/**
 * Shared exec-host approval helper tests.
 * Covers follow-up failure dedupe, elevated handoffs, policy merging, and
 * unavailable approval surfaces.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimExecApprovalFollowupRuntimeHandoff,
  finalizeExecApprovalFollowupRuntimeHandoff,
  isExecApprovalFollowupSessionRebound,
  registerExecApprovalFollowupRuntimeHandoff,
} from "./bash-tools.exec-approval-followup-state.js";
import {
  buildExecApprovalPendingToolResult,
  createAndRegisterDefaultExecApprovalRequest,
  resolveExecApprovalDecisionState,
  resolveExecApprovalWaitOutcome,
  resolveExecHostApprovalContext,
  sendExecApprovalFollowupResult,
  shouldResolveExecApprovalUnavailableInline,
} from "./bash-tools.exec-host-shared.js";

const mocks = vi.hoisted(() => ({
  resolveExecApprovals: vi.fn(async () => ({
    defaults: {
      security: "allowlist",
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    agent: {
      security: "allowlist",
      ask: "off",
      askFallback: "deny",
      autoAllowSkills: false,
    },
    allowlist: [],
    file: { version: 1, agents: {} },
    hash: "approvals-hash",
  })),
  approvalRunAbortedError: new Error("approval owning run aborted"),
  resolveRegisteredExecApprovalDecision: vi.fn(async (): Promise<string | null> => "allow-once"),
}));

vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  return {
    ...mod,
    resolveExecApprovalsLocked: mocks.resolveExecApprovals,
  };
});

vi.mock("./bash-tools.exec-approval-request.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./bash-tools.exec-approval-request.js")>();
  return {
    ...mod,
    isExecApprovalRunAbortedError: (error: unknown) => error === mocks.approvalRunAbortedError,
    resolveRegisteredExecApprovalDecision: mocks.resolveRegisteredExecApprovalDecision,
  };
});

describe("sendExecApprovalFollowupResult", () => {
  const sendExecApprovalFollowup = vi.fn();
  const logWarn = vi.fn();

  beforeEach(() => {
    sendExecApprovalFollowup.mockReset();
    logWarn.mockReset();
    mocks.resolveExecApprovals.mockReset();
    mocks.resolveExecApprovals.mockResolvedValue({
      defaults: {
        security: "allowlist",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
      agent: {
        security: "allowlist",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
      allowlist: [],
      file: { version: 1, agents: {} },
      hash: "approvals-hash",
    });
  });

  function firstExecApprovalFollowupCall():
    | {
        internalRuntimeHandoffId?: string;
        idempotencyKey?: string;
        execApprovalFollowupToken?: string;
        expectedSessionId?: string;
        bashElevated?: unknown;
      }
    | undefined {
    return sendExecApprovalFollowup.mock.calls[0]?.[0] as
      | {
          internalRuntimeHandoffId?: string;
          idempotencyKey?: string;
          execApprovalFollowupToken?: string;
          expectedSessionId?: string;
          bashElevated?: unknown;
        }
      | undefined;
  }

  it("logs repeated followup dispatch failures once per approval id and error message", async () => {
    sendExecApprovalFollowup.mockRejectedValue(new Error("Channel is required"));

    const target = {
      approvalId: "approval-log-once",
      sessionKey: "agent:main:main",
    };
    const deps = { sendExecApprovalFollowup, logWarn };
    await sendExecApprovalFollowupResult(target, "Exec finished", deps);
    await sendExecApprovalFollowupResult(target, "Exec finished", deps);

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(
      "exec approval followup dispatch failed (id=approval-log-once): Channel is required",
    );
  });

  it.each([
    {
      name: "direct gateway code",
      error: Object.assign(new Error("approval not found"), {
        gatewayCode: "APPROVAL_NOT_FOUND",
      }),
    },
    {
      name: "structured invalid-request details",
      error: Object.assign(new Error("approval not found"), {
        gatewayCode: "INVALID_REQUEST",
        details: { reason: "APPROVAL_NOT_FOUND" },
      }),
    },
    {
      name: "legacy message-only error",
      error: new Error("unknown or expired approval id"),
    },
  ])("suppresses approval-not-found followup dispatch failures ($name)", async ({ error }) => {
    sendExecApprovalFollowup.mockRejectedValue(error);

    await sendExecApprovalFollowupResult(
      {
        approvalId: "approval-expired",
        sessionKey: "agent:main:main",
      },
      "Exec finished",
      { sendExecApprovalFollowup, logWarn },
    );

    expect(logWarn).not.toHaveBeenCalled();
  });

  it("evicts oldest followup failure dedupe keys after reaching the cap", async () => {
    sendExecApprovalFollowup.mockRejectedValue(new Error("Channel is required"));
    const deps = { sendExecApprovalFollowup, logWarn };
    const failureKeysBeyondDedupeWindow = 257;

    for (let i = 0; i < failureKeysBeyondDedupeWindow; i += 1) {
      await sendExecApprovalFollowupResult(
        {
          approvalId: `approval-${i}`,
          sessionKey: "agent:main:main",
        },
        "Exec finished",
        deps,
      );
    }
    await sendExecApprovalFollowupResult(
      {
        approvalId: "approval-0",
        sessionKey: "agent:main:main",
      },
      "Exec finished",
      deps,
    );

    expect(logWarn).toHaveBeenCalledTimes(failureKeysBeyondDedupeWindow + 1);
    expect(logWarn).toHaveBeenLastCalledWith(
      "exec approval followup dispatch failed (id=approval-0): Channel is required",
    );
  });

  it("registers elevated defaults behind an internal token for agent followups", async () => {
    sendExecApprovalFollowup.mockResolvedValue(true);
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };

    await sendExecApprovalFollowupResult(
      {
        approvalId: "approval-elevated-75832",
        sessionKey: "agent:main:telegram:direct:123",
        turnSourceChannel: "telegram",
        bashElevated,
      },
      "Exec finished",
      { sendExecApprovalFollowup, logWarn },
    );

    const call = firstExecApprovalFollowupCall();
    if (!call) {
      throw new Error("Expected elevated exec approval followup call");
    }
    expect(call.internalRuntimeHandoffId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(call.idempotencyKey).toMatch(/^exec-approval-followup:approval-elevated-75832:nonce:/);
    expect(call.idempotencyKey).not.toContain(call.internalRuntimeHandoffId ?? "");
    expect(call).not.toHaveProperty("bashElevated");
    expect(call).not.toHaveProperty("execApprovalFollowupToken");
    expect(
      claimExecApprovalFollowupRuntimeHandoff({
        handoffId: call.internalRuntimeHandoffId ?? "",
        approvalId: "approval-elevated-75832",
        idempotencyKey: call.idempotencyKey ?? "",
        sessionKey: "agent:main:telegram:direct:wrong",
        claimId: "wrong-session-run",
      }),
    ).toBeUndefined();
    expect(
      claimExecApprovalFollowupRuntimeHandoff({
        handoffId: call.internalRuntimeHandoffId ?? "",
        approvalId: "approval-elevated-75832",
        idempotencyKey: call.idempotencyKey ?? "",
        sessionKey: "agent:main:telegram:direct:123",
        claimId: "elevated-run",
      }),
    ).toEqual({
      kind: "exec-approval-followup",
      approvalId: "approval-elevated-75832",
      sessionKey: "agent:main:telegram:direct:123",
      idempotencyKey: call.idempotencyKey,
      bashElevated,
      resultText: "Exec finished",
    });
    expect(
      claimExecApprovalFollowupRuntimeHandoff({
        handoffId: call.internalRuntimeHandoffId ?? "",
        approvalId: "approval-elevated-75832",
        idempotencyKey: call.idempotencyKey ?? "",
        sessionKey: "agent:main:telegram:direct:123",
        claimId: "competing-run",
      }),
    ).toBeUndefined();
    expect(
      finalizeExecApprovalFollowupRuntimeHandoff({
        handoffId: call.internalRuntimeHandoffId,
        claimId: "elevated-run",
      }),
    ).toBe(true);
  });

  it("does not register elevated runtime handoffs when the process clock is invalid", () => {
    const registration = registerExecApprovalFollowupRuntimeHandoff({
      approvalId: "approval-elevated-invalid-clock",
      sessionKey: "agent:main:telegram:direct:123",
      bashElevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "on",
      },
      nowMs: Number.NaN,
    });

    expect(registration).toBeUndefined();
  });

  it("does not register elevated runtime handoffs for denied followups", async () => {
    sendExecApprovalFollowup.mockResolvedValue(false);
    const bashElevated = {
      enabled: true,
      allowed: true,
      defaultLevel: "on" as const,
    };

    await sendExecApprovalFollowupResult(
      {
        approvalId: "approval-denied-elevated-75832",
        sessionKey: "agent:main:telegram:direct:123",
        turnSourceChannel: "telegram",
        bashElevated,
      },
      "Exec denied (gateway id=approval-denied-elevated-75832, user-denied): uname -a",
      { sendExecApprovalFollowup, logWarn },
    );

    const call = firstExecApprovalFollowupCall();
    expect(call).not.toHaveProperty("internalRuntimeHandoffId");
    expect(call).not.toHaveProperty("idempotencyKey");
    expect(call).not.toHaveProperty("bashElevated");
  });

  it("registers result text behind an authenticated handoff for non-elevated followups", async () => {
    sendExecApprovalFollowup.mockResolvedValue(true);

    await sendExecApprovalFollowupResult(
      {
        approvalId: "approval-normal-75832",
        sessionKey: "agent:main:telegram:direct:123",
        turnSourceChannel: "telegram",
      },
      "Exec finished",
      { sendExecApprovalFollowup, logWarn },
    );

    const call = firstExecApprovalFollowupCall();
    if (!call) {
      throw new Error("Expected non-elevated exec approval followup call");
    }
    expect(call.internalRuntimeHandoffId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(call.idempotencyKey).toMatch(/^exec-approval-followup:approval-normal-75832:nonce:/);
    expect(call).not.toHaveProperty("bashElevated");
    expect(
      claimExecApprovalFollowupRuntimeHandoff({
        handoffId: call.internalRuntimeHandoffId ?? "",
        approvalId: "approval-normal-75832",
        idempotencyKey: call.idempotencyKey ?? "",
        sessionKey: "agent:main:telegram:direct:123",
        claimId: "normal-run",
      }),
    ).toEqual({
      kind: "exec-approval-followup",
      approvalId: "approval-normal-75832",
      sessionKey: "agent:main:telegram:direct:123",
      idempotencyKey: call.idempotencyKey,
      resultText: "Exec finished",
    });
    expect(
      finalizeExecApprovalFollowupRuntimeHandoff({
        handoffId: call.internalRuntimeHandoffId,
        claimId: "normal-run",
      }),
    ).toBe(true);
  });

  it("forwards the approval-time session id to the followup dispatch (non-elevated)", async () => {
    sendExecApprovalFollowup.mockResolvedValue(true);

    await sendExecApprovalFollowupResult(
      {
        approvalId: "approval-session-pin-59349",
        sessionKey: "agent:main:telegram:direct:123",
        expectedSessionId: "session-original",
        turnSourceChannel: "telegram",
      },
      "Exec finished",
      { sendExecApprovalFollowup, logWarn },
    );

    expect(firstExecApprovalFollowupCall()?.expectedSessionId).toBe("session-original");
  });

  it("forwards the prepared agent owner to the followup dispatch", async () => {
    sendExecApprovalFollowup.mockResolvedValue(true);

    await sendExecApprovalFollowupResult(
      {
        approvalId: "approval-bare-owner",
        agentId: "research",
        sessionKey: "global",
      },
      "Exec finished",
      { sendExecApprovalFollowup, logWarn },
    );

    expect(sendExecApprovalFollowup).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "research", sessionKey: "global" }),
    );
  });
});

describe("isExecApprovalFollowupSessionRebound", () => {
  it("flags a rebound session when the resolved id differs from the approval-time id", () => {
    expect(
      isExecApprovalFollowupSessionRebound({
        expectedSessionId: "session-original",
        resolvedSessionId: "session-after-reset",
      }),
    ).toBe(true);
  });

  it("keeps the followup when the session id is unchanged", () => {
    expect(
      isExecApprovalFollowupSessionRebound({
        expectedSessionId: "session-original",
        resolvedSessionId: "session-original",
      }),
    ).toBe(false);
  });

  it("does not drop when either session id is missing", () => {
    expect(isExecApprovalFollowupSessionRebound({ resolvedSessionId: "session-after-reset" })).toBe(
      false,
    );
    expect(isExecApprovalFollowupSessionRebound({ expectedSessionId: "session-original" })).toBe(
      false,
    );
    expect(isExecApprovalFollowupSessionRebound({})).toBe(false);
  });
});

describe("resolveExecHostApprovalContext", () => {
  it("does not let exec-approvals.json broaden security beyond the requested policy", async () => {
    mocks.resolveExecApprovals.mockResolvedValue({
      defaults: {
        security: "allowlist",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
      agent: {
        security: "full",
        ask: "off",
        askFallback: "deny",
        autoAllowSkills: false,
      },
      allowlist: [],
      file: { version: 1, agents: {} },
      hash: "approvals-hash",
    });

    const result = await resolveExecHostApprovalContext({
      agentId: "agent-main",
      security: "allowlist",
      ask: "off",
      host: "gateway",
    });

    expect(result.hostSecurity).toBe("allowlist");
  });

  it("does not let host ask=off suppress a stricter requested ask mode", async () => {
    mocks.resolveExecApprovals.mockResolvedValue({
      defaults: {
        security: "full",
        ask: "off",
        askFallback: "full",
        autoAllowSkills: false,
      },
      agent: {
        security: "full",
        ask: "off",
        askFallback: "full",
        autoAllowSkills: false,
      },
      allowlist: [],
      file: { version: 1, agents: {} },
      hash: "approvals-hash",
    });

    const result = await resolveExecHostApprovalContext({
      agentId: "agent-main",
      security: "full",
      ask: "always",
      host: "gateway",
    });

    expect(result.hostAsk).toBe("always");
  });

  it("clamps askFallback to the effective host security", async () => {
    mocks.resolveExecApprovals.mockResolvedValue({
      defaults: {
        security: "full",
        ask: "always",
        askFallback: "full",
        autoAllowSkills: false,
      },
      agent: {
        security: "full",
        ask: "always",
        askFallback: "full",
        autoAllowSkills: false,
      },
      allowlist: [],
      file: { version: 1, agents: {} },
      hash: "approvals-hash",
    });

    const result = await resolveExecHostApprovalContext({
      agentId: "agent-main",
      security: "allowlist",
      ask: "always",
      host: "gateway",
    });

    expect(result.askFallback).toBe("allowlist");
  });
});

describe("resolveExecApprovalDecisionState", () => {
  it.each([
    {
      name: "keeps fail-closed timeout denial",
      decision: null,
      askFallback: "deny" as const,
      requiresExplicitApproval: false,
      expected: { approvedByAsk: false, deniedReason: "approval-timeout" },
    },
    {
      name: "accepts explicit approval across strict boundaries",
      decision: "allow-once",
      askFallback: "deny" as const,
      requiresExplicitApproval: true,
      expected: { approvedByAsk: true, deniedReason: null },
    },
  ])("$name", async ({ decision, askFallback, requiresExplicitApproval, expected }) => {
    await expect(
      resolveExecApprovalDecisionState({
        decision,
        askFallback,
        requiresExplicitApproval,
      }),
    ).resolves.toMatchObject(expected);
  });

  it("applies current timeout policy before enforcing human-only approval", async () => {
    const timeoutContext = { requiresExplicitApproval: true, policy: "current" };

    await expect(
      resolveExecApprovalDecisionState({
        decision: null,
        askFallback: "full",
        resolveTimedOut: async () => ({
          approvedByAsk: true,
          deniedReason: null,
          context: timeoutContext,
        }),
        requiresExplicitApproval: (context) => context?.requiresExplicitApproval === true,
      }),
    ).resolves.toEqual({
      baseDecision: { approvedByAsk: true, deniedReason: null, timedOut: true },
      approvedByAsk: false,
      deniedReason: "approval-timeout",
      timeoutContext,
    });
  });
});

describe("resolveExecApprovalWaitOutcome", () => {
  beforeEach(() => {
    mocks.resolveRegisteredExecApprovalDecision.mockReset();
    mocks.resolveRegisteredExecApprovalDecision.mockResolvedValue("allow-once");
  });

  it.each([
    ["allow-once", true, null],
    ["allow-always", true, null],
    ["deny", false, "user-denied"],
  ] as const)("returns a resolved %s decision", async (decision, approvedByAsk, deniedReason) => {
    mocks.resolveRegisteredExecApprovalDecision.mockResolvedValue(decision);

    await expect(
      resolveExecApprovalWaitOutcome({
        approvalId: "approval-1",
        preResolvedDecision: undefined,
        askFallback: "deny",
        requiresExplicitApproval: false,
      }),
    ).resolves.toMatchObject({
      kind: "resolved",
      decision,
      state: { approvedByAsk, deniedReason },
    });
  });

  it("applies timeout policy before returning a resolved outcome", async () => {
    mocks.resolveRegisteredExecApprovalDecision.mockResolvedValue(null);

    await expect(
      resolveExecApprovalWaitOutcome({
        approvalId: "approval-timeout",
        preResolvedDecision: undefined,
        askFallback: "full",
        resolveTimedOut: async () => ({ approvedByAsk: false, deniedReason: "policy-revoked" }),
        requiresExplicitApproval: false,
      }),
    ).resolves.toMatchObject({
      kind: "resolved",
      decision: null,
      state: { approvedByAsk: false, deniedReason: "policy-revoked" },
    });
  });

  it("classifies an approval waiter failure", async () => {
    mocks.resolveRegisteredExecApprovalDecision.mockRejectedValue(new Error("store unavailable"));

    await expect(
      resolveExecApprovalWaitOutcome({
        approvalId: "approval-failed",
        preResolvedDecision: undefined,
        askFallback: "deny",
        requiresExplicitApproval: false,
      }),
    ).resolves.toEqual({ kind: "request-failed" });
  });

  it("classifies owning-run cancellation", async () => {
    mocks.resolveRegisteredExecApprovalDecision.mockRejectedValue(mocks.approvalRunAbortedError);

    await expect(
      resolveExecApprovalWaitOutcome({
        approvalId: "approval-aborted",
        preResolvedDecision: undefined,
        askFallback: "deny",
        requiresExplicitApproval: false,
      }),
    ).resolves.toEqual({ kind: "run-aborted" });
  });

  it("does not consume a decision after the owning signal aborts", async () => {
    const controller = new AbortController();
    mocks.resolveRegisteredExecApprovalDecision.mockImplementation(async () => {
      controller.abort(new Error("run stopped"));
      return "allow-once";
    });

    await expect(
      resolveExecApprovalWaitOutcome({
        approvalId: "approval-aborted-after-wait",
        preResolvedDecision: undefined,
        signal: controller.signal,
        askFallback: "deny",
        requiresExplicitApproval: false,
      }),
    ).resolves.toEqual({ kind: "run-aborted" });
  });
});

describe("buildExecApprovalPendingToolResult", () => {
  function buildDisabledSurfaceApprovalResult(params: {
    channel: "discord" | "telegram";
    channelLabel: "Discord" | "Telegram";
    unavailableReason: "initiating-platform-disabled" | null;
    allowedDecisions?: readonly ("allow-once" | "deny")[];
  }) {
    return buildExecApprovalPendingToolResult({
      host: "gateway",
      command: "npm view diver name version description",
      cwd: process.cwd(),
      warningText: "",
      approvalId: "approval-id",
      approvalSlug: "approval-slug",
      expiresAtMs: Date.now() + 60_000,
      initiatingSurface: {
        kind: "disabled",
        channel: params.channel,
        channelLabel: params.channelLabel,
        accountId: "default",
      },
      sentApproverDms: false,
      unavailableReason: params.unavailableReason,
      ...(params.allowedDecisions ? { allowedDecisions: params.allowedDecisions } : {}),
    });
  }

  it("does not infer approver DM delivery from unavailable approval state", async () => {
    const state = await createAndRegisterDefaultExecApprovalRequest({
      warnings: [],
      approvalRunningNoticeMs: 1_000,
      createApprovalSlug: (approvalId) => approvalId,
      turnSourceChannel: "telegram",
      turnSourceAccountId: "default",
      register: async (approvalId) => ({
        id: approvalId,
        expiresAtMs: Date.now() + 60_000,
        finalDecision: null,
      }),
    });
    expect(state.sentApproverDms).toBe(false);
    expect(state.unavailableReason).toBe("no-approval-route");
  });

  it("resolves terminal no-route approvals inline", () => {
    expect(
      shouldResolveExecApprovalUnavailableInline({
        unavailableReason: "no-approval-route",
        preResolvedDecision: null,
      }),
    ).toBe(true);
  });

  it("keeps waiting when a route exists or a decision arrived", () => {
    expect(
      shouldResolveExecApprovalUnavailableInline({
        unavailableReason: null,
        preResolvedDecision: null,
      }),
    ).toBe(false);
    expect(
      shouldResolveExecApprovalUnavailableInline({
        unavailableReason: "no-approval-route",
        preResolvedDecision: "allow-once",
      }),
    ).toBe(false);
    expect(
      shouldResolveExecApprovalUnavailableInline({
        unavailableReason: "no-approval-route",
        preResolvedDecision: undefined,
      }),
    ).toBe(false);
    expect(
      shouldResolveExecApprovalUnavailableInline({
        unavailableReason: "initiating-platform-disabled",
        preResolvedDecision: null,
      }),
    ).toBe(false);
  });

  it("keeps a local /approve prompt when the initiating Discord surface is disabled", () => {
    const result = buildDisabledSurfaceApprovalResult({
      channel: "discord",
      channelLabel: "Discord",
      unavailableReason: null,
      allowedDecisions: ["allow-once", "deny"],
    });

    expect(result.details.status).toBe("approval-pending");
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(text).toContain("/approve approval-slug allow-once");
    expect(text).not.toContain("native chat exec approvals are not configured on Discord");
  });

  it("returns an unavailable reply when Discord exec approvals are disabled", () => {
    const result = buildDisabledSurfaceApprovalResult({
      channel: "discord",
      channelLabel: "Discord",
      unavailableReason: "initiating-platform-disabled",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.status).toBe("approval-unavailable");
    expect(details.reason).toBe("initiating-platform-disabled");
    expect(details.channel).toBe("discord");
    expect(details.channelLabel).toBe("Discord");
    expect(details.accountId).toBe("default");
    expect(details.host).toBe("gateway");
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(text).toContain("native chat exec approvals are not configured on Discord");
    expect(text).not.toContain("/approve");
    expect(text).not.toContain("Pending command:");
  });

  it("preserves node metadata in unavailable recovery guidance", () => {
    const result = buildExecApprovalPendingToolResult({
      host: "node",
      nodeId: "node-mac-1",
      command: "uname -a",
      cwd: "/tmp",
      warningText: "",
      approvalId: "approval-id",
      approvalSlug: "approval-slug",
      expiresAtMs: Date.now() + 60_000,
      initiatingSurface: {
        kind: "enabled",
        channel: undefined,
        channelLabel: "Web UI",
      },
      sentApproverDms: false,
      unavailableReason: "no-approval-route",
    });

    expect(result.details).toMatchObject({
      status: "approval-unavailable",
      host: "node",
      nodeId: "node-mac-1",
    });
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(text).toContain(
      "Print the Control UI URL with `openclaw dashboard --no-open`, open it in a browser, then use the approval inbox.",
    );
    expect(text).toContain(
      "Inspect the node's effective exec policy with `openclaw approvals get --node node-mac-1`.",
    );
  });

  it("keeps the Telegram unavailable reply when Discord DM approvals are not fully configured", () => {
    const result = buildDisabledSurfaceApprovalResult({
      channel: "telegram",
      channelLabel: "Telegram",
      unavailableReason: "initiating-platform-disabled",
    });

    const details = result.details as Record<string, unknown>;
    expect(details.status).toBe("approval-unavailable");
    expect(details.reason).toBe("initiating-platform-disabled");
    expect(details.channel).toBe("telegram");
    expect(details.channelLabel).toBe("Telegram");
    expect(details.accountId).toBe("default");
    expect(details.sentApproverDms).toBe(false);
    expect(details.host).toBe("gateway");
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(text).toContain("native chat exec approvals are not configured on Telegram");
    expect(text).not.toContain("/approve");
    expect(text).not.toContain("Pending command:");
    expect(text).not.toContain("Approver DMs were sent");
  });
});
