// Qa Lab tests cover confidence report plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildQaConfidenceReport,
  renderQaConfidenceMarkdownReport,
  writeQaConfidenceSelfTestArtifacts,
} from "./confidence-report.js";

type QaConfidenceManifest = Parameters<typeof buildQaConfidenceReport>[0]["manifest"];

describe("qa confidence report", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-confidence-"));
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  async function writeJson(relativePath: string, payload: unknown) {
    const filePath = path.join(tempRoot, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const value =
      relativePath.endsWith("qa-suite-summary.json") &&
      payload &&
      typeof payload === "object" &&
      !Array.isArray(payload) &&
      !("run" in payload)
        ? { run: { status: "completed" }, ...payload }
        : payload;
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return filePath;
  }

  async function buildStrictSuiteReport(payload: Record<string, unknown>, withBackfill = false) {
    await writeJson("report-only/qa-suite-summary.json", payload);
    const lanes: QaConfidenceManifest["lanes"] = [
      {
        id: "report-only",
        title: "Report-only",
        kind: "qa-suite-summary",
        artifact: "report-only/qa-suite-summary.json",
        required: true,
        ...(withBackfill ? { skipBackfillLane: "backfill" } : {}),
      },
    ];
    if (withBackfill) {
      await writeJson("backfill/qa-suite-summary.json", {
        counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
      });
      lanes.push({
        id: "backfill",
        title: "Passing backfill",
        kind: "qa-suite-summary",
        artifact: "backfill/qa-suite-summary.json",
        required: true,
      });
    }
    return buildQaConfidenceReport({
      manifest: { version: 1, profile: "confidence-regression", lanes },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      strictGlobalPass: true,
    });
  }

  it("passes strict zero-unknowns when every lane passes or has an allowed blocked verdict", async () => {
    await writeJson("tool-defaults/qa-suite-summary.json", {
      counts: { total: 20, passed: 18, skipped: 2, failed: 0 },
    });
    await writeJson("token/qa-runtime-token-efficiency-summary.json", {
      status: "estimated",
      pass: true,
      rows: [{ scenarioId: "one", usageSource: "mock-estimate" }],
    });

    const manifest: QaConfidenceManifest = {
      version: 1,
      profile: "codex-100",
      lanes: [
        {
          id: "tool-defaults-direct",
          title: "Tool defaults direct",
          kind: "qa-suite-summary",
          artifact: "tool-defaults/qa-suite-summary.json",
          required: true,
        },
        {
          id: "mock-token-efficiency",
          title: "Mock token efficiency",
          kind: "token-efficiency-summary",
          artifact: "token/qa-runtime-token-efficiency-summary.json",
          required: true,
          expectedTokenUsageSource: "mock-estimate",
        },
        {
          id: "live-token-efficiency",
          title: "Live token efficiency",
          kind: "token-efficiency-summary",
          artifact: "live/qa-runtime-token-efficiency-summary.json",
          required: true,
          missingVerdict: "environment-blocked",
          missingReason: "OPENAI OAuth credentials are not available in this runner.",
        },
      ],
    };

    const report = await buildQaConfidenceReport({
      manifest,
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.globalPass).toBe(false);
    expect(report.counts).toMatchObject({ passed: 2, blocked: 1, unknown: 0, failed: 0 });
    expect(report.lanes.map((lane) => lane.verdict)).toEqual([
      "pass",
      "pass",
      "environment-blocked",
    ]);
    expect(report.lanes[0]?.artifactPath).toBe("tool-defaults/qa-suite-summary.json");
    expect(report.lanes[0]?.artifactPath).not.toContain(tempRoot);
    expect(report.lanes[0]?.details).toContain("counts.skipped=2");
    expect(renderQaConfidenceMarkdownReport(report)).toContain("Zero unknowns: yes");
    expect(renderQaConfidenceMarkdownReport(report)).toContain("Global pass: no");
  });

  it("uses suite lifecycle status before terminal outcome counts", async () => {
    const manifest: QaConfidenceManifest = {
      version: 1,
      profile: "codex-100",
      lanes: [
        {
          id: "suite",
          title: "Suite",
          kind: "qa-suite-summary",
          artifact: "suite/qa-suite-summary.json",
          required: true,
        },
      ],
    };
    for (const [runStatus, expectedPass, expectedLaneStatus, expectedDetails] of [
      ["missing", false, "unknown", "missing run.status"],
      ["running", false, "unknown", "still running"],
      ["completed", true, "pass", "counts.failed=0"],
      ["paused", false, "unknown", "unsupported run.status=paused"],
    ] as const) {
      await writeJson("suite/qa-suite-summary.json", {
        run: runStatus === "missing" ? {} : { status: runStatus },
        counts: { total: 1, passed: 1, skipped: 0, failed: 0 },
        scenarios: [{ name: "completed prefix", status: "pass" }],
      });

      const report = await buildQaConfidenceReport({
        manifest,
        artifactRoot: tempRoot,
        strictGlobalPass: true,
      });

      expect(report.pass).toBe(expectedPass);
      expect(report.lanes[0]).toMatchObject({ status: expectedLaneStatus });
      expect(report.lanes[0]?.details).toContain(expectedDetails);
    }
  });

  it("does not let optional lanes block strict gates", async () => {
    await writeJson("required/qa-suite-summary.json", {
      counts: { total: 1, passed: 1, skipped: 0, failed: 0 },
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "required",
            title: "Required",
            kind: "qa-suite-summary",
            artifact: "required/qa-suite-summary.json",
            required: true,
          },
          {
            id: "optional-missing",
            title: "Optional missing",
            kind: "qa-suite-summary",
            artifact: "optional/qa-suite-summary.json",
            required: false,
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      strictGlobalPass: true,
      generatedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.counts).toMatchObject({ total: 1, passed: 1, unknown: 0 });
    expect(report.failures).toEqual([]);
    expect(report.lanes[1]).toMatchObject({ id: "optional-missing", status: "missing" });
  });

  it("escapes backslashes before Markdown table delimiters", async () => {
    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "missing",
            title: "Missing",
            kind: "qa-suite-summary",
            artifact: "missing/qa-suite-summary.json",
            required: true,
            missingVerdict: "environment-blocked",
            missingReason: String.raw`path\|fallback unavailable`,
          },
        ],
      },
      artifactRoot: tempRoot,
      generatedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(renderQaConfidenceMarkdownReport(report)).toContain(
      String.raw`path\\\|fallback unavailable`,
    );
  });

  it("fails strict global pass when any lane is blocked, missing, unknown, or classified failed", async () => {
    await writeJson("classified/qa-suite-summary.json", {
      counts: { total: 1, passed: 0, skipped: 0, failed: 1 },
      scenarios: [{ name: "classified", status: "fail" }],
    });
    await writeJson("unknown/qa-suite-summary.json", {
      counts: { total: 1, passed: 0, skipped: 0, failed: 1 },
      scenarios: [{ name: "unknown", status: "fail" }],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "blocked-live",
            title: "Blocked live",
            kind: "qa-suite-summary",
            artifact: "live/qa-suite-summary.json",
            required: true,
            missingVerdict: "environment-blocked",
            missingReason: "OPENAI_API_KEY missing.",
          },
          {
            id: "missing-soak",
            title: "Missing soak",
            kind: "qa-suite-summary",
            artifact: "soak/qa-suite-summary.json",
            required: true,
          },
          {
            id: "classified-fixture",
            title: "Classified fixture",
            kind: "qa-suite-summary",
            artifact: "classified/qa-suite-summary.json",
            required: true,
            failureVerdict: "fixture-bug",
          },
          {
            id: "unknown-failure",
            title: "Unknown failure",
            kind: "qa-suite-summary",
            artifact: "unknown/qa-suite-summary.json",
            required: true,
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      strictGlobalPass: true,
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.zeroUnknowns).toBe(false);
    expect(report.globalPass).toBe(false);
    expect(report.counts).toMatchObject({
      blocked: 1,
      missing: 1,
      failed: 1,
      unknown: 2,
    });
    expect(report.failures).toEqual([
      "blocked-live is blocked: OPENAI_API_KEY missing.",
      "missing-soak is missing: artifact missing and no missingVerdict was configured",
      "classified-fixture is classified fixture-bug: qa-suite-summary counts.failed=1 counts.total=1 counts.skipped=0",
      "unknown-failure is unclassified: qa-suite-summary counts.failed=1 counts.total=1 counts.skipped=0",
    ]);
  });

  it("fails strict global pass for skipped suite rows until a backfill lane passes", async () => {
    const report = await buildStrictSuiteReport({
      counts: { total: 3, passed: 2, skipped: 1, failed: 0 },
    });

    expect(report.zeroUnknowns).toBe(true);
    expect(report.globalPass).toBe(false);
    expect(report.failures).toEqual([
      "report-only has 1 skipped row(s) with no passing backfill lane",
    ]);
  });

  it.each([
    ["count-backed", "skip"],
    ["count-backed", "skipped"],
    ["legacy", "skip"],
    ["legacy", "skipped"],
    ["unverified-pass-count", "skip"],
    ["unverified-pass-count", "skipped"],
  ] as const)(
    "rejects %s suites containing only %s scenarios despite a passing backfill",
    async (format, skippedStatus) => {
      const report = await buildStrictSuiteReport(
        {
          ...(format === "count-backed"
            ? { counts: { total: 1, passed: 0, failed: 0, skipped: 1 } }
            : format === "unverified-pass-count"
              ? { counts: { passed: 1, failed: 0 } }
              : {}),
          scenarios: [{ name: "never executed", status: skippedStatus }],
        },
        true,
      );

      expect(report.pass).toBe(false);
      expect(report.globalPass).toBe(false);
      expect(report.lanes[0]).toMatchObject({ status: "unknown" });
      expect(report.lanes[0]?.details).toContain("no executed scenarios");
      expect(report.lanes[1]).toMatchObject({ status: "pass" });
    },
  );

  it.each([
    ["skip", undefined],
    ["skipped", undefined],
    ["count-reported skip", 1],
  ] as const)(
    "requires a passing backfill for legacy suites containing a pass and %s",
    async (skippedStatus, explicitSkippedCount) => {
      const artifact = {
        ...(explicitSkippedCount === undefined
          ? {}
          : { counts: { skipped: explicitSkippedCount } }),
        scenarios: [
          { name: "executed", status: "pass" },
          ...(explicitSkippedCount === undefined
            ? [{ name: "not executed", status: skippedStatus }]
            : []),
        ],
      };

      for (const hasBackfill of [false, true]) {
        const report = await buildStrictSuiteReport(artifact, hasBackfill);

        expect(report.pass).toBe(hasBackfill);
        expect(report.globalPass).toBe(hasBackfill);
        expect(report.lanes[0]).toMatchObject({ status: "pass", skippedCount: 1 });
        if (hasBackfill) {
          expect(report.lanes[0]).toMatchObject({ skipBackfilled: true });
        } else {
          expect(report.failures).toEqual([
            "report-only has 1 skipped row(s) with no passing backfill lane",
          ]);
        }
      }
    },
  );

  it("distinguishes omitted scenario rows from explicitly empty evidence", async () => {
    for (const [counts, pass, expectedDetail] of [
      [{ total: 1, passed: 1, failed: 0, skipped: 0 }, true, "counts.failed=0"],
      [{ total: 1, passed: 1, failed: 0, skipped: 0 }, false, "count/scenario mismatch"],
      [{ total: 3, passed: 2, failed: 0 }, false, "no executed scenarios"],
    ] as const) {
      const report = await buildStrictSuiteReport({ counts, ...(pass ? {} : { scenarios: [] }) });
      expect(report).toMatchObject({ pass, globalPass: pass });
      expect(report.lanes[0]).toMatchObject({ status: pass ? "pass" : "unknown" });
      expect(report.lanes[0]?.details).toContain(expectedDetail);
    }
  });

  it("infers skipped suite rows from totals and scenario status", async () => {
    for (const [artifact, expectedDetail] of [
      [{ counts: { total: 3, passed: 2, failed: 0 } }, "counts.skipped=1"],
      [
        {
          counts: { total: 2, passed: 2, failed: 0 },
          scenarios: [
            { name: "passing", status: "pass" },
            { name: "skipped", status: "skip" },
          ],
        },
        "counts.skipped=1",
      ],
    ] as const) {
      const report = await buildStrictSuiteReport(artifact);

      expect(report.globalPass).toBe(false);
      expect(report.failures).toEqual([
        "report-only has 1 skipped row(s) with no passing backfill lane",
      ]);
      expect(report.lanes[0]).toMatchObject({ skippedCount: 1 });
      expect(report.lanes[0]?.details).toContain(expectedDetail);
    }
  });

  it("does not pass suite summaries with unsupported non-pass statuses", async () => {
    for (const [artifact, expectedDetail] of [
      [
        {
          counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
          scenarios: [{ name: "errored", status: "error" }],
        },
        "unsupported non-pass status",
      ],
      [
        {
          scenarios: [{ name: "timed out", status: "timeout" }],
        },
        "unsupported non-pass status",
      ],
    ] as const) {
      const report = await buildStrictSuiteReport(artifact);

      expect(report.pass).toBe(false);
      expect(report.globalPass).toBe(false);
      expect(report.zeroUnknowns).toBe(false);
      expect(report.lanes[0]).toMatchObject({
        status: "unknown",
      });
      expect(report.lanes[0]?.details).toContain(expectedDetail);
    }
  });

  it.each([
    ["skipped", "skipped", [], undefined, false, "token summary has no usage rows"],
    ["empty", "estimated", [], undefined, false, "token summary has no usage rows"],
    ["missing", "estimated", undefined, undefined, false, "token summary missing rows"],
    [
      "executed",
      "estimated",
      [{ usageSource: "mock-estimate" }],
      undefined,
      true,
      "summary pass=true",
    ],
    ["live", "skipped", [], "live-usage", false, "token summary has no live-usage rows"],
  ] as const)(
    "evaluates %s token evidence",
    async (_name, status, rows, expectedSource, passed, details) => {
      await writeJson("live-token/qa-runtime-token-efficiency-summary.json", {
        status,
        pass: true,
        ...(rows ? { rows } : {}),
      });

      const report = await buildQaConfidenceReport({
        manifest: {
          version: 1,
          profile: "codex-100",
          lanes: [
            {
              id: "live-token-efficiency",
              title: "Live token efficiency",
              kind: "token-efficiency-summary",
              artifact: "live-token/qa-runtime-token-efficiency-summary.json",
              required: true,
              ...(expectedSource ? { expectedTokenUsageSource: expectedSource } : {}),
            },
          ],
        },
        artifactRoot: tempRoot,
        strictGlobalPass: true,
      });

      expect(report.pass).toBe(passed);
      expect(report.globalPass).toBe(passed);
      expect(report.lanes[0]).toMatchObject({
        status: passed ? "pass" : "unknown",
        details,
      });
    },
  );

  it("preserves partial zero-unknown mode for classified failing lanes", async () => {
    await writeJson("classified/qa-suite-summary.json", {
      counts: { total: 1, passed: 0, skipped: 0, failed: 1 },
      scenarios: [{ name: "classified", status: "fail" }],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "classified-fixture",
            title: "Classified fixture",
            kind: "qa-suite-summary",
            artifact: "classified/qa-suite-summary.json",
            required: true,
            failureVerdict: "fixture-bug",
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.zeroUnknowns).toBe(true);
    expect(report.globalPass).toBe(false);
    expect(report.counts.failed).toBe(1);
  });

  it("passes strict global pass when skipped suite rows are backfilled by a passing lane", async () => {
    const report = await buildStrictSuiteReport(
      { counts: { total: 3, passed: 2, skipped: 1, failed: 0 } },
      true,
    );

    expect(report.pass).toBe(true);
    expect(report.zeroUnknowns).toBe(true);
    expect(report.globalPass).toBe(true);
    expect(report.lanes[0]).toMatchObject({
      skippedCount: 1,
      skipBackfillLane: "backfill",
      skipBackfilled: true,
    });
  });

  it("classifies environment-blocking gateway sentinels without turning them into unknowns", async () => {
    await writeJson("live/qa-suite-summary.json", {
      counts: { total: 1, passed: 1, skipped: 0, failed: 0 },
      gatewayLogSentinels: [
        {
          kind: "live-quota-or-subscription",
          verdict: "environment-blocked",
          owner: "environment",
          productImpact: "P4",
          qaImpact: "P0",
          line: 12,
          text: "OpenAI quota exceeded",
        },
      ],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "first-hour-live",
            title: "First hour live",
            kind: "qa-suite-summary",
            artifact: "live/qa-suite-summary.json",
            required: true,
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.globalPass).toBe(false);
    expect(report.counts).toMatchObject({ blocked: 1, unknown: 0 });
    expect(report.lanes[0]).toMatchObject({
      status: "blocked",
      verdict: "environment-blocked",
    });
  });

  it("does not let environment sentinels hide separate suite failures", async () => {
    await writeJson("live/qa-suite-summary.json", {
      counts: { total: 2, passed: 1, skipped: 0, failed: 1 },
      gatewayLogSentinels: [
        {
          kind: "live-quota-or-subscription",
          verdict: "environment-blocked",
          owner: "environment",
          line: 12,
          text: "OpenAI quota exceeded",
        },
      ],
      scenarios: [
        { name: "quota", status: "pass" },
        { name: "unrelated-drift", status: "fail" },
      ],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "first-hour-live",
            title: "First hour live",
            kind: "qa-suite-summary",
            artifact: "live/qa-suite-summary.json",
            required: true,
            missingVerdict: "environment-blocked",
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.counts).toMatchObject({ blocked: 0, unknown: 1 });
    expect(report.lanes[0]).toMatchObject({ status: "unknown" });
    expect(report.lanes[0]?.details).toContain("suite also reports failures");
  });

  it("classifies product and plugin gateway sentinels as known failing lanes", async () => {
    await writeJson("live/qa-suite-summary.json", {
      counts: { total: 1, passed: 1, skipped: 0, failed: 0 },
      scenarios: [
        {
          name: "plugin hook health sentinel",
          status: "pass",
          steps: [],
          runtimeParity: {
            scenarioId: "plugin-hook-health-sentinel",
            drift: "none",
            cells: {
              openclaw: { status: "pass", sentinelFindings: [] },
              codex: {
                status: "pass",
                sentinelFindings: [
                  {
                    kind: "plugin-hook-failure",
                    verdict: "qa-harness-bug",
                    owner: "plugin",
                    productImpact: "P1",
                    qaImpact: "P0",
                    line: 4,
                    text: "before_prompt_build hook failed",
                  },
                ],
              },
            },
          },
        },
      ],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "first-hour-live",
            title: "First hour live",
            kind: "qa-suite-summary",
            artifact: "live/qa-suite-summary.json",
            required: true,
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.globalPass).toBe(false);
    expect(report.counts).toMatchObject({ failed: 1, unknown: 0 });
    expect(report.lanes[0]).toMatchObject({
      status: "fail",
      verdict: "qa-harness-bug",
    });
  });

  it("treats corrupt artifacts as unknown instead of allowed missing lanes", async () => {
    const artifactPath = path.join(tempRoot, "live", "qa-suite-summary.json");
    await fs.mkdir(path.dirname(artifactPath), { recursive: true });
    await fs.writeFile(artifactPath, "{not-json", "utf8");

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "first-hour-live",
            title: "First hour live",
            kind: "qa-suite-summary",
            artifact: "live/qa-suite-summary.json",
            required: true,
            missingVerdict: "environment-blocked",
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.counts).toMatchObject({ blocked: 0, unknown: 1 });
    expect(report.lanes[0]).toMatchObject({
      status: "unknown",
    });
    expect(report.lanes[0]?.details).toContain("artifact unreadable");
  });

  it("treats schema-invalid suite artifacts as unknown", async () => {
    await writeJson("live/qa-suite-summary.json", {});

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "first-hour-live",
            title: "First hour live",
            kind: "qa-suite-summary",
            artifact: "live/qa-suite-summary.json",
            required: true,
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.counts.unknown).toBe(1);
    expect(report.lanes[0]?.details).toContain("missing counts.failed and scenarios[]");
  });

  it("treats empty suite artifacts as unknown", async () => {
    await writeJson("live/qa-suite-summary.json", {
      counts: { total: 0, passed: 0, skipped: 0, failed: 0 },
      scenarios: [],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "first-hour-live",
            title: "First hour live",
            kind: "qa-suite-summary",
            artifact: "live/qa-suite-summary.json",
            required: true,
            failureVerdict: "qa-harness-bug",
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.counts).toMatchObject({ failed: 0, unknown: 1 });
    expect(report.lanes[0]).toMatchObject({ status: "unknown" });
    expect(report.lanes[0]?.details).toContain("no executed scenarios");
  });

  it("treats suite count and scenario mismatches as unknown", async () => {
    await writeJson("live/qa-suite-summary.json", {
      counts: { total: 2, passed: 2, skipped: 0, failed: 0 },
      scenarios: [
        { name: "passing", status: "pass" },
        { name: "stale-failure", status: "fail" },
      ],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "first-hour-live",
            title: "First hour live",
            kind: "qa-suite-summary",
            artifact: "live/qa-suite-summary.json",
            required: true,
            failureVerdict: "qa-harness-bug",
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.counts).toMatchObject({ failed: 0, unknown: 1 });
    expect(report.lanes[0]).toMatchObject({ status: "unknown" });
    expect(report.lanes[0]?.details).toContain("count/scenario mismatch");
  });

  it("treats impossible suite counts as unknown", async () => {
    for (const [artifact, expectedDetail] of [
      [
        { counts: { total: 1, passed: -1, skipped: 0, failed: 0 } },
        "counts.passed must be a non-negative safe integer",
      ],
      [
        { counts: { total: 1, passed: 2, failed: 0 } },
        "counts.total=1 is less than provided count sum=2",
      ],
      [
        { counts: { total: 1, skipped: 2, failed: 0 } },
        "counts.total=1 is less than provided count sum=2",
      ],
      [
        { counts: { total: 5, passed: 2, skipped: 2, failed: 0 } },
        "counts.total=5 does not match counts.passed+counts.failed+counts.skipped=4",
      ],
    ] as const) {
      await writeJson("live/qa-suite-summary.json", artifact);

      const report = await buildQaConfidenceReport({
        manifest: {
          version: 1,
          profile: "codex-100",
          lanes: [
            {
              id: "first-hour-live",
              title: "First hour live",
              kind: "qa-suite-summary",
              artifact: "live/qa-suite-summary.json",
              required: true,
              failureVerdict: "qa-harness-bug",
            },
          ],
        },
        artifactRoot: tempRoot,
        strictZeroUnknowns: true,
        generatedAt: "2026-05-13T00:00:00.000Z",
      });

      expect(report.pass).toBe(false);
      expect(report.counts).toMatchObject({ failed: 0, unknown: 1 });
      expect(report.lanes[0]).toMatchObject({ status: "unknown" });
      expect(report.lanes[0]?.details).toContain(expectedDetail);
    }
  });

  it("requires generic summary lanes to expose an explicit pass signal", async () => {
    await writeJson("runtime/qa-runtime-parity-summary.json", {});

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "runtime-parity",
            title: "Runtime parity",
            kind: "runtime-parity-summary",
            artifact: "runtime/qa-runtime-parity-summary.json",
            required: true,
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-13T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.counts.unknown).toBe(1);
    expect(report.lanes[0]?.details).toContain("explicit pass signal");
  });

  it("requires JSONL replay summaries to contain replayed user turns", async () => {
    for (const [artifact, expectedDetail] of [
      [{ transcripts: [] }, "no transcripts"],
      [
        { transcripts: [{ transcriptPath: "empty.jsonl", userTurnCount: 0, drift: [] }] },
        "no replayed user turns",
      ],
      [
        { transcripts: [{ transcriptPath: "missing-drift.jsonl", userTurnCount: 1 }] },
        "missing drift array",
      ],
    ] as const) {
      await writeJson("jsonl/qa-jsonl-replay-summary.json", artifact);

      const report = await buildQaConfidenceReport({
        manifest: {
          version: 1,
          profile: "codex-100",
          lanes: [
            {
              id: "jsonl-expanded",
              title: "Expanded JSONL replay",
              kind: "jsonl-replay-summary",
              artifact: "jsonl/qa-jsonl-replay-summary.json",
              required: true,
              failureVerdict: "fixture-bug",
            },
          ],
        },
        artifactRoot: tempRoot,
        strictZeroUnknowns: true,
        generatedAt: "2026-05-13T00:00:00.000Z",
      });

      expect(report.pass).toBe(false);
      expect(report.counts).toMatchObject({ failed: 0, unknown: 1 });
      expect(report.lanes[0]).toMatchObject({ status: "unknown" });
      expect(report.lanes[0]?.details).toContain(expectedDetail);
    }
  });

  it("requires confidence self-test summaries to contain every seeded canary", async () => {
    for (const [artifact, expectedDetail] of [
      [{ pass: true, canaries: [] }, "no canaries"],
      [
        { pass: true, canaries: [{ id: "prompt-drift", detected: true }] },
        "missing expected canaries",
      ],
    ] as const) {
      await writeJson("confidence-self-test/qa-confidence-self-test-summary.json", artifact);

      const report = await buildQaConfidenceReport({
        manifest: {
          version: 1,
          profile: "codex-100",
          lanes: [
            {
              id: "confidence-self-test",
              title: "Confidence self-test",
              kind: "self-test-summary",
              artifact: "confidence-self-test/qa-confidence-self-test-summary.json",
              required: true,
              failureVerdict: "qa-harness-bug",
            },
          ],
        },
        artifactRoot: tempRoot,
        strictZeroUnknowns: true,
        generatedAt: "2026-05-13T00:00:00.000Z",
      });

      expect(report.pass).toBe(false);
      expect(report.counts).toMatchObject({ failed: 0, unknown: 1 });
      expect(report.lanes[0]).toMatchObject({ status: "unknown" });
      expect(report.lanes[0]?.details).toContain(expectedDetail);
    }
  });

  it("fails strict zero-unknowns for an unclassified failing lane", async () => {
    await writeJson("first-hour/qa-suite-summary.json", {
      counts: { total: 18, passed: 17, failed: 1 },
      scenarios: [{ name: "approval-turn-tool-followthrough", status: "fail", steps: [] }],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "first-hour-20-direct",
            title: "First-hour 20 direct",
            kind: "qa-suite-summary",
            artifact: "first-hour/qa-suite-summary.json",
            required: true,
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.counts.unknown).toBe(1);
    expect(report.failures[0]).toContain("first-hour-20-direct is unclassified");
  });

  it("accepts a classified failing lane without treating it as unknown", async () => {
    await writeJson("jsonl/qa-jsonl-replay-summary.json", {
      transcripts: [
        {
          transcriptPath: "curated.jsonl",
          userTurnCount: 2,
          drift: ["none", "tool-result-shape"],
          firstDriftAtTurn: 2,
        },
      ],
    });

    const report = await buildQaConfidenceReport({
      manifest: {
        version: 1,
        profile: "codex-100",
        lanes: [
          {
            id: "jsonl-expanded",
            title: "Expanded JSONL replay",
            kind: "jsonl-replay-summary",
            artifact: "jsonl/qa-jsonl-replay-summary.json",
            required: true,
            failureVerdict: "fixture-bug",
            productImpact: "P4",
            qaImpact: "P1",
          },
        ],
      },
      artifactRoot: tempRoot,
      strictZeroUnknowns: true,
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.globalPass).toBe(false);
    expect(report.counts.failed).toBe(1);
    expect(report.counts.unknown).toBe(0);
    expect(report.lanes[0]).toMatchObject({
      status: "fail",
      verdict: "fixture-bug",
      productImpact: "P4",
      qaImpact: "P1",
    });
  });

  it("emits confidence self-test canaries for every drift class we need to catch", async () => {
    const { summary } = await writeQaConfidenceSelfTestArtifacts({
      outputDir: tempRoot,
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    expect(summary.pass).toBe(true);
    expect(summary.canaries.map((canary) => canary.id)).toEqual([
      "prompt-drift",
      "tool-description-schema-drift",
      "runtime-tool-call-drop",
      "tool-result-mismatch",
      "failure-mode-drift",
      "token-efficiency-regression",
      "jsonl-replay-ordering-drift",
    ]);
    expect(summary.canaries.every((canary) => canary.detected)).toBe(true);
  });

  it("writes confidence self-test artifacts", async () => {
    const result = await writeQaConfidenceSelfTestArtifacts({
      outputDir: tempRoot,
      generatedAt: "2026-05-12T00:00:00.000Z",
    });

    await expect(fs.stat(result.summaryPath)).resolves.toBeTruthy();
    await expect(fs.stat(result.reportPath)).resolves.toBeTruthy();
    const summary = JSON.parse(await fs.readFile(result.summaryPath, "utf8")) as { pass: boolean };
    expect(summary.pass).toBe(true);
  });
});
