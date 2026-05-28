import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { testing } from "../../scripts/qa-otel-smoke.ts";

describe("qa-otel-smoke receiver bounds", () => {
  it("rejects identity OTLP bodies above the decoded byte ceiling", () => {
    expect(() => testing.decodeRequestBody(Buffer.alloc(65), undefined, 64)).toThrow(
      "OTLP request body exceeded 64 bytes: 65 bytes",
    );
  });

  it("rejects gzip OTLP bodies above the decoded byte ceiling", () => {
    const compressed = gzipSync(Buffer.alloc(256, "a"));

    expect(() => testing.decodeRequestBody(compressed, "gzip", 64)).toThrow(
      "decoded OTLP request body exceeded 64 bytes",
    );
  });

  it("keeps captured OTLP body text bounded per signal", () => {
    const captured: { traces?: string[] } = {};

    testing.appendCapturedBodyText(captured, "traces", Buffer.from("a".repeat(20)), 16, [
      "OTEL-QA-SECRET",
    ]);
    testing.appendCapturedBodyText(captured, "traces", Buffer.from("b".repeat(20)), 16);

    expect(captured.traces).toHaveLength(1);
    expect(captured.traces?.[0]).toContain("[captured body text truncated to last 16 bytes]");
    expect(captured.traces?.[0]).toContain("b".repeat(16));
    expect(captured.traces?.[0]).not.toContain("a".repeat(20));
  });

  it("preserves leak markers even when later body text is truncated", () => {
    const captured: { traces?: string[] } = {};

    testing.appendCapturedBodyText(
      captured,
      "traces",
      Buffer.from(`prefix OTEL-QA-SECRET ${"a".repeat(20)}`),
      16,
      ["OTEL-QA-SECRET"],
    );
    testing.appendCapturedBodyText(captured, "traces", Buffer.from("b".repeat(128)), 16, [
      "OTEL-QA-SECRET",
    ]);

    expect(captured.traces?.join("\n")).toContain("OTEL-QA-SECRET");
    expect(captured.traces?.join("\n")).toContain("[captured body text truncated");
  });
});
