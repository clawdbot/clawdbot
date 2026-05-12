import { describe, expect, test } from "vitest";
import { formatForLog, shortId, summarizeAgentEventForWsLog } from "./ws-log.js";

describe("gateway ws log helpers", () => {
  test.each([
    {
      name: "compacts uuids",
      input: "12345678-1234-1234-1234-123456789abc",
      expected: "12345678…9abc",
    },
    {
      name: "compacts long strings",
      input: "a".repeat(30),
      expected: "aaaaaaaaaaaa…aaaa",
    },
    {
      name: "trims before checking length",
      input: " short ",
      expected: "short",
    },
  ])("shortId $name", ({ input, expected }) => {
    expect(shortId(input)).toBe(expected);
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
