import { describe, expect, test } from "vitest";
import { formatForLog, shortId, summarizeAgentEventForWsLog } from "./ws-log.js";

describe("gateway ws log helpers", () => {
  test("shortId compacts uuids and long strings", () => {
    expect(shortId("12345678-1234-1234-1234-123456789abc")).toBe("12345678…9abc");
    expect(shortId("a".repeat(30))).toBe("aaaaaaaaaaaa…aaaa");
    expect(shortId("short")).toBe("short");
  });

  test("formatForLog formats errors and messages", () => {
    const err = new Error("boom");
    err.name = "TestError";
    expect(formatForLog(err)).toContain("TestError");
    expect(formatForLog(err)).toContain("boom");

    const obj = { name: "Oops", message: "failed", code: "E1" };
    expect(formatForLog(obj)).toBe("Oops: failed: code=E1");
  });

  test("formatForLog redacts obvious secrets", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const out = formatForLog({ token });
    expect(out).toContain("token");
    expect(out).not.toContain(token);
    expect(out).toContain("…");
  });

  test("summarizeAgentEventForWsLog extracts useful fields", () => {
    const summary = summarizeAgentEventForWsLog({
      runId: "12345678-1234-1234-1234-123456789abc",
      sessionKey: "agent:main:main",
      stream: "assistant",
      seq: 2,
      data: { text: "hello world", mediaUrls: ["a", "b"] },
    });
    expect(summary).toMatchObject({
      agent: "main",
      run: "12345678…9abc",
      session: "main",
      stream: "assistant",
      aseq: 2,
      text: "hello world",
      media: 2,
    });

    const tool = summarizeAgentEventForWsLog({
      runId: "run-1",
      stream: "tool",
      data: { phase: "start", name: "fetch", toolCallId: "call-1" },
    });
    expect(tool).toMatchObject({
      stream: "tool",
      tool: "start:fetch",
      call: "call-1",
    });
  });
});
