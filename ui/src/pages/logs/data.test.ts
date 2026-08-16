// @vitest-environment node
// Control UI tests cover logs behavior.
import { describe, expect, it } from "vitest";
import { parseLogLine } from "./log-lines.ts";

describe("parseLogLine", () => {
  it.each([
    {
      name: "uses the complete persisted message for subsystem records",
      record: {
        "0": '{"subsystem":"gateway"}',
        "1": "request failed",
        "2": "retry later",
        message: "request failed retry later",
        time: "2026-08-01T15:00:00.000Z",
        _meta: { logLevelName: "ERROR" },
      },
      message: "request failed retry later",
      subsystem: "gateway",
      level: "error",
      time: "2026-08-01T15:00:00.000Z",
    },
    {
      name: "joins every numeric segment for positional-only legacy records",
      record: {
        "0": '{"subsystem":"gateway"}',
        "1": "legacy request failed",
      },
      message: '{"subsystem":"gateway"} legacy request failed',
      subsystem: "gateway",
      level: null,
      time: null,
    },
    {
      name: "uses the complete persisted message for generic positional records",
      record: {
        "0": "worker",
        "1": "request failed",
        "2": "retry later",
        message: "request failed retry later",
      },
      message: "request failed retry later",
      subsystem: null,
      level: null,
      time: null,
    },
  ])("$name", ({ record, message, subsystem, level, time }) => {
    const parsed = parseLogLine(JSON.stringify(record));

    expect(parsed.message).toBe(message);
    expect(parsed.subsystem).toBe(subsystem);
    expect(parsed.level).toBe(level);
    expect(parsed.time).toBe(time);
  });

  it("strips ANSI escape sequences from rendered log fields", () => {
    const parsed = parseLogLine(
      JSON.stringify({
        message: "\u001b[31mfailed\u001b[39m to start",
        _meta: { name: '{"subsystem":"gateway"}', logLevelName: "error" },
      }),
    );

    expect(parsed.subsystem).toBe("gateway");
    expect(parsed.message).toBe("failed to start");
    expect(parsed.raw).toContain("\\u001b");
  });

  it("strips ANSI escape sequences from plain log lines", () => {
    expect(parseLogLine("\u001b[33mwarning\u001b[39m").message).toBe("warning");
  });

  it("strips OSC hyperlink escape payloads from displayed log fields", () => {
    const link = "\u001b]8;;https://example.test\u0007docs\u001b]8;;\u0007";

    expect(parseLogLine(`${link} ready`).message).toBe("docs ready");
  });
});
