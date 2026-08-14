import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  runOtelGenerationConfigWatcherRuntime,
  testing,
} from "./otel-generation-config-watcher-runtime.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("OTEL generation config watcher runtime", () => {
  it(
    "keeps all three signals on the active same-PID provider generation",
    { timeout: 300_000 },
    async () => {
      const artifactBase = tempDirs.make("otel-generation-config-watcher-");

      const { evidence, summary } = await runOtelGenerationConfigWatcherRuntime({
        artifactBase,
        repoRoot: process.cwd(),
      });

      expect(evidence.schemaVersion).toBe(2);
      expect(evidence.entries[0]?.result.status).toBe("pass");
      expect(summary).toMatchObject({
        collectorAPostReadyRequestCount: 0,
        failures: [],
        noRespawn: true,
        passed: true,
        pid: { same: true },
        readyAfterMutation: true,
        restartLogObserved: true,
      });
      for (const [collector, parentSpanId] of [
        [summary.collectorA, "1111111111111111"],
        [summary.collectorB, "2222222222222222"],
      ] as const) {
        expect(collector).toMatchObject({
          externalParentSpanIds: [parentSpanId],
          failedRequestCount: 0,
          logCorrelationValid: true,
          parentGraphValid: true,
          requiredSpanNames: ["openclaw.model.call", "openclaw.run"],
          traceparentAccepted: true,
        });
        expect(collector?.signalRequestCounts).toMatchObject({
          logs: expect.any(Number),
          metrics: expect.any(Number),
          traces: expect.any(Number),
        });
        expect(collector?.signalRequestCounts.logs).toBeGreaterThan(0);
        expect(collector?.signalRequestCounts.metrics).toBeGreaterThan(0);
        expect(collector?.signalRequestCounts.traces).toBeGreaterThan(0);
      }

      const summaryText = await fs.readFile(
        path.join(artifactBase, "otel-generation-config-watcher-summary.json"),
        "utf8",
      );
      expect(summaryText).not.toContain(artifactBase);
      expect(summaryText).not.toContain("http://127.0.0.1");
      const evidenceText = await fs.readFile(path.join(artifactBase, "qa-evidence.json"), "utf8");
      expect(evidenceText).not.toContain(artifactBase);
    },
  );

  it("rejects missing output-dir values", () => {
    expect(() => testing.parseOptions(["--output-dir"])).toThrow("--output-dir requires a value");
  });

  it("redacts local failure details before writing artifacts", () => {
    const localEndpoint = `http://${["127", "0", "0", "1"].join(".")}:4318`;
    const gatewayToken = "qa-suite-12345678-1234-1234-1234-123456789abc";
    const failure = testing.sanitizeProofFailure(
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
    const inspect = (spans: Parameters<typeof testing.inspectParentGraph>[0]) =>
      testing.inspectParentGraph(spans, externalParentSpanId);
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
