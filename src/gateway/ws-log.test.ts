/**
 * Gateway WebSocket log formatting tests.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import { setVerbose } from "../global-state.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { formatForLog, logWs, summarizeAgentEventForWsLog } from "./ws-log.js";
import { setGatewayWsLogStyle } from "./ws-logging.js";

function shouldLogWs(direction: "in" | "out", kind: string): boolean {
  let admitted = false;
  logWs(direction, kind, () => {
    admitted = true;
    return { connId: "matrix", id: `matrix-${kind}`, ok: true };
  });
  return admitted;
}

afterEach(() => {
  setVerbose(false);
  setGatewayWsLogStyle("auto");
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
  vi.restoreAllMocks();
});

describe("gateway ws log helpers", () => {
  test.each(["optimized", "compact", "full"] as const)(
    "bounds unanswered timing and preserves request identity across %s log changes",
    (style) => {
      setVerbose(style !== "optimized");
      setGatewayWsLogStyle(style === "optimized" ? "auto" : style);
      setLoggerOverride({ level: "silent", consoleLevel: "info" });
      const output = vi.fn();
      loggingState.rawConsole = { log: output, info: output, warn: output, error: output };
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const first = { connId: `first-${style}`, id: "same", method: "health" };
      const second = { connId: `second-${style}`, id: "same", method: "health" };
      try {
        logWs("in", "req", first);
        clock.mockReturnValue(1_050);
        logWs("in", "req", second);
        clock.mockReturnValue(1_100);
        output.mockClear();
        logWs("out", "res", { ...first, ok: true });
        expect(output).toHaveBeenLastCalledWith(expect.stringContaining("100ms"));
        logWs("out", "res", { ...second, ok: true });
        expect(output).toHaveBeenLastCalledWith(expect.stringContaining("50ms"));
        logWs("out", "res", { ...first, ok: false });
        expect(output).toHaveBeenLastCalledWith(expect.not.stringMatching(/\d+ms/));

        clock.mockReturnValue(2_000);
        logWs("in", "req", first);
        for (let index = 0; index < 2_000; index += 1) {
          logWs("in", "req", { ...first, id: `unanswered-${index}` });
        }
        clock.mockReturnValue(2_100);
        output.mockClear();
        logWs("out", "res", { ...first, ok: false });
        expect(output).toHaveBeenLastCalledWith(expect.not.stringMatching(/\d+ms/));

        logWs("in", "req", second);
        setVerbose(true);
        setGatewayWsLogStyle(style === "full" ? "compact" : "full");
        clock.mockReturnValue(2_200);
        logWs("out", "res", { ...second, ok: true });
        expect(output).toHaveBeenLastCalledWith(expect.stringContaining("100ms"));
      } finally {
        setVerbose(style !== "optimized");
        setGatewayWsLogStyle(style === "optimized" ? "auto" : style);
        logWs("out", "res", { ...first, ok: true });
        logWs("out", "res", { ...second, ok: true });
        for (let index = 0; index < 2_000; index += 1) {
          logWs("out", "res", { ...first, id: `unanswered-${index}`, ok: true });
        }
      }
    },
  );

  test("admits only useful optimized-mode frames and honors console info enablement", () => {
    setVerbose(false);
    setLoggerOverride({ level: "silent", consoleLevel: "info" });

    expect(shouldLogWs("out", "event")).toBe(false);
    expect(shouldLogWs("in", "req")).toBe(true);
    expect(shouldLogWs("out", "res")).toBe(true);
    expect(shouldLogWs("out", "parse-error")).toBe(true);

    setVerbose(true);
    expect(shouldLogWs("out", "event")).toBe(true);

    setVerbose(false);
    setLoggerOverride({ level: "info", consoleLevel: "warn" });
    expect(shouldLogWs("in", "req")).toBe(true);
    expect(shouldLogWs("out", "res")).toBe(true);
    expect(shouldLogWs("out", "parse-error")).toBe(true);
    expect(shouldLogWs("out", "event")).toBe(false);

    setVerbose(true);
    expect(shouldLogWs("out", "event")).toBe(true);
  });

  test.each([
    {
      name: "run ID prefix boundary",
      payload: { runId: `${"a".repeat(11)}🚀${"b".repeat(20)}` },
      field: "run",
      expected: `${"a".repeat(11)}…bbbb`,
    },
    {
      name: "tool-call ID suffix boundary",
      payload: {
        stream: "tool",
        data: { toolCallId: `${"a".repeat(25)}🚀bbb` },
      },
      field: "call",
      expected: `${"a".repeat(12)}…bbb`,
    },
  ])("summarizeAgentEventForWsLog keeps the $name UTF-16 safe", ({ payload, field, expected }) => {
    const value = summarizeAgentEventForWsLog(payload)[field];

    expect(value).toBe(expected);
    expect(value).not.toMatch(/[\uD800-\uDFFF]/);
  });

  test.each([
    {
      name: "formats Error instances",
      input: Object.assign(new Error("boom"), { name: "TestError" }),
      expected: "TestError: boom",
    },
    {
      name: "formats message-like objects with codes",
      input: { name: "Oops", message: "failed", code: "E1" },
      expected: "Oops: failed: code=E1",
    },
  ])("formatForLog $name", ({ input, expected }) => {
    expect(formatForLog(input)).toBe(expected);
  });

  test("formatForLog walks cause chain so the underlying error is not hidden (openclaw-4a8)", () => {
    const root = Object.assign(new Error('"Method not found": nes/close (-32601)'), {
      name: "RequestError",
    });
    const wrapped = new Error("Agent does not support session/close (oneshot:abc)", {
      cause: root,
    });
    const top = Object.assign(new Error("ACP turn failed before completion.", { cause: wrapped }), {
      name: "AcpRuntimeError",
      code: "ACP_TURN_FAILED",
    });

    const out = formatForLog(top);

    expect(out).toMatch(/AcpRuntimeError/);
    expect(out).toMatch(/ACP_TURN_FAILED/);
    expect(out).toMatch(/Agent does not support session\/close/);
    expect(out).toMatch(/Method not found/);
    expect(out).toMatch(/nes\/close/);
    expect(out).toMatch(/-32601/);
  });

  test("formatForLog caps cause-chain depth so a self-referential cause cannot loop", () => {
    const e: Error & { cause?: unknown } = new Error("loop");
    e.cause = e;

    const out = formatForLog(e);

    expect(out).toMatch(/loop/);
    expect(out.length).toBeLessThan(2000);
  });

  test("formatForLog redacts obvious secrets", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const out = formatForLog({ token });
    expect(out).toContain("token");
    expect(out).not.toContain(token);
    expect(out).toContain("…");
  });

  test.each([
    ["string", `${"a".repeat(239)}😀tail`],
    ["Error", Object.assign(new Error(`${"a".repeat(239)}😀tail`), { name: "" })],
    ["message-like object", { message: `${"a".repeat(239)}😀tail` }],
  ])("formatForLog keeps bounded %s values UTF-16 safe", (_name, input) => {
    expect(formatForLog(input)).toBe(`${"a".repeat(239)}...`);
  });

  test("summarizeAgentEventForWsLog compacts assistant payloads", () => {
    const summary = summarizeAgentEventForWsLog({
      runId: "12345678-1234-1234-1234-123456789abc",
      sessionKey: "agent:main:main",
      stream: "assistant",
      seq: 2,
      data: {
        text: "hello\n\nworld ".repeat(20),
        mediaUrls: ["a", "b"],
      },
    });

    expect(summary.agent).toBe("main");
    expect(summary.run).toBe("12345678…9abc");
    expect(summary.session).toBe("main");
    expect(summary.stream).toBe("assistant");
    expect(summary.aseq).toBe(2);
    expect(summary.media).toBe(2);
    expect(summary.text).toBeTypeOf("string");
    expect(summary.text).not.toContain("\n");
  });

  test("summarizeAgentEventForWsLog keeps compact previews UTF-16 safe", () => {
    const summary = summarizeAgentEventForWsLog({
      stream: "assistant",
      data: { text: `${"a".repeat(158)}😀tail` },
    });

    expect(summary.text).toBe(`${"a".repeat(158)}…`);
  });

  test("summarizeAgentEventForWsLog includes tool metadata", () => {
    const summary = summarizeAgentEventForWsLog({
      runId: "run-1",
      stream: "tool",
      data: { phase: "start", name: "fetch", toolCallId: "12345678-1234-1234-1234-123456789abc" },
    });
    expect(summary.run).toBe("run-1");
    expect(summary.stream).toBe("tool");
    expect(summary.tool).toBe("start:fetch");
    expect(summary.call).toBe("12345678…9abc");
  });

  test("summarizeAgentEventForWsLog includes lifecycle errors with compact previews", () => {
    const summary = summarizeAgentEventForWsLog({
      runId: "run-2",
      sessionKey: "agent:main:thread-1",
      stream: "lifecycle",
      data: {
        phase: "abort",
        aborted: true,
        error: "fatal ".repeat(40),
      },
    });

    expect(summary.agent).toBe("main");
    expect(summary.session).toBe("thread-1");
    expect(summary.stream).toBe("lifecycle");
    expect(summary.phase).toBe("abort");
    expect(summary.aborted).toBe(true);
    expect(summary.error).toBeTypeOf("string");
    expect((summary.error as string).length).toBeLessThanOrEqual(120);
  });

  test("summarizeAgentEventForWsLog preserves invalid session keys and unknown-stream reasons", () => {
    expect(
      summarizeAgentEventForWsLog({
        sessionKey: "bogus-session",
        stream: "other",
        data: { reason: "dropped" },
      }),
    ).toEqual({
      session: "bogus-session",
      stream: "other",
      reason: "dropped",
    });
  });
});
