import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { testing } from "../../scripts/qa-otel-smoke.ts";

describe("qa-otel-smoke receiver bounds", () => {
  let configuredBodyLimitLoad: ReturnType<typeof spawnSync>;

  beforeAll(() => {
    configuredBodyLimitLoad = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        'await import("./scripts/qa-otel-smoke.ts");',
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_QA_OTEL_MAX_CAPTURED_BODY_TEXT_BYTES: "1024",
          OPENCLAW_QA_OTEL_MAX_COMPRESSED_BODY_BYTES: "2048",
          OPENCLAW_QA_OTEL_MAX_DECODED_BODY_BYTES: "4096",
        },
      },
    );
  });

  it("accepts package-manager forwarded arguments", () => {
    expect(
      testing.parseArgs([
        "--",
        "--collector",
        "docker",
        "--provider-mode",
        "mock-openai",
        "--scenario",
        "otel-trace-smoke",
      ]),
    ).toMatchObject({
      collectorMode: "docker",
      providerMode: "mock-openai",
      scenarioId: "otel-trace-smoke",
    });
  });

  it("parses body-size limit env values as strict positive integers", () => {
    expect(testing.readPositiveIntegerEnv("OTEL_TEST_LIMIT", 64, {})).toBe(64);
    expect(
      testing.readPositiveIntegerEnv("OTEL_TEST_LIMIT", 64, { OTEL_TEST_LIMIT: " 128 " }),
    ).toBe(128);

    expect(() =>
      testing.readPositiveIntegerEnv("OTEL_TEST_LIMIT", 64, { OTEL_TEST_LIMIT: "1e3" }),
    ).toThrow("OTEL_TEST_LIMIT must be a positive integer");
    expect(() =>
      testing.readPositiveIntegerEnv("OTEL_TEST_LIMIT", 64, { OTEL_TEST_LIMIT: "1024bytes" }),
    ).toThrow("OTEL_TEST_LIMIT must be a positive integer");
    expect(() =>
      testing.readPositiveIntegerEnv("OTEL_TEST_LIMIT", 64, { OTEL_TEST_LIMIT: "0" }),
    ).toThrow("OTEL_TEST_LIMIT must be a positive integer");
  });

  it("loads with configured body-size limit env values", () => {
    expect(configuredBodyLimitLoad.status).toBe(0);
    expect(configuredBodyLimitLoad.stderr).not.toContain("ReferenceError");
  });

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
