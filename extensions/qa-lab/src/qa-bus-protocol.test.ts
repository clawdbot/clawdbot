import {
  parseQaTarget as parseCanonicalQaTarget,
  sanitizeQaBusToolCalls as sanitizeCanonicalQaBusToolCalls,
} from "openclaw/plugin-sdk/qa-channel-protocol";
import { describe, expect, it } from "vitest";
import { parseQaTarget, sanitizeQaBusToolCalls } from "./qa-bus-protocol.js";

describe("QA Lab package bus protocol", () => {
  it.each([
    "bare-id",
    "channel:CaseSensitive",
    "group:team-room",
    "dm:user-1",
    "thread:Room/Topic",
  ])("matches the canonical target parser for %s", (target) => {
    expect(parseQaTarget(target)).toEqual(parseCanonicalQaTarget(target));
  });

  it.each(["", "CHANNEL:CaseSensitive", "thread:Room/", "dm:"])(
    "matches canonical target errors for %j",
    (target) => {
      expect(() => parseQaTarget(target)).toThrow();
      expect(() => parseCanonicalQaTarget(target)).toThrow();
    },
  );

  it("matches canonical bounded redaction", () => {
    const toolCalls = [
      null,
      { name: 123 },
      {
        name: " exec ",
        arguments: {
          command: "cat README.md",
          apiToken: "secret-token",
          headers: { Authorization: "Bearer secret" },
          values: ["ok", { password: "hunter2" }],
          nested: { one: { two: { three: { four: "truncated" } } } },
          finite: 42,
          infinite: Number.POSITIVE_INFINITY,
          bigint: 123n,
          omitted: undefined,
        },
      },
    ];

    expect(sanitizeQaBusToolCalls(toolCalls)).toEqual(sanitizeCanonicalQaBusToolCalls(toolCalls));
  });

  it("matches the canonical count limit without processing the tail", () => {
    const toolCalls = Array.from({ length: 50 }, (_, index) => ({ name: `tool-${index}` }));
    toolCalls.push({
      get name(): string {
        throw new Error("tail should not be sanitized");
      },
    });

    expect(sanitizeQaBusToolCalls(toolCalls)).toEqual(sanitizeCanonicalQaBusToolCalls(toolCalls));
  });
});
