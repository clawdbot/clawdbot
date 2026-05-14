import { describe, expect, it } from "vitest";
import { encodeStartupTraceSegment } from "./startup-trace-segment.js";

describe("encodeStartupTraceSegment", () => {
  it("keeps distinct trace owner ids non-colliding", () => {
    const encoded = [
      encodeStartupTraceSegment("plugin:test"),
      encodeStartupTraceSegment("plugin_test"),
      encodeStartupTraceSegment("service/a"),
      encodeStartupTraceSegment("service_a"),
      encodeStartupTraceSegment(""),
      encodeStartupTraceSegment("~"),
    ];

    expect(encoded).toEqual([
      "plugin~003Atest",
      "plugin_test",
      "service~002Fa",
      "service_a",
      "~",
      "~007E",
    ]);
    expect(new Set(encoded).size).toBe(encoded.length);
  });
});
