// Log line parsing tests cover structured log parsing from text lines.
import { describe, expect, it } from "vitest";
import { parseLogLine } from "./parse-log-line.js";

describe("parseLogLine", () => {
  it("parses structured JSON log lines", () => {
    const line = JSON.stringify({
      time: "2026-01-09T01:38:41.523Z",
      0: '{"subsystem":"gateway/channels/demo-channel"}',
      1: "connected",
      _meta: {
        name: '{"subsystem":"gateway/channels/demo-channel"}',
        logLevelName: "INFO",
      },
    });

    const parsed = parseLogLine(line);

    expect(parsed?.time).toBe("2026-01-09T01:38:41.523Z");
    expect(parsed?.level).toBe("info");
    expect(parsed?.subsystem).toBe("gateway/channels/demo-channel");
    expect(parsed?.message).toBe('{"subsystem":"gateway/channels/demo-channel"} connected');
    expect(parsed?.raw).toBe(line);
  });

  it("prefers the complete persisted message while preserving numeric joining as fallback", () => {
    const persisted = parseLogLine(
      JSON.stringify({
        0: '{"subsystem":"gateway"}',
        1: "request failed",
        2: "retry later",
        message: "request failed retry later",
      }),
    );
    const positional = parseLogLine(
      JSON.stringify({ 0: "worker", 1: "request failed", 2: { retry: true } }),
    );

    expect(persisted?.message).toBe("request failed retry later");
    expect(positional?.message).toBe('worker request failed {"retry":true}');
  });

  it("uses structured metadata context before a structured positional fallback", () => {
    expect(
      parseLogLine(
        JSON.stringify({
          0: '{"subsystem":"legacy"}',
          1: "ready",
          _meta: { name: '{"module":"queue"}' },
        }),
      )?.module,
    ).toBe("queue");
    expect(
      parseLogLine(JSON.stringify({ 0: '{"subsystem":"legacy"}', 1: "ready" }))?.subsystem,
    ).toBe("legacy");
    expect(parseLogLine(JSON.stringify({ 0: "worker", 1: "ready" }))?.subsystem).toBeUndefined();
  });

  it("retains the exact plugin identity from logger binding metadata", () => {
    const parsed = parseLogLine(
      JSON.stringify({
        0: '{"subsystem":"gateway/channels/external-chat"}',
        1: "sent",
        _meta: { name: '{"plugin":"vendor-external-chat","feature":"delivery"}' },
      }),
    );

    expect(parsed?.plugin).toBe("vendor-external-chat");
    expect(parsed?.subsystem).toBe("gateway/channels/external-chat");
  });

  it("falls back to meta timestamp when top-level time is missing", () => {
    const line = JSON.stringify({
      0: "hello",
      _meta: {
        name: '{"subsystem":"gateway"}',
        logLevelName: "WARN",
        date: "2026-01-09T02:10:00.000Z",
      },
    });

    const parsed = parseLogLine(line);

    expect(parsed?.time).toBe("2026-01-09T02:10:00.000Z");
    expect(parsed?.level).toBe("warn");
  });

  it("returns null for invalid JSON", () => {
    expect(parseLogLine("not-json")).toBeNull();
    expect(parseLogLine("null")).toBeNull();
  });
});
