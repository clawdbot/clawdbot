import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  inspectOtelParentGraph,
  parseOtelGenerationConfigWatcherOptions,
  sanitizeOtelWatcherFailure,
} from "./otel-generation-config-watcher-contract.js";

describe("OTEL generation config watcher runtime", () => {
  it("keeps the full same-PID proof in the QA script scenario", () => {
    const scenario = fs.readFileSync(
      "qa/scenarios/observability/otel-generation-config-watcher.yaml",
      "utf8",
    );
    expect(scenario).toContain("kind: script");
    expect(scenario).toContain(
      "path: test/e2e/qa-lab/runtime/otel-generation-config-watcher-runtime.ts",
    );
  });

  it("rejects missing output-dir values", () => {
    expect(() => parseOtelGenerationConfigWatcherOptions(["--output-dir"])).toThrow(
      "--output-dir requires a value",
    );
  });

  it("redacts local failure details before writing artifacts", () => {
    const localEndpoint = `http://${["127", "0", "0", "1"].join(".")}:4318`;
    const gatewayToken = "qa-suite-12345678-1234-1234-1234-123456789abc";
    const failure = sanitizeOtelWatcherFailure(
      new Error(
        `failed at /workspace/repo/test.ts via ${localEndpoint} in /tmp/openclaw-qa-suite-private with ${gatewayToken}`,
      ),
      "/workspace/repo",
    );
    expect(failure).toContain("<repo>");
    expect(failure).toContain("<local-endpoint>");
    expect(failure).toContain("<temp-path>");
    expect(failure).toContain("<gateway-token>");
    expect(failure).not.toContain("/workspace/repo");
    expect(failure).not.toContain(localEndpoint);
  });

  it("requires every exported span chain to terminate at the injected parent", () => {
    const externalParentSpanId = "1111111111111111";
    const unrelatedParentSpanId = "2222222222222222";
    const rootSpanId = "aaaaaaaaaaaaaaaa";
    const childSpanId = "bbbbbbbbbbbbbbbb";
    const base = {
      attributes: {},
      name: "span",
      parent: true,
      traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const inspect = (spans: Parameters<typeof inspectOtelParentGraph>[0]) =>
      inspectOtelParentGraph(spans, externalParentSpanId);
    expect(
      inspect([
        { ...base, parentSpanId: externalParentSpanId, spanId: rootSpanId },
        { ...base, parentSpanId: rootSpanId, spanId: childSpanId },
      ]),
    ).toEqual({
      externalParentSpanIds: [externalParentSpanId],
      valid: true,
    });
    for (const spans of [
      [
        { ...base, parentSpanId: unrelatedParentSpanId, spanId: rootSpanId },
        { ...base, parentSpanId: rootSpanId, spanId: childSpanId },
      ],
      [
        { ...base, parentSpanId: externalParentSpanId, spanId: rootSpanId },
        { ...base, parentSpanId: undefined, spanId: childSpanId },
      ],
      [
        { ...base, parentSpanId: childSpanId, spanId: rootSpanId },
        { ...base, parentSpanId: rootSpanId, spanId: childSpanId },
      ],
    ]) {
      expect(inspect(spans)).toMatchObject({ valid: false });
    }
  });
});
