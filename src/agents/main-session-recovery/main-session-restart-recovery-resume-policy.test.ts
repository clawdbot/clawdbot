import { describe, expect, it, vi } from "vitest";
import { resolveMainSessionResumePolicy } from "./main-session-restart-recovery-resume-policy.js";

vi.mock("../code-mode-control-tools.js", () => ({
  CODE_MODE_EXEC_TOOL_NAME: "exec",
  CODE_MODE_WAIT_TOOL_NAME: "wait",
}));

vi.mock("../tool-replay-safety.js", () => ({
  isAgentToolReplaySafe: ({ name }: { name?: string }) => name === "read",
}));

vi.mock("../run-termination.js", () => ({
  AGENT_RUN_RESTART_ABORT_ERROR: "agent run aborted for restart",
  AGENT_RUN_RESTART_ABORT_ERROR_CODE: "OPENCLAW_RESTART_ABORT",
}));

function progressMessage(text: string, itemId: string): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    openclawStreamFallback: {
      replacementText: text,
      source: "segment",
      itemId,
    },
  };
}

function resolvePolicy(params: {
  messages?: unknown[];
  beforeAgentReplyState?:
    | "admitted"
    | "pending"
    | "continue"
    | "handled-silent"
    | "handled-reply"
    | "handled-unrecoverable";
  deliveryReceiptState?: "terminal-pending" | "delivered-terminal";
  deliveryToolCallId?: string;
}) {
  return resolveMainSessionResumePolicy(
    params.messages ?? [{ role: "user", content: "finish the interrupted work" }],
    false,
    "source-turn",
    params.beforeAgentReplyState,
    params.deliveryReceiptState,
    params.deliveryToolCallId,
  );
}

function codeModeCheckpoint(params: {
  replaySafe: boolean;
  runId?: string;
  status?: "completed" | "failed" | "waiting";
}) {
  return {
    role: "toolResult",
    toolName: "exec",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: params.status ?? "waiting",
          replaySafe: params.replaySafe,
          ...(params.runId ? { runId: params.runId } : {}),
        }),
      },
    ],
  };
}

function codeModeWait(runId = "code-run") {
  return {
    role: "assistant",
    stopReason: "toolUse",
    content: [{ type: "toolCall", id: "wait-call", name: "wait", arguments: { runId } }],
  };
}

describe("resolveMainSessionResumePolicy former terminal states", () => {
  it.each([
    {
      label: "terminal delivery whose outcome is unknown",
      params: { deliveryReceiptState: "terminal-pending" as const },
      expected: { action: "resume", forceRestartSafeTools: true },
    },
    {
      label: "delivered receipt without tool-call correlation",
      params: { deliveryReceiptState: "delivered-terminal" as const },
      expected: { action: "resume", forceRestartSafeTools: true },
    },
    ...(["pending", "handled-reply", "handled-unrecoverable"] as const).map((state) => ({
      label: `before_agent_reply ${state}`,
      params: { beforeAgentReplyState: state },
      expected: { action: "resume" as const, forceRestartSafeTools: true },
    })),
    {
      label: "empty transcript",
      params: { messages: [] },
      expected: { action: "resume", forceRestartSafeTools: false },
    },
    {
      label: "completed assistant tail",
      params: {
        messages: [
          { role: "user", content: "finish the interrupted work" },
          { role: "assistant", content: [{ type: "text", text: "Already finished." }] },
        ],
      },
      expected: { action: "resume", forceRestartSafeTools: false },
    },
    {
      label: "stale approval-pending result",
      params: {
        messages: [
          { role: "user", content: "run the command" },
          {
            role: "toolResult",
            toolName: "exec",
            details: { status: "approval-pending" },
            content: [{ type: "text", text: "Approval required." }],
          },
        ],
      },
      expected: { action: "resume", forceRestartSafeTools: true },
    },
    {
      label: "non-replay-safe Code Mode checkpoint",
      params: {
        messages: [
          { role: "user", content: "continue the code run" },
          codeModeCheckpoint({ replaySafe: false, runId: "code-run" }),
        ],
      },
      expected: { action: "resume", forceRestartSafeTools: true },
    },
    {
      label: "Code Mode wait with an unmatched checkpoint",
      params: {
        messages: [
          { role: "user", content: "continue the code run" },
          codeModeCheckpoint({ replaySafe: true, runId: "other-run" }),
          codeModeWait(),
        ],
      },
      expected: { action: "resume", forceRestartSafeTools: true },
    },
    {
      label: "mixed Code Mode wait and side-effecting call",
      params: {
        messages: [
          { role: "user", content: "continue the code run" },
          codeModeCheckpoint({ replaySafe: true, runId: "code-run" }),
          {
            role: "assistant",
            stopReason: "toolUse",
            content: [
              { type: "toolCall", id: "wait-call", name: "wait", arguments: { runId: "code-run" } },
              { type: "toolCall", id: "write-call", name: "write", arguments: {} },
            ],
          },
        ],
      },
      expected: { action: "resume", forceRestartSafeTools: true },
    },
  ])("maps $label to $expected", ({ params, expected }) => {
    expect(resolvePolicy(params)).toEqual(expected);
  });

  it("keeps replay-safe Code Mode reconstruction enabled only for a matching checkpoint", () => {
    expect(
      resolvePolicy({
        messages: [
          { role: "user", content: "continue the code run" },
          codeModeCheckpoint({ replaySafe: true, runId: "code-run" }),
          codeModeWait(),
        ],
      }),
    ).toEqual({
      action: "resume",
      forceRestartSafeTools: true,
      forceCodeModeTools: true,
    });
  });
});

describe("resolveMainSessionResumePolicy progress tails", () => {
  it("resumes explicit commentary without making completed answers resumable", () => {
    expect(
      resolveMainSessionResumePolicy([
        { role: "user", content: "finish the interrupted work" },
        {
          role: "assistant",
          phase: "commentary",
          content: [{ type: "text", text: "Checking the workspace." }],
          stopReason: "stop",
        },
      ]),
    ).toEqual({ action: "resume", forceRestartSafeTools: false });

    expect(
      resolveMainSessionResumePolicy([
        { role: "user", content: "finish the interrupted work" },
        { role: "assistant", content: [{ type: "text", text: "The work is complete." }] },
        progressMessage("A later progress item.", "progress-late"),
      ]),
    ).toEqual({ action: "resume", forceRestartSafeTools: false });
  });

  it("recognizes the existing provider text-signature commentary contract", () => {
    expect(
      resolveMainSessionResumePolicy([
        { role: "user", content: "finish the interrupted work" },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Checking the workspace.",
              textSignature: JSON.stringify({ v: 1, id: "progress-signed", phase: "commentary" }),
            },
          ],
          stopReason: "stop",
        },
      ]),
    ).toEqual({ action: "resume", forceRestartSafeTools: false });
  });

  it("keeps restart abort artifacts effective when progress arrives on either side", () => {
    expect(
      resolveMainSessionResumePolicy([
        { role: "user", content: "finish the interrupted work" },
        progressMessage("One last update before cancellation.", "progress-before-abort"),
        {
          role: "assistant",
          content: [],
          stopReason: "aborted",
          errorMessage: "agent run aborted for restart",
        },
        progressMessage("One delayed update after cancellation.", "progress-after-abort"),
      ]),
    ).toEqual({ action: "resume", forceRestartSafeTools: false });
  });

  it("retains replay restrictions when progress follows a side-effecting tool call", () => {
    expect(
      resolveMainSessionResumePolicy([
        { role: "user", content: "finish the interrupted work" },
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "true" } },
          ],
        },
        progressMessage("Waiting for the command.", "progress-exec"),
      ]),
    ).toEqual({ action: "resume", forceRestartSafeTools: true });
  });

  it("never treats unkeyed stream fallbacks as authoritative progress", () => {
    expect(
      resolveMainSessionResumePolicy([
        { role: "user", content: "finish the interrupted work" },
        {
          role: "assistant",
          content: [{ type: "text", text: "Possibly final output." }],
          stopReason: "stop",
          openclawStreamFallback: { replacementText: "Possibly final output.", source: "current" },
        },
      ]),
    ).toEqual({ action: "resume", forceRestartSafeTools: false });
  });

  it("keeps explicit final-answer phase authoritative over keyed fallback metadata", () => {
    expect(
      resolveMainSessionResumePolicy([
        { role: "user", content: "finish the interrupted work" },
        {
          ...progressMessage("The work is complete.", "final-item"),
          phase: "final_answer",
        },
      ]),
    ).toEqual({ action: "resume", forceRestartSafeTools: false });
  });
});
