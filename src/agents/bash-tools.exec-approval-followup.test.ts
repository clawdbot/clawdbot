/**
 * Exec approval follow-up delivery tests.
 * Covers denied prompts, agent-session resume, wait handling, direct fallback,
 * and elevated runtime handoff routing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(async () => ({ status: "ok" })),
}));

vi.mock("../infra/outbound/message.js", () => ({
  sendMessage: vi.fn(async () => ({ ok: true })),
}));

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  onInternalDiagnosticEvent,
  onDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { sendMessage } from "../infra/outbound/message.js";
import { sendExecApprovalFollowup } from "./bash-tools.exec-approval-followup.js";
import { callGatewayTool } from "./tools/gateway.js";

const tempStoreDirs: string[] = [];

// Seed the same session store path the runtime reads; mocking this boundary
// would hide stale-session regressions in shared workers.
async function writeTempSessionStore(
  entries: Record<string, { sessionId: string }>,
): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-approval-followup-store-"));
  tempStoreDirs.push(dir);
  const storePath = path.join(dir, "sessions.json");
  await Promise.all(
    Object.entries(entries).map(([sessionKey, entry]) =>
      replaceSessionEntry(
        {
          storePath,
          sessionKey,
        },
        {
          sessionId: entry.sessionId,
          updatedAt: Date.now(),
        },
      ),
    ),
  );
  return storePath;
}

afterEach(() => {
  vi.resetAllMocks();
  resetDiagnosticEventsForTest();
  while (tempStoreDirs.length > 0) {
    const dir = tempStoreDirs.pop();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireFirstMockCall(mock: unknown, label: string): unknown[] {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.[0];
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call;
}

function expectGatewayAgentFollowup(expected: Record<string, unknown>) {
  const call = requireFirstMockCall(callGatewayTool, "callGatewayTool call");
  expect(call[0]).toBe("agent");
  requireRecord(call[1], "gateway tool context");
  const params = requireRecord(call[2], "gateway tool params");
  for (const [key, value] of Object.entries(expected)) {
    expect(params[key]).toBe(value);
  }
  expect(call[3]).toBeUndefined();
  return params;
}

function expectGatewayAgentWait(expected: Record<string, unknown>, callIndex = 1) {
  const call = (callGatewayTool as { mock?: { calls?: unknown[][] } }).mock?.calls?.[callIndex];
  if (!call) {
    throw new Error("expected agent.wait call");
  }
  expect(call[0]).toBe("agent.wait");
  requireRecord(call[1], "gateway wait context");
  const params = requireRecord(call[2], "gateway wait params");
  for (const [key, value] of Object.entries(expected)) {
    expect(params[key]).toBe(value);
  }
  expect(call[3]).toBeUndefined();
  return params;
}

function expectDirectSend(expected: Record<string, unknown>) {
  const call = requireFirstMockCall(sendMessage, "sendMessage call");
  const params = requireRecord(call[0], "sendMessage params");
  for (const [key, value] of Object.entries(expected)) {
    expect(params[key]).toBe(value);
  }
  return params;
}

function expectAuthenticatedHandoff(
  params: Record<string, unknown>,
  expected: { approvalId: string; sessionKey: string },
) {
  expect(params.message).toEqual(expect.stringContaining("<<<BEGIN_UNTRUSTED_EXEC_OUTPUT>>>"));
  expect(params.inputProvenance).toEqual({
    kind: "inter_session",
    sourceSessionKey: expected.sessionKey,
    sourceTool: "exec_approval_followup",
  });
  expect(params.internalRuntimeHandoffId).toEqual(expect.any(String));
  expect(params.idempotencyKey).toEqual(expect.any(String));
  expect(params.idempotencyKey).toMatch(
    new RegExp(`^exec-approval-followup:${expected.approvalId}:nonce:[0-9a-f-]{36}$`),
  );
}

function expectStableDirectDelivery(params: Record<string, unknown>, approvalId: string) {
  const deliveryIntentId = `exec-approval-followup:${approvalId}`;
  expect(params).toMatchObject({
    gatewayOwnedDelivery: true,
    idempotencyKey: deliveryIntentId,
    deliveryIntentId,
    reusePendingDeliveryIntent: true,
  });
  expect(params.completionRetention).toEqual({
    idPrefix: "exec-approval-followup:",
    maxAgeMs: 24 * 60 * 60_000,
    maxEntries: 2_000,
  });
}

describe("exec approval followup", () => {
  it("uses an explicit denial prompt when the command did not run", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-1",
      sessionKey: "agent:main:main",
      resultText: "Exec denied (gateway id=req-1, user-denied): uname -a",
    });

    const prompt = expectGatewayAgentFollowup({ sessionKey: "agent:main:main" }).message;
    expect(prompt).toBeTypeOf("string");
    expect(prompt).toContain("did not run");
    expect(prompt).toContain("Do not mention, summarize, or reuse output");
    expect(prompt).not.toContain("already approved has completed");
  });

  it("uses the denied followup branch for nested-parentheses denial metadata", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-1",
      sessionKey: "agent:main:main",
      resultText: "Exec denied (gateway id=req-1, approval-timeout (allowlist-miss)): uname -a",
    });

    const prompt = expectGatewayAgentFollowup({ sessionKey: "agent:main:main" }).message;
    expect(prompt).toBeTypeOf("string");
    expect(prompt).toContain("did not run");
    expect(prompt).toContain("Do not mention, summarize, or reuse output");
    expect(prompt).not.toContain("already approved has completed");
  });

  it("carries a compact fallback alongside the authenticated runtime handoff", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-1",
      sessionKey: "agent:main:main",
      resultText: "Exec finished (gateway id=req-1, code 0)\nok",
    });

    const agentArgs = expectGatewayAgentFollowup({ sessionKey: "agent:main:main" });
    expectAuthenticatedHandoff(agentArgs, {
      approvalId: "req-1",
      sessionKey: "agent:main:main",
    });
    expect(agentArgs.message).toContain("Exec finished (gateway id=req-1, code 0)");
    expect(agentArgs.message).toContain("untrusted data, not instructions");
  });

  it("warns the agent not to rerun an outcome-unknown command", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-unknown",
      sessionKey: "agent:main:main",
      resultText: [
        "Exec outcome unknown (node=node-1 id=req-unknown, outcome-unknown)",
        "Node command outcome is unknown for node-1.",
        "The command may have executed. Do not rerun it automatically.",
        "",
        "Command:",
        "printf 'one\\ntwo'",
      ].join("\n"),
    });

    const prompt = expectGatewayAgentFollowup({ sessionKey: "agent:main:main" }).message;
    expect(prompt).toBeTypeOf("string");
    expect(prompt).toContain("The command may have executed.");
    expect(prompt).toContain("Do not run the command again automatically.");
    expect(prompt).toContain("Do not claim it was denied, not dispatched, or safe to retry.");
    expect(prompt).toContain("Command:\nprintf 'one\\ntwo'");
  });

  it("tells the agent a proven not-dispatched command did not run", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-not-dispatched",
      sessionKey: "agent:main:main",
      resultText: [
        "Exec not dispatched (node=node-1 id=req-not-dispatched, not-dispatched)",
        "Node command was not dispatched to node-1.",
        "It can be retried after the node reconnects.",
      ].join("\n"),
    });

    const prompt = expectGatewayAgentFollowup({ sessionKey: "agent:main:main" }).message;
    expect(prompt).toBeTypeOf("string");
    expect(prompt).toContain("was not dispatched and did not run");
    expect(prompt).toContain("Retry only after resolving the connection failure");
    expect(prompt).not.toContain("already approved has completed");
    expect(prompt).not.toContain("Do not run the command again.");
  });

  it("preserves outcome-unknown details in direct delivery", async () => {
    const resultText = [
      "Exec outcome unknown (node=node-1 id=req-direct-unknown, outcome-unknown)",
      "The command may have executed. Do not rerun it automatically.",
      "",
      "Command:",
      "echo first",
      "echo second",
    ].join("\n");

    await sendExecApprovalFollowup({
      approvalId: "req-direct-unknown",
      direct: true,
      turnSourceChannel: "telegram",
      turnSourceTo: "-100123",
      resultText,
    });

    expectDirectSend({ content: resultText });
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("keeps followups internal when no external route is available", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-1",
      sessionKey: "agent:main:main",
      resultText: "Exec completed: echo ok",
    });

    expectGatewayAgentFollowup({
      sessionKey: "agent:main:main",
      deliver: false,
      channel: undefined,
      to: undefined,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("forwards the approval-time session id so the gateway can drop stale followups", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-pin-59349",
      sessionKey: "agent:main:main",
      expectedSessionId: "session-original",
      resultText: "Exec completed: echo ok",
    });

    expectGatewayAgentFollowup({
      sessionKey: "agent:main:main",
      execApprovalFollowupExpectedSessionId: "session-original",
    });
  });

  it("omits the expected session id when none was captured", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-no-pin",
      sessionKey: "agent:main:main",
      resultText: "Exec completed: echo ok",
    });

    const params = expectGatewayAgentFollowup({ sessionKey: "agent:main:main" });
    expect(params).not.toHaveProperty("execApprovalFollowupExpectedSessionId");
  });

  it("drops a denied direct followup when the session key was rebound by /new or /reset", async () => {
    const sessionStore = await writeTempSessionStore({
      "agent:main:main": { sessionId: "session-after-reset" },
    });
    const diagnostics: DiagnosticEventPayload[] = [];
    onDiagnosticEvent((event) => {
      diagnostics.push(event);
    });

    const result = await sendExecApprovalFollowup({
      approvalId: "req-denied-rebound",
      sessionKey: "agent:main:main",
      expectedSessionId: "session-original",
      sessionStore,
      direct: true,
      turnSourceChannel: "telegram",
      turnSourceTo: "-100123",
      resultText: "Exec denied (gateway id=req-denied-rebound, user-denied): uname -a",
    });

    expect(result).toBe(false);
    await waitForDiagnosticEventsDrained();
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        type: "exec.approval.followup_suppressed",
        approvalId: "req-denied-rebound",
        reason: "session_rebound",
        phase: "direct_delivery",
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("delivers a denied direct followup when the key still resolves to the approval-time session", async () => {
    const sessionStore = await writeTempSessionStore({
      "agent:main:main": { sessionId: "session-original" },
    });

    await sendExecApprovalFollowup({
      approvalId: "req-denied-same",
      sessionKey: "agent:main:main",
      expectedSessionId: "session-original",
      sessionStore,
      direct: true,
      turnSourceChannel: "telegram",
      turnSourceTo: "-100123",
      resultText: "Exec denied (gateway id=req-denied-same, user-denied): uname -a",
    });

    expect(sendMessage).toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("drops a non-denied direct fallback when the session key was rebound", async () => {
    const sessionStore = await writeTempSessionStore({
      "agent:main:main": { sessionId: "session-after-reset" },
    });
    const diagnostics: DiagnosticEventPayload[] = [];
    onDiagnosticEvent((event) => {
      diagnostics.push(event);
    });

    const result = await sendExecApprovalFollowup({
      approvalId: "req-finished-rebound",
      sessionKey: "agent:main:main",
      expectedSessionId: "session-original",
      sessionStore,
      direct: true,
      turnSourceChannel: "telegram",
      turnSourceTo: "-100123",
      resultText: "Exec finished (gateway id=req-finished-rebound, code 0)\nok",
    });

    expect(result).toBe(false);
    await waitForDiagnosticEventsDrained();
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        type: "exec.approval.followup_suppressed",
        approvalId: "req-finished-rebound",
        reason: "session_rebound",
        phase: "direct_delivery",
      }),
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("routes denied followups through the originating main session", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-denied-main",
      sessionKey: "agent:main:main",
      turnSourceChannel: "webchat",
      resultText: "Exec denied (gateway id=req-denied-main, user-denied): uname -a",
    });

    const agentArgs = expectGatewayAgentFollowup({
      sessionKey: "agent:main:main",
      deliver: false,
      channel: "webchat",
      idempotencyKey: "exec-approval-followup:req-denied-main",
    });
    expect(agentArgs.message).toContain("An async command did not run.");
    expect(agentArgs.message).toContain(
      "Exec denied (gateway id=req-denied-main, user-denied): uname -a",
    );
    expect(agentArgs.message).not.toContain("missing tool result");
    expect(agentArgs.message).not.toContain("transcript repair");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      channel: "slack",
      sessionKey: "agent:main:slack:channel:C123",
      to: "channel:C123",
      accountId: "default",
      threadId: "1712419200.1234",
    },
    {
      channel: "discord",
      sessionKey: "agent:main:discord:channel:123",
      to: "123",
      accountId: "default",
      threadId: "456",
    },
    {
      channel: "telegram",
      sessionKey: "agent:main:telegram:-100123",
      to: "-100123",
      accountId: "default",
      threadId: "789",
    },
  ])("uses agent continuation for $channel followups when a session exists", async (target) => {
    await sendExecApprovalFollowup({
      approvalId: `req-${target.channel}`,
      sessionKey: target.sessionKey,
      turnSourceChannel: target.channel,
      turnSourceTo: target.to,
      turnSourceAccountId: target.accountId,
      turnSourceThreadId: target.threadId,
      resultText: "slack exec approval smoke",
    });

    const agentArgs = expectGatewayAgentFollowup({
      sessionKey: target.sessionKey,
      deliver: true,
      bestEffortDeliver: true,
      channel: target.channel,
      to: target.to,
      accountId: target.accountId,
      threadId: target.threadId,
    });
    expectAuthenticatedHandoff(agentArgs, {
      approvalId: `req-${target.channel}`,
      sessionKey: target.sessionKey,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("preserves the originating routing target for non-built-in plugin channels", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-plugin",
      sessionKey: "agent:main:lansenger:dm:U1",
      turnSourceChannel: "lansenger",
      turnSourceTo: "dm:U1",
      turnSourceAccountId: "acct-1",
      turnSourceThreadId: 42,
      resultText: "Exec finished (gateway id=req-plugin, code 0)\nhello",
    });

    const agentArgs = expectGatewayAgentFollowup({
      sessionKey: "agent:main:lansenger:dm:U1",
      deliver: false,
      channel: "lansenger",
      to: "dm:U1",
      accountId: "acct-1",
      threadId: "42",
    });
    expectAuthenticatedHandoff(agentArgs, {
      approvalId: "req-plugin",
      sessionKey: "agent:main:lansenger:dm:U1",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("waits for accepted agent followups without direct fallback", async () => {
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({
        runId: "exec-approval-followup:req-wait:nonce:nonce-wait",
        status: "accepted",
      })
      .mockResolvedValueOnce({
        runId: "exec-approval-followup:req-wait:nonce:nonce-wait",
        status: "ok",
      });

    await sendExecApprovalFollowup({
      approvalId: "req-wait",
      sessionKey: "agent:main:telegram:direct:123",
      turnSourceChannel: "telegram",
      turnSourceTo: "123",
      turnSourceAccountId: "default",
      resultText: "Exec finished (gateway id=req-wait, session=sess_1, code 0)\nall good",
      internalRuntimeHandoffId: "handoff-wait",
      idempotencyKey: "exec-approval-followup:req-wait:nonce:nonce-wait",
    });

    const agentArgs = expectGatewayAgentFollowup({
      sessionKey: "agent:main:telegram:direct:123",
      deliver: true,
      channel: "telegram",
      to: "123",
      idempotencyKey: "exec-approval-followup:req-wait:nonce:nonce-wait",
      internalRuntimeHandoffId: "handoff-wait",
    });
    expect(agentArgs.message).toContain("all good");
    expect(agentArgs.inputProvenance).toEqual({
      kind: "inter_session",
      sourceSessionKey: "agent:main:telegram:direct:123",
      sourceTool: "exec_approval_followup",
    });
    expect(agentArgs.timeout).toBe(300);
    expectGatewayAgentWait({
      runId: "exec-approval-followup:req-wait:nonce:nonce-wait",
      timeoutMs: 60_000,
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not direct-send when agent.wait times out without terminal evidence", async () => {
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({
        runId: "exec-approval-followup:req-ambiguous:nonce:nonce-ambiguous",
        status: "accepted",
      })
      .mockResolvedValueOnce({
        runId: "exec-approval-followup:req-ambiguous:nonce:nonce-ambiguous",
        status: "timeout",
        timeoutPhase: "queue",
        providerStarted: false,
      })
      .mockResolvedValueOnce({
        runId: "exec-approval-followup:req-ambiguous:nonce:nonce-ambiguous",
        status: "ok",
      });

    await sendExecApprovalFollowup({
      approvalId: "req-ambiguous",
      sessionKey: "agent:main:telegram:direct:123",
      turnSourceChannel: "telegram",
      turnSourceTo: "123",
      resultText: "Exec finished (gateway id=req-ambiguous, code 0)\nall good",
      internalRuntimeHandoffId: "handoff-ambiguous",
      idempotencyKey: "exec-approval-followup:req-ambiguous:nonce:nonce-ambiguous",
    });

    expectGatewayAgentWait(
      {
        runId: "exec-approval-followup:req-ambiguous:nonce:nonce-ambiguous",
        timeoutMs: 60_000,
      },
      2,
    );
    expect(callGatewayTool).toHaveBeenCalledTimes(3);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps observing past the old ambiguity cap until terminal fallback", async () => {
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({
        runId: "exec-approval-followup:req-ambiguous-release:nonce:nonce-release",
        status: "accepted",
      })
      .mockResolvedValueOnce({
        runId: "exec-approval-followup:req-ambiguous-release:nonce:nonce-release",
        status: "timeout",
        timeoutPhase: "queue",
        providerStarted: false,
      })
      .mockResolvedValueOnce({
        runId: "exec-approval-followup:req-ambiguous-release:nonce:nonce-release",
        status: "timeout",
        timeoutPhase: "queue",
        providerStarted: false,
      })
      .mockResolvedValueOnce({
        runId: "exec-approval-followup:req-ambiguous-release:nonce:nonce-release",
        status: "timeout",
        timeoutPhase: "queue",
        providerStarted: false,
      })
      .mockResolvedValueOnce({
        runId: "exec-approval-followup:req-ambiguous-release:nonce:nonce-release",
        status: "timeout",
        timeoutPhase: "queue",
        providerStarted: false,
      })
      .mockResolvedValueOnce({
        runId: "exec-approval-followup:req-ambiguous-release:nonce:nonce-release",
        status: "error",
        endedAt: Date.now(),
        error: "provider failed after prolonged execution",
      });

    await expect(
      sendExecApprovalFollowup({
        approvalId: "req-ambiguous-release",
        sessionKey: "agent:main:telegram:direct:123",
        turnSourceChannel: "telegram",
        turnSourceTo: "123",
        resultText: "Exec finished (gateway id=req-ambiguous-release, code 0)\nall good",
        internalRuntimeHandoffId: "handoff-ambiguous-release",
        idempotencyKey: "exec-approval-followup:req-ambiguous-release:nonce:nonce-release",
      }),
    ).resolves.toBe(true);

    expect(callGatewayTool).toHaveBeenCalledTimes(6);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("retries an accepted run after a wait transport error without direct fallback", async () => {
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({
        runId: "exec-approval-followup:req-wait-retry:nonce:nonce-retry",
        status: "accepted",
      })
      .mockRejectedValueOnce(new Error("gateway reconnecting"))
      .mockResolvedValueOnce({
        runId: "exec-approval-followup:req-wait-retry:nonce:nonce-retry",
        status: "ok",
      });

    await sendExecApprovalFollowup({
      approvalId: "req-wait-retry",
      sessionKey: "agent:main:telegram:direct:123",
      turnSourceChannel: "telegram",
      turnSourceTo: "123",
      resultText: "Exec finished (gateway id=req-wait-retry, code 0)\nall good",
      internalRuntimeHandoffId: "handoff-wait-retry",
      idempotencyKey: "exec-approval-followup:req-wait-retry:nonce:nonce-retry",
    });

    expect(callGatewayTool).toHaveBeenCalledTimes(3);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("ends observation after its deadline without competing direct delivery", async () => {
    const diagnostics: DiagnosticEventPayload[] = [];
    onInternalDiagnosticEvent((event) => {
      diagnostics.push(event);
    });
    const startedAt = new Date("2026-08-01T00:00:00Z").getTime();
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(startedAt);
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({
        runId: "exec-approval-followup:req-observer-deadline:nonce:nonce-deadline",
        status: "accepted",
      })
      .mockImplementationOnce(async () => {
        dateNow.mockReturnValue(startedAt + 10 * 60_000);
        throw new Error("gateway permanently unreachable");
      });

    try {
      await expect(
        sendExecApprovalFollowup({
          approvalId: "req-observer-deadline",
          sessionKey: "agent:main:telegram:direct:123",
          turnSourceChannel: "telegram",
          turnSourceTo: "123",
          resultText: "Exec finished (gateway id=req-observer-deadline, code 0)\nall good",
          internalRuntimeHandoffId: "handoff-observer-deadline",
          idempotencyKey: "exec-approval-followup:req-observer-deadline:nonce:nonce-deadline",
        }),
      ).resolves.toBe(true);
    } finally {
      dateNow.mockRestore();
    }

    await waitForDiagnosticEventsDrained();
    expect(callGatewayTool).toHaveBeenCalledTimes(2);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(diagnostics).toContainEqual(
      expect.objectContaining({
        type: "log.record",
        level: "WARN",
        message: "Exec approval followup observation ended",
        loggerName: "agents/exec-approval-followup",
        attributes: {
          approvalId: "req-observer-deadline",
          runId: "exec-approval-followup:req-observer-deadline:nonce:nonce-deadline",
          reason: "deadline",
          transportErrors: 1,
          deliveryOwner: "accepted_agent_run",
        },
      }),
    );
  });

  it("direct-falls back after terminal resume failure with a capped UTF-16-safe tail", async () => {
    const tailSentinel = "TAIL_SENTINEL_\u{1F680}";
    vi.mocked(callGatewayTool)
      .mockResolvedValueOnce({
        runId: "exec-approval-followup:req-terminal:nonce:nonce-terminal",
        status: "accepted",
      })
      .mockResolvedValueOnce({
        runId: "exec-approval-followup:req-terminal:nonce:nonce-terminal",
        status: "error",
        endedAt: Date.now(),
        error: "provider failed",
      });

    await sendExecApprovalFollowup({
      approvalId: "req-terminal",
      sessionKey: "agent:main:telegram:direct:123",
      turnSourceChannel: "telegram",
      turnSourceTo: "123",
      resultText: `Exec finished (gateway id=req-terminal, code 1)\nHEAD_SENTINEL_${"x".repeat(5_000)}${tailSentinel}`,
      internalRuntimeHandoffId: "handoff-terminal",
      idempotencyKey: "exec-approval-followup:req-terminal:nonce:nonce-terminal",
    });

    const directParams = expectDirectSend({
      channel: "telegram",
      to: "123",
    });
    expectStableDirectDelivery(directParams, "req-terminal");
    const content = directParams.content;
    if (typeof content !== "string") {
      throw new Error("expected direct fallback content");
    }
    expect(content).toHaveLength(4_000);
    expect(content).toMatch(
      /^Automatic session resume failed, so sending the status directly\.\n\n\[\.\.\. earlier command output omitted \.\.\.\]\n/,
    );
    expect(content).not.toContain("HEAD_SENTINEL");
    expect(content).toContain(tailSentinel);
    expect(Buffer.from(content, "utf8").toString("utf8")).toBe(content);
  });

  it("falls back to sanitized direct external delivery only when no session exists", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-no-session",
      turnSourceChannel: "discord",
      turnSourceTo: "123",
      turnSourceAccountId: "default",
      turnSourceThreadId: "456",
      resultText: "Exec finished (gateway id=req-no-session, session=sess_1, code 0)\nall good",
    });

    const directParams = expectDirectSend({
      channel: "discord",
      to: "123",
      accountId: "default",
      threadId: "456",
      content: "all good",
      idempotencyKey: "exec-approval-followup:req-no-session",
    });
    expectStableDirectDelivery(directParams, "req-no-session");
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("redacts credentials before direct delivery", async () => {
    const secret = "sk-abcdefghijklmnopqrstuvwxyz123456";

    await sendExecApprovalFollowup({
      approvalId: "req-redacted",
      turnSourceChannel: "discord",
      turnSourceTo: "123",
      resultText: `Exec finished (gateway id=req-redacted, code 0)\nAuthorization: Bearer ${secret}\nAPI_KEY=${secret}`,
    });

    const directParams = expectDirectSend({
      channel: "discord",
      to: "123",
    });
    expectStableDirectDelivery(directParams, "req-redacted");
    expect(directParams.content).toContain("Authorization: Bearer ");
    expect(directParams.content).toContain("API_KEY=***");
    expect(directParams.content).not.toContain(secret);
  });

  it("can force direct delivery even when a session key exists", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-direct",
      sessionKey: "agent:main:telegram:direct:123",
      turnSourceChannel: "telegram",
      turnSourceTo: "123",
      turnSourceAccountId: "default",
      resultText:
        "Exec finished (gateway id=req-direct, session=sess_1, code 0)\npasteable diagnostics report",
      direct: true,
    });

    expectDirectSend({
      channel: "telegram",
      to: "123",
      accountId: "default",
      content: "pasteable diagnostics report",
      idempotencyKey: "exec-approval-followup:req-direct",
    });
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("falls back to sanitized direct delivery without alarming prefix for successful completions", async () => {
    vi.mocked(callGatewayTool).mockRejectedValueOnce(new Error("session missing"));

    await sendExecApprovalFollowup({
      approvalId: "req-session-resume-failed",
      sessionKey: "agent:main:discord:channel:123",
      turnSourceChannel: "discord",
      turnSourceTo: "123",
      turnSourceAccountId: "default",
      turnSourceThreadId: "456",
      resultText:
        "Exec finished (gateway id=req-session-resume-failed, session=sess_1, code 0)\nall good",
    });

    expectDirectSend({
      content: "all good",
      idempotencyKey: "exec-approval-followup:req-session-resume-failed",
    });
  });

  it("uses a generic summary when a no-session completion has no user-visible output", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-no-session-empty",
      turnSourceChannel: "discord",
      turnSourceTo: "123",
      turnSourceAccountId: "default",
      turnSourceThreadId: "456",
      resultText: "Exec finished (gateway id=req-no-session-empty, session=sess_2, code 0)",
    });

    expectDirectSend({
      content: "Background command finished.",
      idempotencyKey: "exec-approval-followup:req-no-session-empty",
    });
  });

  it("falls back to safe direct denied copy when session resume fails", async () => {
    vi.mocked(callGatewayTool).mockRejectedValueOnce(new Error("session missing"));

    await sendExecApprovalFollowup({
      approvalId: "req-denied-resume-failed",
      sessionKey: "agent:main:telegram:-100123",
      turnSourceChannel: "telegram",
      turnSourceTo: "-100123",
      turnSourceAccountId: "default",
      turnSourceThreadId: "789",
      resultText: "Exec denied (gateway id=req-denied-resume-failed, approval-timeout): uname -a",
    });

    expectDirectSend({
      content: "Command did not run: approval timed out.",
      idempotencyKey: "exec-approval-followup:req-denied-resume-failed",
    });
    expect(callGatewayTool).toHaveBeenCalledTimes(1);
  });

  it("falls back to safe direct denied copy for nested-parentheses denial metadata", async () => {
    vi.mocked(callGatewayTool).mockRejectedValueOnce(new Error("session missing"));

    await sendExecApprovalFollowup({
      approvalId: "req-denied-resume-failed-nested",
      sessionKey: "agent:main:telegram:-100123",
      turnSourceChannel: "telegram",
      turnSourceTo: "-100123",
      turnSourceAccountId: "default",
      turnSourceThreadId: "789",
      resultText:
        "Exec denied (gateway id=req-denied-resume-failed-nested, approval-timeout (allowlist-miss)): uname -a",
    });

    expectDirectSend({
      content: "Command did not run: approval timed out.",
      idempotencyKey: "exec-approval-followup:req-denied-resume-failed-nested",
    });
    expect(callGatewayTool).toHaveBeenCalledTimes(1);
  });

  it("suppresses denied followups for subagent sessions", async () => {
    await expect(
      sendExecApprovalFollowup({
        approvalId: "req-denied-subagent",
        sessionKey: "agent:main:subagent:test",
        turnSourceChannel: "telegram",
        turnSourceTo: "123",
        turnSourceAccountId: "default",
        resultText: "Exec denied (gateway id=req-denied-subagent, approval-timeout): uname -a",
      }),
    ).resolves.toBe(false);

    expect(callGatewayTool).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each([
    "Exec denied (gateway id=req-denied-nosession, approval-timeout): uname -a",
    "exec denied (gateway id=req-denied-nosession, approval-timeout): uname -a",
  ])("does not mirror raw denied followups without a session: %s", async (resultText) => {
    await expect(
      sendExecApprovalFollowup({
        approvalId: "req-denied-nosession",
        turnSourceChannel: "telegram",
        turnSourceTo: "123",
        turnSourceAccountId: "default",
        resultText,
      }),
    ).resolves.toBe(false);

    expect(callGatewayTool).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("preserves turnSourceChannel as messageProvider on the followup run when no deliverable route exists", async () => {
    // Regression: #74646 — tools.elevated.allowFrom.<provider> fails in approval followup
    await sendExecApprovalFollowup({
      approvalId: "req-elevated-74646",
      sessionKey: "agent:main:telegram:-100123",
      turnSourceChannel: "telegram",
      resultText: "Exec completed: systemctl status gateway",
    });

    expectGatewayAgentFollowup({
      sessionKey: "agent:main:telegram:-100123",
      deliver: false,
      channel: "telegram",
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("carries the runtime handoff separately from idempotency without exposing elevated defaults", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-elevated-75832",
      sessionKey: "agent:main:telegram:direct:123",
      turnSourceChannel: "telegram",
      resultText: "Exec finished (gateway id=req-elevated-75832, code 0)\nok",
      internalRuntimeHandoffId: "handoff-75832",
      idempotencyKey: "exec-approval-followup:req-elevated-75832:nonce:nonce-75832",
    });

    const agentArgs = expectGatewayAgentFollowup({
      sessionKey: "agent:main:telegram:direct:123",
      channel: "telegram",
      idempotencyKey: "exec-approval-followup:req-elevated-75832:nonce:nonce-75832",
      internalRuntimeHandoffId: "handoff-75832",
    });
    expect(agentArgs.message).toContain("ok");
    expect(agentArgs.inputProvenance).toEqual({
      kind: "inter_session",
      sourceSessionKey: "agent:main:telegram:direct:123",
      sourceTool: "exec_approval_followup",
    });
    expect(agentArgs).not.toHaveProperty("bashElevated");
    expect(agentArgs).not.toHaveProperty("execApprovalFollowupToken");
  });

  it("throws when neither a session nor a deliverable route is available", async () => {
    await expect(
      sendExecApprovalFollowup({
        approvalId: "req-missing",
        turnSourceChannel: "slack",
        resultText: "Exec completed: echo ok",
      }),
    ).rejects.toThrow("Session key or deliverable origin route is required");
  });
});
