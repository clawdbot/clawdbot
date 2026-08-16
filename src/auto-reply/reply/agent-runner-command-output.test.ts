import { describe, expect, it } from "vitest";
import { buildCommandOutputFromToolResultEvent } from "./agent-runner-command-output.js";

const BASH_ARGS = { command: "nope-not-a-command", description: "run missing binary" };

function buildFromCliResult(overrides: Record<string, unknown>) {
  return buildCommandOutputFromToolResultEvent({
    stream: "tool",
    data: { phase: "result", name: "Bash", toolCallId: "call-1", args: BASH_ARGS, ...overrides },
  });
}

describe("buildCommandOutputFromToolResultEvent", () => {
  it("reports a CLI command failure whose result is only text", () => {
    // CLI backends report the outcome plus raw content, never a structured
    // record, so requiring a structured field dropped the failure entirely.
    const built = buildFromCliResult({
      isError: true,
      result: "bash: nope-not-a-command: command not found",
    });

    expect(built?.status).toBe("failed");
    expect(built?.output).toBe("bash: nope-not-a-command: command not found");
  });

  it("reads the outcome from streamed text blocks", () => {
    const built = buildFromCliResult({
      isError: true,
      result: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
    });

    expect(built?.status).toBe("failed");
    expect(built?.output).toBe("line one\nline two");
  });

  it("describes the command that ran instead of what it printed", () => {
    const built = buildFromCliResult({ isError: true, result: "some noisy stderr" });

    // The title drives the visible progress line; without it the line would
    // replace the request with the tool's output.
    expect(built?.title).toContain("nope-not-a-command");
  });

  it("uses plain titles and propagates detailMode under plain verbose", () => {
    const built = buildCommandOutputFromToolResultEvent(
      {
        stream: "tool",
        data: {
          phase: "result",
          name: "Bash",
          toolCallId: "call-1",
          args: { command: "git status", workdir: "/workspace/project" },
          isError: false,
          result: "ok",
        },
      },
      { detailMode: "plain" },
    );

    expect(built?.detailMode).toBe("plain");
    expect(built?.title).toBe("I'm checking the current state of the project.");
    expect(built?.title).not.toContain("git");
    expect(built?.title).not.toContain("/workspace");
  });

  it("marks a successful CLI command completed", () => {
    expect(buildFromCliResult({ isError: false, result: "alpha" })?.status).toBe("completed");
  });

  it("projects a safe terminal state from a namespaced command-bearing result", () => {
    const built = buildCommandOutputFromToolResultEvent({
      stream: "tool",
      data: {
        phase: "result",
        name: "server.exec",
        toolCallId: "call-1",
        commandBearing: true,
        isError: false,
      },
    });

    expect(built).toMatchObject({
      name: "server.exec",
      status: "completed",
      toolCallId: "call-1",
    });
  });

  it("prefers an explicit status and structured fields when present", () => {
    const built = buildCommandOutputFromToolResultEvent({
      stream: "tool",
      data: {
        phase: "result",
        name: "exec",
        toolCallId: "call-1",
        title: "false",
        isError: true,
        result: { exitCode: 2, output: "structured output", status: "exit 2" },
      },
    });

    expect(built).toMatchObject({
      status: "exit 2",
      exitCode: 2,
      output: "structured output",
      title: "false",
    });
  });

  it("ignores events that carry no outcome and no content", () => {
    expect(
      buildCommandOutputFromToolResultEvent({
        stream: "tool",
        data: { phase: "result", name: "Bash", toolCallId: "call-1" },
      }),
    ).toBeUndefined();
  });

  it("ignores non-command tools and non-result phases", () => {
    expect(
      buildCommandOutputFromToolResultEvent({
        stream: "tool",
        data: { phase: "result", name: "Read", toolCallId: "call-1", isError: true },
      }),
    ).toBeUndefined();
    expect(buildFromCliResult({ phase: "start", isError: true })).toBeUndefined();
  });
});
