// Telemetry runtime boundary tests cover real QA-channel evidence and honest task followthrough.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runQaSuite,
  startQaLabServer,
  validateQaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

const SCENARIO_IDS = ["telemetry-qa-lab-bus", "telemetry-task-evidence-followthrough"] as const;
const PRIMARY_COVERAGE_IDS = [
  "observability.telemetry-evidence",
  "observability.telemetry-no-fake-progress",
  "observability.telemetry-qa-bus",
  "observability.telemetry-qa-lab",
  "observability.telemetry-task-followthrough",
] as const;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("telemetry runtime boundaries", () => {
  it("writes exact QA Lab evidence for real bus telemetry and task followthrough", async () => {
    const repoRoot = process.cwd();
    const artifactRoot = path.join(repoRoot, ".artifacts", "qa-e2e");
    await fs.mkdir(artifactRoot, { recursive: true });
    const outputDir = tempDirs.make("openclaw-telemetry-runtime-", artifactRoot);
    const runtime = await runQaSuite({
      alternateModel: "mock-openai/gpt-5.6-luna",
      concurrency: 1,
      outputDir,
      primaryModel: "mock-openai/gpt-5.6-luna",
      providerMode: "mock-openai",
      repoRoot,
      scenarioIds: [...SCENARIO_IDS],
      startLab: startQaLabServer,
    });

    expect(runtime.executionKind).toBe("flow");
    expect(runtime.result.scenarios).toEqual(
      SCENARIO_IDS.map(() =>
        expect.objectContaining({
          name: expect.any(String),
          status: "pass",
          steps: [expect.objectContaining({ status: "pass" })],
        }),
      ),
    );

    const summary = JSON.parse(await fs.readFile(runtime.result.summaryPath, "utf8")) as {
      counts?: { failed?: number; passed?: number; skipped?: number; total?: number };
      run?: {
        providerMode?: string;
        primaryModel?: string;
        scenarioIds?: string[];
      };
      scenarios?: Array<{ name?: string; status?: string }>;
    };
    expect(summary.counts).toEqual({ total: 2, passed: 2, failed: 0, skipped: 0 });
    expect(summary.run).toMatchObject({
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      scenarioIds: [...SCENARIO_IDS],
    });
    expect(summary.scenarios?.map((scenario) => scenario.status)).toEqual(["pass", "pass"]);

    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(runtime.result.evidencePath, "utf8")),
    );
    expect(evidence.entries.map((entry) => entry.test.id)).toEqual([...SCENARIO_IDS]);
    expect(
      evidence.entries
        .flatMap((entry) => entry.coverage)
        .filter((coverage) => coverage.role === "primary")
        .map((coverage) => coverage.id)
        .toSorted(),
    ).toEqual([...PRIMARY_COVERAGE_IDS].toSorted());

    for (const entry of evidence.entries) {
      expect(entry.result.status).toBe("pass");
      expect(entry.execution).toMatchObject({
        runner: "host",
        provider: {
          id: "openai",
          live: false,
          fixture: "mock-openai",
          model: {
            name: "gpt-5.6-luna",
            ref: "mock-openai/gpt-5.6-luna",
          },
        },
        channel: {
          id: "qa-channel",
          live: false,
        },
        packageSource: { kind: "source-checkout" },
      });
      expect(entry.execution?.environment).toEqual({
        ref: expect.any(String),
        os: expect.any(String),
        nodeVersion: expect.stringMatching(/^v\d+/u),
      });
      expect(entry.execution?.artifacts).toEqual([
        { kind: "summary", path: "qa-suite-summary.json", source: "qa-suite" },
        { kind: "report", path: "qa-suite-report.md", source: "qa-suite" },
      ]);
    }

    const artifactText = await Promise.all(
      [runtime.result.summaryPath, runtime.result.evidencePath, runtime.result.reportPath].map(
        async (artifactPath) => await fs.readFile(artifactPath, "utf8"),
      ),
    );
    const serializedArtifacts = artifactText.join("\n");
    expect(serializedArtifacts).not.toContain(repoRoot);
    expect(serializedArtifacts).not.toContain("PERSONAL_TASK_LEDGER.md");
    expect(serializedArtifacts).not.toContain("FOLLOWTHROUGH_NOTE.md");
    expect(serializedArtifacts).not.toContain("QA_TELEMETRY_PROBE.md");
    expect(path.basename(runtime.result.outputDir)).toMatch(/^openclaw-telemetry-runtime-/u);
  }, 180_000);
});
