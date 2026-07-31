import { describe, expect, it, vi } from "vitest";
import { resolveMainSessionResumePolicy } from "./main-session-restart-recovery-resume-policy.js";

vi.mock("./code-mode-control-tools.js", () => ({
  CODE_MODE_EXEC_TOOL_NAME: "exec",
  CODE_MODE_WAIT_TOOL_NAME: "wait",
}));

vi.mock("./tool-replay-safety.js", () => ({
  isAgentToolReplaySafe: ({ name }: { name?: string }) => name === "read",
}));

vi.mock("./run-termination.js", () => ({
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

describe("resolveMainSessionResumePolicy progress tails", () => {
  it("resumes when keyed progress messages arrive after the recovery mark", () => {
    expect(
      resolveMainSessionResumePolicy([
        { role: "user", content: "finish the interrupted work" },
        progressMessage("Checking the owner boundary.", "progress-1"),
        progressMessage("Still tracing the restart lifecycle.", "progress-2"),
      ]),
    ).toEqual({ action: "resume", forceRestartSafeTools: false });
  });

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
    ).toEqual({ action: "fail", reason: "transcript tail is not resumable" });
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
    ).toEqual({ action: "fail", reason: "transcript tail is not resumable" });
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
    ).toEqual({ action: "fail", reason: "transcript tail is not resumable" });
  });
});
