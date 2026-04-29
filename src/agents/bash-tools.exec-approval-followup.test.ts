import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../infra/outbound/message.js", () => ({
  sendMessage: vi.fn(async () => ({ ok: true })),
}));

import { sendMessage } from "../infra/outbound/message.js";
import {
  buildExecApprovalFollowupPrompt,
  sendExecApprovalFollowup,
} from "./bash-tools.exec-approval-followup.js";
import { callGatewayTool } from "./tools/gateway.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("exec approval followup", () => {
  it("uses an explicit denial prompt when the command did not run", () => {
    const prompt = buildExecApprovalFollowupPrompt(
      "Exec denied (gateway id=req-1, user-denied): uname -a",
    );

    expect(prompt).toContain("did not run");
    expect(prompt).toContain("Do not mention, summarize, or reuse output");
    expect(prompt).not.toContain("already approved has completed");
  });

  it("tells the agent to continue the task before replying when the command succeeds", () => {
    const prompt = buildExecApprovalFollowupPrompt("Exec finished (gateway id=req-1, code 0)\nok");

    expect(prompt).toContain("continue from this result before replying to the user");
    expect(prompt).toContain("Continue the task if needed, then reply to the user");
  });

  it("keeps followups internal when no external route is available", async () => {
    await sendExecApprovalFollowup({
      approvalId: "req-1",
      sessionKey: "agent:main:main",
      resultText: "Exec completed: echo ok",
    });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "agent",
      expect.any(Object),
      expect.objectContaining({
        sessionKey: "agent:main:main",
        deliver: false,
        channel: undefined,
        to: undefined,
      }),
      { expectFinal: true },
    );
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

    expect(callGatewayTool).toHaveBeenCalledWith(
      "agent",
      expect.any(Object),
      expect.objectContaining({
        sessionKey: target.sessionKey,
        deliver: true,
        bestEffortDeliver: true,
        channel: target.channel,
        to: target.to,
        accountId: target.accountId,
        threadId: target.threadId,
        idempotencyKey: `exec-approval-followup:req-${target.channel}`,
      }),
      { expectFinal: true },
    );
    expect(sendMessage).not.toHaveBeenCalled();
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

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "discord",
        to: "123",
        accountId: "default",
        threadId: "456",
        content: "all good",
        idempotencyKey: "exec-approval-followup:req-no-session",
      }),
    );
    expect(callGatewayTool).not.toHaveBeenCalled();
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

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "telegram",
        to: "123",
        accountId: "default",
        content: "pasteable diagnostics report",
        idempotencyKey: "exec-approval-followup:req-direct",
      }),
    );
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

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "all good",
        idempotencyKey: "exec-approval-followup:req-session-resume-failed",
      }),
    );
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

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Background command finished.",
        idempotencyKey: "exec-approval-followup:req-no-session-empty",
      }),
    );
  });

  it("uses safe denied copy when session resume fails", async () => {
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

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content:
          "Automatic session resume failed, so sending the status directly.\n\nCommand did not run: approval timed out.",
        idempotencyKey: "exec-approval-followup:req-denied-resume-failed",
      }),
    );
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
