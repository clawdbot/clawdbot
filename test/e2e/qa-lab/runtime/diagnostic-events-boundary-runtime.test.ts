import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateQaEvidenceSummaryJson } from "../../../../extensions/qa-lab/api.js";
import {
  runDiagnosticEventsBoundaryRuntime,
  testing,
} from "./diagnostic-events-boundary-runtime.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { force: true, recursive: true })));
});

describe("diagnostic events boundary runtime", () => {
  it("composes async dispatch, trusted subscriptions, and model-call trace propagation", async () => {
    const artifactBase = await fs.mkdtemp(path.join(os.tmpdir(), "diagnostic-events-boundary-"));
    tempDirs.push(artifactBase);
    const repoRoot = process.cwd();
    const checkoutSha = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
    }).trim();
    vi.stubEnv("OPENCLAW_QA_REF", checkoutSha);
    vi.stubEnv("OPENCLAW_QA_PACKAGE_SOURCE_KIND", "source-checkout");
    vi.stubEnv("OPENCLAW_QA_PACKAGE_SOURCE_SHA", checkoutSha);

    const { evidence, summary } = await runDiagnosticEventsBoundaryRuntime({
      artifactBase,
      repoRoot,
    });

    const diskEvidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(path.join(artifactBase, "qa-evidence.json"), "utf8")),
    );
    expect(diskEvidence).toEqual(evidence);
    expect(evidence.schemaVersion).toBe(2);
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]).toMatchObject({
      coverage: [
        { id: "observability.async-dispatch", role: "primary" },
        { id: "observability.diagnostic-event-types", role: "primary" },
        { id: "observability.model-call-diagnostic-events", role: "primary" },
        { id: "observability.plugin-sdk-diagnostic-runtime-exports", role: "primary" },
        { id: "observability.trusted-diagnostic-event-subscription", role: "primary" },
        { id: "observability.trusted-trace-context", role: "primary" },
        { id: "observability.w3c-trace-context-creation", role: "primary" },
      ],
      execution: {
        artifacts: [
          { kind: "log", path: "diagnostic-events-boundary.log", source: "script" },
          {
            kind: "summary",
            path: "diagnostic-events-boundary-summary.json",
            source: "script",
          },
        ],
        environment: { ref: checkoutSha },
        packageSource: { kind: "source-checkout", sha: checkoutSha },
      },
      result: { status: "pass" },
      test: {
        id: "diagnostic-events-boundary",
        source: { path: "test/e2e/qa-lab/runtime/diagnostic-events-boundary-runtime.ts" },
      },
    });
    expect(summary).toMatchObject({
      deliveredBeforeDrain: 0,
      eventTypes: ["model.call.started", "model.call.completed"],
      failures: [],
      immutableEventCopies: true,
      passed: true,
      pendingBeforeDrain: true,
      privateEventCount: 2,
      publicEventTypes: ["message.queued"],
      trustedEventCount: 2,
    });
    expect(summary.propagatedTraceparent).toMatch(
      /^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/u,
    );
    const summaryText = await fs.readFile(
      path.join(artifactBase, "diagnostic-events-boundary-summary.json"),
      "utf8",
    );
    expect(summaryText).not.toContain("diagnostic-boundary-private-input");
  });

  it("rejects missing output-dir values", () => {
    expect(() => testing.parseOptions(["--output-dir"])).toThrow("--output-dir requires a value");
  });
});
