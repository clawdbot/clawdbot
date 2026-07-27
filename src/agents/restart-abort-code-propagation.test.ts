import { failTransportStream, finalizeTransportStream } from "@openclaw/ai/transports";
import { describe, expect, it, vi } from "vitest";
import { resolveMainSessionResumePolicy } from "./main-session-restart-recovery-resume-policy.js";
import {
  createAssistantOutput,
  makeCompletionsModel,
} from "./openai-transport-stream.test-harness.js";
import { createAgentRunRestartAbortError } from "./run-termination.js";

/**
 * End-to-end proof of the restart-abort code path, with no hand-written
 * transcript fixture in the middle: the abort error, the transport's terminal
 * message assembly, and the recovery classifier are all production code.
 *
 * Fixture-based tests can only show that recovery reacts to a message shape.
 * This shows the shape a real abort actually produces.
 */
function runTerminalTransportTurn(signal: AbortSignal): Record<string, unknown> {
  const model = makeCompletionsModel({
    id: "restart-abort-probe",
    name: "Restart Abort Probe",
    provider: "local",
    baseUrl: "http://127.0.0.1:18099/v1",
    reasoning: false,
    contextWindow: 128000,
    maxTokens: 4096,
  });
  const output = createAssistantOutput(model);
  // Mirrors the try/catch every transport wraps its stream in
  // (openai-completions-transport.ts): finalize throws for an aborted signal
  // and the catch turns that error into the persisted terminal message.
  try {
    finalizeTransportStream({
      stream: { push: vi.fn(), end: vi.fn() },
      output,
      signal,
    });
  } catch (error) {
    failTransportStream({ stream: { push: vi.fn(), end: vi.fn() }, output, signal, error });
  }
  return output as unknown as Record<string, unknown>;
}

describe("restart abort code propagation", () => {
  it("carries the gateway restart code from abort to a resumable recovery verdict", () => {
    const controller = new AbortController();
    controller.abort(createAgentRunRestartAbortError());

    const message = runTerminalTransportTurn(controller.signal);
    expect(message.errorCode).toBe("OPENCLAW_RESTART_ABORT");

    // The transcript tail is the transport's own output, not a fixture.
    const policy = resolveMainSessionResumePolicy([
      { role: "user", content: "do the thing" },
      message,
    ]);
    expect(policy).toMatchObject({ action: "resume" });
  });

  it("keeps a non-restart coded abort unresumable through the same path", () => {
    const controller = new AbortController();
    const timeout = Object.assign(new Error("First stream event timed out"), {
      name: "TimeoutError",
      code: "OPENCLAW_FIRST_EVENT_TIMEOUT",
    });
    controller.abort(timeout);

    const message = runTerminalTransportTurn(controller.signal);
    expect(message.errorCode).toBe("OPENCLAW_FIRST_EVENT_TIMEOUT");

    // stopReason is "aborted" here because the signal itself aborted, which
    // stays resumable by design: the run was still interrupted mid-flight.
    // The code only has to discriminate once a tail lands as "error".
    const erroredTail = { ...message, stopReason: "error" };
    expect(
      resolveMainSessionResumePolicy([{ role: "user", content: "do the thing" }, erroredTail]),
    ).toMatchObject({ action: "fail" });
  });
});
