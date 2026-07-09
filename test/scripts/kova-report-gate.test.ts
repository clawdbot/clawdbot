// Kova report gate tests use trimmed values from a real deep-profile release report.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateToleratedKovaReport,
  evaluateToleratedPartialKovaReport,
  evaluateToleratedProfiledKovaReport,
} from "../../scripts/lib/kova-report-gate.mjs";

type JsonObject = Record<string, unknown>;
type PathPart = number | string;
type ReportMutation = [string, (report: JsonObject) => void];

const tempRoots: string[] = [];
const malformedViolationLists: Array<[string, unknown]> = [
  ["null", null],
  ["object", {}],
  ["string", "none"],
];
const SCRIPT_PATH = "scripts/lib/kova-report-gate.mjs";
const SCENARIO = "agent-cold-warm-message";
const STATE = "mock-openai-provider";
const SURFACE = "agent-cli-local-turn";
const PROFILED_INTERPRETATION =
  "instrumented run; CPU/RSS can include profiler and diagnostic overhead";

function objectAt(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected object fixture value");
  }
  return value as JsonObject;
}

function arrayAt(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError("expected array fixture value");
  }
  return value;
}

function valueAt(root: unknown, path: PathPart[]): unknown {
  let current = root;
  for (const part of path) {
    current = typeof part === "number" ? arrayAt(current)[part] : objectAt(current)[part];
  }
  return current;
}

function setAt(root: unknown, path: PathPart[], value: unknown): void {
  const parent = valueAt(root, path.slice(0, -1));
  const key = path.at(-1);
  if (typeof key === "number") {
    arrayAt(parent)[key] = value;
  } else if (typeof key === "string") {
    objectAt(parent)[key] = value;
  } else {
    throw new TypeError("empty fixture path");
  }
}

function deleteAt(root: unknown, path: PathPart[]): void {
  const parent = valueAt(root, path.slice(0, -1));
  const key = path.at(-1);
  if (typeof key !== "string") {
    throw new TypeError("delete fixture path must end in a string");
  }
  delete objectAt(parent)[key];
}

function metric(value: number) {
  return {
    classification: "stable",
    count: 1,
    max: value,
    median: value,
    min: value,
    p95: value,
    samples: [value],
  };
}

function commandResult() {
  return {
    command: "ocm @env -- openclaw agent --local",
    status: 0,
    stderr: "",
    stdout: "",
    timedOut: false,
  };
}

function cleanupResult() {
  return {
    command: "ocm env destroy env --json",
    status: 0,
    stderr: "",
    stdout: "",
    timedOut: false,
  };
}

function targetCleanup() {
  return {
    command: "ocm runtime remove runtime --json",
    result: cleanupResult(),
    runtimeName: "runtime",
    status: "removed",
  };
}

function normalProfiling() {
  return {
    affectsResourceMeasurements: false,
    baselineEligible: true,
    deepProfile: false,
    diagnosticReport: false,
    enabled: false,
    heapSnapshot: false,
    interpretation: "normal user-path resource measurements",
    nodeProfile: false,
    profileOnFailure: false,
    schemaVersion: "kova.profiling.v1",
  };
}

function deepProfiling() {
  return {
    affectsResourceMeasurements: true,
    baselineEligible: false,
    deepProfile: true,
    diagnosticReport: true,
    enabled: true,
    heapSnapshot: true,
    interpretation: PROFILED_INTERPRETATION,
    nodeProfile: true,
    profileOnFailure: false,
    schemaVersion: "kova.profiling.v1",
  };
}

function infoCard() {
  return {
    kind: "filtered-required-scenario",
    scenario: "fresh-install",
    severity: "info",
    state: "fresh",
    status: "MISSING",
  };
}

function partialReport(): JsonObject {
  return {
    baseline: null,
    controls: {
      exclude: [],
      gate: true,
      include: [`scenario:${SCENARIO}`],
      repeat: 1,
    },
    gate: {
      baseline: null,
      blockingCount: 0,
      cards: [infoCard()],
      complete: false,
      enabled: true,
      infoCount: 1,
      missingRequiredCount: 1,
      ok: false,
      partial: true,
      schemaVersion: "kova.gate.v1",
      verdict: "PARTIAL",
      warningCount: 0,
    },
    mode: "execution",
    performance: {
      groupCount: 1,
      groups: [
        {
          key: `${SCENARIO}|${SURFACE}|${STATE}`,
          metrics: {
            cpuPercentMax: metric(80),
            peakRssMb: metric(650),
          },
          profiledRunCount: 0,
          resourceInterpretation: "normal",
          sampleCount: 1,
          scenario: SCENARIO,
          state: STATE,
          statuses: { PASS: 1 },
          surface: SURFACE,
        },
      ],
      profiledRunCount: 0,
      repeat: 1,
      schemaVersion: "kova.performance.v1",
      unstableGroupCount: 0,
    },
    records: [
      {
        cleanup: "destroyed",
        cleanupResult: cleanupResult(),
        measurements: {
          cpuPercentMax: 80,
          peakRssMb: 650,
        },
        phases: [{ id: "agent-turn", results: [commandResult()] }],
        profiling: normalProfiling(),
        scenario: SCENARIO,
        state: { id: STATE },
        status: "PASS",
        surface: SURFACE,
      },
    ],
    schemaVersion: "kova.report.v1",
    summary: { statuses: { PASS: 1 }, total: 1 },
    target: "local-build:/workspace/openclaw",
    targetCleanup: targetCleanup(),
  };
}

function profiledResourceReport(): JsonObject {
  const violationMessages = [
    "peak RSS 923.7 MB exceeded threshold 900 MB",
    "agent-process peak RSS 923.7 MB exceeded threshold 900 MB",
  ];
  return {
    baseline: null,
    controls: {
      exclude: [],
      gate: true,
      include: [`scenario:${SCENARIO}`],
      repeat: 1,
    },
    gate: {
      baseline: null,
      blockingCount: 1,
      cards: [
        infoCard(),
        {
          failedCommand: null,
          kind: "openclaw-failure",
          measurements: { cpuPercentMax: 156.2, peakRssMb: 923.7 },
          scenario: SCENARIO,
          severity: "blocking",
          state: STATE,
          status: "FAIL",
          summary: violationMessages[0],
          violations: violationMessages,
        },
      ],
      complete: false,
      enabled: true,
      infoCount: 1,
      missingRequiredCount: 1,
      ok: false,
      partial: true,
      schemaVersion: "kova.gate.v1",
      verdict: "DO_NOT_SHIP",
      warningCount: 0,
    },
    mode: "execution",
    performance: {
      groupCount: 1,
      groups: [
        {
          key: `${SCENARIO}|${SURFACE}|${STATE}`,
          metrics: {
            cpuPercentMax: metric(156.2),
            peakRssMb: metric(923.7),
          },
          profiledRunCount: 1,
          resourceInterpretation: "instrumented",
          sampleCount: 1,
          scenario: SCENARIO,
          state: STATE,
          statuses: { FAIL: 1 },
          surface: SURFACE,
        },
      ],
      profiledRunCount: 1,
      repeat: 1,
      schemaVersion: "kova.performance.v1",
      unstableGroupCount: 0,
    },
    records: [
      {
        cleanup: "destroyed",
        cleanupResult: cleanupResult(),
        measurements: {
          cpuPercentMax: 156.2,
          peakRssMb: 923.7,
          profilingAffectsResourceMeasurements: true,
          profilingBaselineEligible: false,
          profilingEnabled: true,
          profilingResourceInterpretation: PROFILED_INTERPRETATION,
          resourceByRole: {
            "agent-process": { maxCpuPercent: 156.2, peakRssMb: 923.7 },
          },
        },
        phases: [{ id: "agent-turn", results: [commandResult()] }],
        profiling: deepProfiling(),
        scenario: SCENARIO,
        state: { id: STATE },
        status: "FAIL",
        surface: SURFACE,
        violations: [
          {
            actual: 923.7,
            expected: "<= 900",
            kind: "threshold",
            message: violationMessages[0],
            metric: "peakRssMb",
          },
          {
            actual: 923.7,
            expected: "<= 900",
            kind: "resource",
            message: violationMessages[1],
            metric: "resourceByRole.agent-process.peakRssMb",
            role: "agent-process",
          },
        ],
      },
    ],
    schemaVersion: "kova.report.v1",
    summary: { statuses: { FAIL: 1 }, total: 1 },
    target: "local-build:/workspace/openclaw",
    targetCleanup: targetCleanup(),
  };
}

function attachPassingBaseline(report: JsonObject): void {
  report.baseline = {
    comparison: {
      baselineEntryCount: 1,
      generatedAt: "2026-07-09T00:00:00.000Z",
      groups: [],
      missing: [],
      missingBaselineCount: 0,
      ok: true,
      regressionCount: 0,
      regressions: [],
      schemaVersion: "kova.baselineComparison.v1",
    },
    path: "/tmp/baseline.json",
  };
  objectAt(report.gate).baseline = {
    baselineEntryCount: 1,
    missing: [],
    missingBaselineCount: 0,
    ok: true,
    regressedGroups: [],
    regressionCount: 0,
    schemaVersion: "kova.gateBaselineSummary.v1",
  };
}

function blockingCard(report: JsonObject): JsonObject {
  const cards = arrayAt(objectAt(report.gate).cards);
  const card = cards.find((candidate) => objectAt(candidate).severity === "blocking");
  return objectAt(card);
}

function addProfiledPassRecord(report: JsonObject): JsonObject {
  const scenario = "passing-agent-message";
  const records = arrayAt(report.records);
  const passRecord = objectAt(structuredClone(records[0]));
  passRecord.scenario = scenario;
  passRecord.status = "PASS";
  delete passRecord.violations;
  records.push(passRecord);

  const performance = objectAt(report.performance);
  const groups = arrayAt(performance.groups);
  const passGroup = objectAt(structuredClone(groups[0]));
  passGroup.key = `${scenario}|${SURFACE}|${STATE}`;
  passGroup.scenario = scenario;
  passGroup.statuses = { PASS: 1 };
  groups.push(passGroup);
  performance.groupCount = 2;
  performance.profiledRunCount = 2;
  report.summary = { statuses: { FAIL: 1, PASS: 1 }, total: 2 };
  return passRecord;
}

function writeReport(report: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "openclaw-kova-report-"));
  tempRoots.push(root);
  const reportPath = join(root, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(report)}\n`);
  return reportPath;
}

function expectProfiledRejection(report: JsonObject): void {
  expect(evaluateToleratedProfiledKovaReport(report).ok).toBe(false);
}

function expectPartialRejection(report: JsonObject): void {
  expect(evaluateToleratedPartialKovaReport(report).ok).toBe(false);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("scripts/lib/kova-report-gate.mjs", () => {
  it("accepts omitted violations on a filtered PARTIAL PASS record", () => {
    expect(evaluateToleratedPartialKovaReport(partialReport())).toEqual({ ok: true });
    expect(evaluateToleratedKovaReport(partialReport())).toEqual({
      classification: "filtered-partial",
      ok: true,
    });
  });

  it("accepts an exact deep-profile resource-only rejection", () => {
    expect(evaluateToleratedProfiledKovaReport(profiledResourceReport())).toEqual({
      ok: true,
    });
    expect(evaluateToleratedKovaReport(profiledResourceReport())).toEqual({
      classification: "profiled-resource-only",
      ok: true,
    });
  });

  it("accepts independently matching non-regressing baseline evidence", () => {
    const partial = partialReport();
    const profiled = profiledResourceReport();
    attachPassingBaseline(partial);
    attachPassingBaseline(profiled);

    expect(evaluateToleratedPartialKovaReport(partial)).toEqual({ ok: true });
    expect(evaluateToleratedProfiledKovaReport(profiled)).toEqual({ ok: true });
  });

  it("accepts proven already-absent cleanup results", () => {
    const report = partialReport();
    const record = objectAt(valueAt(report, ["records", 0]));
    record.cleanup = "already-absent";
    record.cleanupResult = {
      ...cleanupResult(),
      status: 1,
      stderr: "environment not found",
    };
    const cleanup = objectAt(report.targetCleanup);
    cleanup.status = "already-absent";
    cleanup.result = {
      ...cleanupResult(),
      status: 1,
      stderr: "runtime does not exist",
    };

    expect(evaluateToleratedPartialKovaReport(report)).toEqual({ ok: true });
  });

  it("accepts profiled RSS growth emitted as a soak violation", () => {
    const report = profiledResourceReport();
    const message = "resource-sampled RSS grew by 42 MB, over threshold 40 MB";
    setAt(report, ["records", 0, "measurements", "rssGrowthMb"], 42);
    setAt(
      report,
      ["records", 0, "violations"],
      [
        {
          actual: 42,
          expected: "<= 40",
          kind: "soak",
          message,
          metric: "rssGrowthMb",
        },
      ],
    );
    blockingCard(report).summary = message;
    blockingCard(report).violations = [message];

    expect(evaluateToleratedProfiledKovaReport(report)).toEqual({ ok: true });
  });

  it("accepts omitted violations on a profiled PASS record", () => {
    const report = profiledResourceReport();
    addProfiledPassRecord(report);

    expect(evaluateToleratedProfiledKovaReport(report)).toEqual({ ok: true });
  });

  it.each(malformedViolationLists)(
    "rejects present non-array %s violations on a PARTIAL PASS record",
    (_label, violations) => {
      const report = partialReport();
      setAt(report, ["records", 0, "violations"], violations);

      expectPartialRejection(report);
    },
  );

  it.each(malformedViolationLists)(
    "rejects present non-array %s violations on a profiled PASS record",
    (_label, violations) => {
      const report = profiledResourceReport();
      const passRecord = addProfiledPassRecord(report);
      passRecord.violations = violations;

      expectProfiledRejection(report);
    },
  );

  it("rejects hidden violations on PASS records", () => {
    const report = profiledResourceReport();
    const passRecord = addProfiledPassRecord(report);
    passRecord.violations = [{ message: "hidden violation" }];

    expectProfiledRejection(report);
  });

  const profiledMutations: ReportMutation[] = [
    [
      "rejects the wrong report schema",
      (report) => setAt(report, ["schemaVersion"], "kova.report.v2"),
    ],
    ["rejects dry-run reports", (report) => setAt(report, ["mode"], "dry-run")],
    [
      "rejects the wrong gate schema",
      (report) => setAt(report, ["gate", "schemaVersion"], "kova.gate.v2"),
    ],
    ["rejects disabled gate controls", (report) => setAt(report, ["controls", "gate"], false)],
    ["rejects unfiltered reports", (report) => setAt(report, ["controls", "include"], [])],
    ["rejects malformed extra filters", (report) => setAt(report, ["controls", "exclude"], [" "])],
    ["rejects non-partial gate metadata", (report) => setAt(report, ["gate", "partial"], false)],
    ["rejects complete gate metadata", (report) => setAt(report, ["gate", "complete"], true)],
    ["rejects ok gate metadata", (report) => setAt(report, ["gate", "ok"], true)],
    ["rejects fractional gate counts", (report) => setAt(report, ["gate", "blockingCount"], 1.5)],
    [
      "rejects noncanonical deep profiling",
      (report) => setAt(report, ["records", 0, "profiling", "deepProfile"], false),
    ],
    [
      "rejects inconsistent derived profiling flags",
      (report) => setAt(report, ["records", 0, "measurements", "profilingEnabled"], false),
    ],
    [
      "rejects failed phase commands",
      (report) => setAt(report, ["records", 0, "phases", 0, "results", 0, "status"], 1),
    ],
    [
      "rejects timed-out phase commands",
      (report) => setAt(report, ["records", 0, "phases", 0, "results", 0, "timedOut"], true),
    ],
    [
      "rejects retained record cleanup",
      (report) => setAt(report, ["records", 0, "cleanup"], "retained"),
    ],
    [
      "rejects failed record cleanup",
      (report) => setAt(report, ["records", 0, "cleanupResult", "status"], 1),
    ],
    [
      "rejects generic command-not-found record cleanup",
      (report) => {
        setAt(report, ["records", 0, "cleanup"], "already-absent");
        setAt(report, ["records", 0, "cleanupResult", "status"], 1);
        setAt(report, ["records", 0, "cleanupResult", "stderr"], "ocm: command not found");
      },
    ],
    [
      "rejects failed target cleanup",
      (report) => setAt(report, ["targetCleanup", "status"], "remove-failed"),
    ],
    [
      "rejects timed-out target cleanup",
      (report) => setAt(report, ["targetCleanup", "result", "timedOut"], true),
    ],
    [
      "rejects failed target removal",
      (report) => setAt(report, ["targetCleanup", "result", "status"], 1),
    ],
    [
      "rejects generic command-not-found target cleanup",
      (report) => {
        setAt(report, ["targetCleanup", "status"], "already-absent");
        setAt(report, ["targetCleanup", "result", "status"], 1);
        setAt(report, ["targetCleanup", "result", "stderr"], "ocm: command not found");
      },
    ],
    ["rejects fractional summary totals", (report) => setAt(report, ["summary", "total"], 1.5)],
    [
      "rejects summary totals that disagree with records",
      (report) => setAt(report, ["summary", "total"], 2),
    ],
    [
      "rejects status counts that disagree with records",
      (report) => setAt(report, ["summary", "statuses", "FAIL"], 2),
    ],
    ["rejects empty scenarios", (report) => setAt(report, ["records", 0, "scenario"], "")],
    [
      "rejects whitespace-only scenarios",
      (report) => setAt(report, ["records", 0, "scenario"], " "),
    ],
    ["rejects empty state ids", (report) => setAt(report, ["records", 0, "state", "id"], "")],
    [
      "rejects wrong performance schemas",
      (report) => setAt(report, ["performance", "schemaVersion"], "kova.performance.v2"),
    ],
    [
      "rejects wrong performance group counts",
      (report) => setAt(report, ["performance", "groupCount"], 2),
    ],
    [
      "rejects wrong performance group keys",
      (report) => setAt(report, ["performance", "groups", 0, "key"], "wrong"),
    ],
    [
      "rejects unstable group count drift",
      (report) => setAt(report, ["performance", "unstableGroupCount"], 1),
    ],
    [
      "rejects fractional sample counts",
      (report) => setAt(report, ["performance", "groups", 0, "sampleCount"], 1.5),
    ],
    [
      "rejects group statuses that disagree with records",
      (report) => setAt(report, ["performance", "groups", 0, "statuses", "FAIL"], 2),
    ],
    [
      "rejects group profile counts that disagree with records",
      (report) => setAt(report, ["performance", "groups", 0, "profiledRunCount"], 0),
    ],
    [
      "rejects metric counts without exact samples",
      (report) => setAt(report, ["performance", "groups", 0, "metrics", "peakRssMb", "count"], 2),
    ],
    [
      "rejects metric counts above the group sample count",
      (report) => {
        setAt(report, ["performance", "groups", 0, "metrics", "peakRssMb", "count"], 2);
        setAt(
          report,
          ["performance", "groups", 0, "metrics", "peakRssMb", "samples"],
          [923.7, 923.7],
        );
      },
    ],
    [
      "rejects invalid metric classifications",
      (report) =>
        setAt(
          report,
          ["performance", "groups", 0, "metrics", "peakRssMb", "classification"],
          "unknown",
        ),
    ],
    [
      "rejects violations not bound to direct measurements",
      (report) => setAt(report, ["records", 0, "violations", 0, "actual"], 900),
    ],
    [
      "rejects failed records with omitted violations",
      (report) => deleteAt(report, ["records", 0, "violations"]),
    ],
    [
      "rejects failed records with an empty violations list",
      (report) => setAt(report, ["records", 0, "violations"], []),
    ],
    [
      "rejects violations without expectations",
      (report) => setAt(report, ["records", 0, "violations", 0, "expected"], ""),
    ],
    [
      "rejects whitespace-only violation expectations",
      (report) => setAt(report, ["records", 0, "violations", 0, "expected"], " "),
    ],
    [
      "rejects role names that disagree with role metrics",
      (report) => setAt(report, ["records", 0, "violations", 1, "role"], "gateway"),
    ],
    [
      "rejects missing role measurements",
      (report) =>
        deleteAt(report, [
          "records",
          0,
          "measurements",
          "resourceByRole",
          "agent-process",
          "peakRssMb",
        ]),
    ],
    [
      "rejects non-resource profiling violations",
      (report) => setAt(report, ["records", 0, "violations", 0, "metric"], "agentTurnMs"),
    ],
    [
      "rejects missing RSS samples in the matching group",
      (report) => deleteAt(report, ["performance", "groups", 0, "metrics", "peakRssMb"]),
    ],
    [
      "rejects missing CPU samples in the matching group",
      (report) => deleteAt(report, ["performance", "groups", 0, "metrics", "cpuPercentMax"]),
    ],
    [
      "rejects blocking cards with failed commands",
      (report) => (blockingCard(report).failedCommand = "openclaw agent"),
    ],
    [
      "rejects blocking cards with rewritten violation messages",
      (report) => (blockingCard(report).violations = ["different message"]),
    ],
    [
      "rejects blocking cards with mismatched measurements",
      (report) => setAt(blockingCard(report), ["measurements", "peakRssMb"], 900),
    ],
    [
      "rejects blocking cards mapped to another state",
      (report) => (blockingCard(report).state = "other-state"),
    ],
    [
      "rejects duplicate blocking cards",
      (report) => {
        const cards = arrayAt(objectAt(report.gate).cards);
        cards.push(structuredClone(blockingCard(report)));
        setAt(report, ["gate", "blockingCount"], 2);
      },
    ],
    [
      "rejects gate cards with inherited-property severities",
      (report) => {
        const cards = arrayAt(objectAt(report.gate).cards);
        cards.push({ ...infoCard(), severity: "toString" });
      },
    ],
    [
      "rejects unexpected info gate cards",
      (report) => {
        const cards = arrayAt(objectAt(report.gate).cards);
        cards.push({ ...infoCard(), kind: "openclaw-failure", status: "FAIL" });
        setAt(report, ["gate", "infoCount"], 2);
        setAt(report, ["gate", "missingRequiredCount"], 2);
      },
    ],
    [
      "rejects unexpected warning gate cards",
      (report) => {
        const cards = arrayAt(objectAt(report.gate).cards);
        cards.push({
          ...infoCard(),
          kind: "openclaw-failure",
          severity: "warning",
          status: "FAIL",
        });
        setAt(report, ["gate", "warningCount"], 1);
      },
    ],
    [
      "rejects duplicate performance groups",
      (report) => {
        const groups = arrayAt(objectAt(report.performance).groups);
        groups.push(structuredClone(groups[0]));
        setAt(report, ["performance", "groupCount"], 2);
      },
    ],
    [
      "rejects report baseline regressions even when gate baseline is clean",
      (report) => {
        attachPassingBaseline(report);
        setAt(report, ["baseline", "comparison", "regressionCount"], 1);
        setAt(report, ["baseline", "comparison", "regressions"], [{}]);
      },
    ],
    [
      "rejects gate baseline regressions even when report baseline is clean",
      (report) => {
        attachPassingBaseline(report);
        setAt(report, ["gate", "baseline", "regressionCount"], 1);
        setAt(report, ["gate", "baseline", "regressedGroups"], [{}]);
      },
    ],
    [
      "rejects one-sided baseline evidence",
      (report) => {
        attachPassingBaseline(report);
        setAt(report, ["gate", "baseline"], null);
      },
    ],
  ];

  for (const [name, mutate] of profiledMutations) {
    it(name, () => {
      const report = profiledResourceReport();
      mutate(report);
      expectProfiledRejection(report);
    });
  }

  const partialMutations: ReportMutation[] = [
    [
      "rejects PARTIAL gates without partial metadata",
      (report) => setAt(report, ["gate", "partial"], false),
    ],
    [
      "rejects PARTIAL gates marked complete",
      (report) => setAt(report, ["gate", "complete"], true),
    ],
    ["rejects PARTIAL gates marked ok", (report) => setAt(report, ["gate", "ok"], true)],
    [
      "rejects PARTIAL gates without filters",
      (report) => setAt(report, ["controls", "include"], []),
    ],
    [
      "rejects PARTIAL gates with blocking cards",
      (report) => {
        setAt(report, ["gate", "cards", 0, "severity"], "blocking");
        setAt(report, ["gate", "blockingCount"], 1);
        setAt(report, ["gate", "infoCount"], 0);
      },
    ],
    [
      "rejects non-PASS PARTIAL records even with reconciled summaries",
      (report) => {
        setAt(report, ["records", 0, "status"], "FAIL");
        setAt(report, ["summary", "statuses"], { FAIL: 1 });
        setAt(report, ["performance", "groups", 0, "statuses"], { FAIL: 1 });
      },
    ],
    [
      "rejects PARTIAL status summary drift",
      (report) => setAt(report, ["summary", "statuses", "PASS"], 2),
    ],
    [
      "rejects PARTIAL phase failures",
      (report) => setAt(report, ["records", 0, "phases", 0, "results", 0, "status"], 1),
    ],
    [
      "rejects PARTIAL cleanup failures",
      (report) => setAt(report, ["records", 0, "cleanup"], "destroy-failed"),
    ],
    [
      "rejects PARTIAL target cleanup failures",
      (report) => setAt(report, ["targetCleanup", "status"], "planned"),
    ],
    [
      "rejects PARTIAL group count drift",
      (report) => setAt(report, ["performance", "groupCount"], 0),
    ],
    [
      "rejects PARTIAL fractional metric counts",
      (report) => setAt(report, ["performance", "groups", 0, "metrics", "peakRssMb", "count"], 0.5),
    ],
    [
      "rejects PARTIAL records with violations",
      (report) => setAt(report, ["records", 0, "violations"], [{}]),
    ],
    [
      "rejects PARTIAL records with null violations",
      (report) => setAt(report, ["records", 0, "violations"], null),
    ],
    [
      "rejects PARTIAL reports without sampled RSS",
      (report) => deleteAt(report, ["performance", "groups", 0, "metrics", "peakRssMb"]),
    ],
    [
      "rejects PARTIAL reports without sampled CPU",
      (report) => deleteAt(report, ["performance", "groups", 0, "metrics", "cpuPercentMax"]),
    ],
    [
      "rejects PARTIAL one-sided baselines",
      (report) => {
        attachPassingBaseline(report);
        setAt(report, ["gate", "baseline"], null);
      },
    ],
  ];

  for (const [name, mutate] of partialMutations) {
    it(name, () => {
      const report = partialReport();
      mutate(report);
      expectPartialRejection(report);
    });
  }

  it("exits zero for profiling-only resource failures", () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, writeReport(profiledResourceReport())],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("profiled-resource-only");
  });

  it("exits non-zero for malformed tolerated-report candidates", () => {
    const report = partialReport();
    setAt(report, ["summary", "total"], 2);
    const result = spawnSync(process.execPath, [SCRIPT_PATH, writeReport(report)], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Kova verdict is not tolerable");
  });

  it("runs the CLI guard from paths that need file URL escaping", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-kova report-"));
    tempRoots.push(root);
    const scriptDir = join(root, "script dir");
    mkdirSync(scriptDir);
    const scriptPath = join(scriptDir, "kova-report-gate.mjs");
    copyFileSync(SCRIPT_PATH, scriptPath);
    const report = partialReport();
    setAt(report, ["summary", "total"], 2);

    const result = spawnSync(process.execPath, [scriptPath, writeReport(report)], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Kova verdict is not tolerable");
  });
});
