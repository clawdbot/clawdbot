import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpRuntimeError } from "../../acp/runtime/errors.js";
import {
  type AgentEventPayload,
  onAgentEvent,
  resetAgentEventsForTest,
} from "../../infra/agent-events.js";
import { emitAcpLifecycleError, formatAcpLifecycleError } from "./attempt-execution.js";

let captured: AgentEventPayload[] = [];
let unsubscribe: (() => void) | undefined;

beforeEach(() => {
  resetAgentEventsForTest();
  captured = [];
  unsubscribe = onAgentEvent((evt) => {
    captured.push(evt);
  });
});

afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  resetAgentEventsForTest();
});

describe("emitAcpLifecycleError preserves AcpRuntimeError detail (regression: openclaw-4a8)", () => {
  it("renders the AcpRuntimeError code into the error string so existing consumers surface it", () => {
    const acpError = new AcpRuntimeError("ACP_TURN_FAILED", "ACP turn failed before completion.");

    emitAcpLifecycleError({ runId: "run-1", error: acpError });

    expect(captured).toHaveLength(1);
    const data = captured[0]?.data as Record<string, unknown> | undefined;
    expect(data?.phase).toBe("error");
    const text = data?.error as string;
    expect(text).toMatch(/ACP_TURN_FAILED/);
    expect(text).toMatch(/ACP turn failed before completion\./);
  });

  it("flattens the cause chain into the error string so the underlying RequestError is not lost", () => {
    const rootCause = new Error('RequestError: "Method not found": nes/close (-32601)');
    const wrapped = new Error("Agent does not support session/close (oneshot:abc)", {
      cause: rootCause,
    });
    const acpError = new AcpRuntimeError("ACP_TURN_FAILED", "Internal error", {
      cause: wrapped,
    });

    emitAcpLifecycleError({ runId: "run-2", error: acpError });

    const data = captured[0]?.data as Record<string, unknown> | undefined;
    const text = data?.error as string;

    expect(text).toMatch(/ACP_TURN_FAILED/);
    expect(text).toMatch(/Internal error/);
    expect(text).toMatch(/Agent does not support session\/close/);
    expect(text).toMatch(/Method not found/);
    expect(text).toMatch(/nes\/close/);
    expect(text).toMatch(/-32601/);
  });

  it("falls back gracefully when given a plain Error without code or cause", () => {
    const plain = new Error("something went wrong");

    emitAcpLifecycleError({ runId: "run-3", error: plain });

    const data = captured[0]?.data as Record<string, unknown> | undefined;
    expect(data?.phase).toBe("error");
    expect(data?.error).toBe("Error: something went wrong");
  });

  it("formats non-Error values without crashing", () => {
    expect(formatAcpLifecycleError("just a string")).toBe("just a string");
    expect(formatAcpLifecycleError(42)).toBe("42");
    expect(formatAcpLifecycleError(undefined)).toBe("undefined");

    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const text = formatAcpLifecycleError(`upstream rejected token=${token}`);
    expect(text).toMatch(/upstream rejected/);
    expect(text).not.toContain(token);
  });

  it("caps cause-chain depth so a self-referential cause cannot loop", () => {
    const e: Error & { cause?: unknown } = new Error("loop");
    e.cause = e;

    const text = formatAcpLifecycleError(e);

    // Should produce a finite string with the message, not hang.
    expect(text).toMatch(/loop/);
    expect(text.length).toBeLessThan(2000);
  });
});
