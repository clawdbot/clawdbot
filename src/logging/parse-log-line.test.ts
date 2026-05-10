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
  });
});
