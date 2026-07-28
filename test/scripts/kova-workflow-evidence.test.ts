import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateKovaWorkflowEvidence } from "../../scripts/lib/kova-workflow-evidence.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

type JsonObject = Record<string, unknown>;
type Pair = {
  scenario: string;
  state: string;
};

const PROFILE = "release";
const TARGET = "local-build:/work/openclaw";
const MODEL = "gpt-5.6";
const INCLUDE_FILTERS = ["scenario:scenario-a", "scenario:scenario-b"];
const FIRST_PAIR: Pair = { scenario: "scenario-a", state: "state-a" };
const PAIRS: Pair[] = [FIRST_PAIR, { scenario: "scenario-b", state: "state-b" }];
const SCRIPT_PATH = "scripts/lib/kova-workflow-evidence.mjs";
const tempRoots = useAutoCleanupTempDirTracker(afterEach);

function plan(
  pairs: Pair[] = PAIRS,
  repeat = 2,
  includeFilters: string[] = INCLUDE_FILTERS,
): JsonObject {
  return {
    schemaVersion: "kova.matrix.plan.v1",
    profile: { id: PROFILE },
    target: TARGET,
    controls: {
      include: includeFilters,
      repeat,
    },
    entries: pairs.map((pair) => ({
      scenario: { id: pair.scenario },
      state: { id: pair.state },
      status: "SELECTED",
    })),
  };
}

function record(pair: Pair, repeatIndex: number, repeat: number, authMode: "live" | "mock") {
  return {
    scenario: pair.scenario,
    state: { id: pair.state },
    status: "PASS",
    repeat: {
      index: repeatIndex,
      total: repeat,
    },
    auth: {
      mode: authMode,
      environmentDependent: authMode === "live",
    },
    providerEvidence:
      authMode === "live"
        ? {
            authMode: "live",
            available: true,
            environmentDependent: true,
            requestCount: 1,
            models: [{ value: MODEL, count: 1 }],
            source: "openclaw-timeline",
          }
        : {
            authMode: "mock",
            available: true,
            environmentDependent: false,
            requestCount: 1,
            source: "mock-provider-log",
          },
  };
}

function report({
  authMode = "mock",
  includeFilters = INCLUDE_FILTERS,
  pairs = PAIRS,
  repeat = 2,
}: {
  authMode?: "live" | "mock";
  includeFilters?: string[];
  pairs?: Pair[];
  repeat?: number;
} = {}): JsonObject {
  return {
    schemaVersion: "kova.report.v1",
    mode: "execution",
    profile: { id: PROFILE },
    target: TARGET,
    controls: {
      include: includeFilters,
      repeat,
    },
    auth: {
      requestedMode: authMode,
      live: {
        environmentDependent: authMode === "live",
      },
    },
    records: pairs.flatMap((pair) =>
      Array.from({ length: repeat }, (_, index) => record(pair, index + 1, repeat, authMode)),
    ),
  };
}

function validate(
  lanePlan: JsonObject,
  laneReport: JsonObject,
  options: {
    authMode?: "live" | "mock";
    expectedModel?: string;
    includeFilters?: string[];
    repeat?: number;
  } = {},
) {
  return validateKovaWorkflowEvidence({
    plan: lanePlan,
    report: laneReport,
    profile: PROFILE,
    target: TARGET,
    repeat: options.repeat ?? 2,
    includeFilters: options.includeFilters ?? INCLUDE_FILTERS,
    authMode: options.authMode ?? "mock",
    expectedModel: options.expectedModel ?? MODEL,
  });
}

function recordsOf(laneReport: JsonObject): JsonObject[] {
  return laneReport.records as JsonObject[];
}

function firstRecordOf(laneReport: JsonObject): JsonObject {
  const first = recordsOf(laneReport)[0];
  if (!first) {
    throw new Error("fixture report has no records");
  }
  return first;
}

function runCli({
  lanePlan = JSON.stringify(plan()),
  laneReport = JSON.stringify(report()),
  repeat = "2",
  includeAuth = true,
}: {
  lanePlan?: string;
  laneReport?: string;
  repeat?: string;
  includeAuth?: boolean;
} = {}) {
  const root = tempRoots.make("openclaw-kova-evidence-");
  const planPath = join(root, "plan.json");
  const reportPath = join(root, "report.json");
  writeFileSync(planPath, lanePlan);
  writeFileSync(reportPath, laneReport);
  const args = [
    SCRIPT_PATH,
    "--plan",
    planPath,
    "--report",
    reportPath,
    "--profile",
    PROFILE,
    "--target",
    TARGET,
    "--repeat",
    repeat,
    "--include",
    INCLUDE_FILTERS.join(","),
    "--model",
    MODEL,
  ];
  if (includeAuth) {
    args.push("--auth", "mock");
  }
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("Kova workflow evidence", () => {
  it("accepts exact selected-pair coverage for every repeat", () => {
    expect(validate(plan(), report())).toEqual({
      authMode: "mock",
      pairCount: 2,
      recordCount: 4,
      repeat: 2,
    });
  });

  it("rejects collapsed repeat coverage", () => {
    const laneReport = report();
    recordsOf(laneReport).pop();

    expect(() => validate(plan(), laneReport)).toThrow(
      "lane report collapsed scenario-b/state-b coverage to 1/2 repeats",
    );
  });

  it("rejects report pairs outside the selected plan", () => {
    const laneReport = report();
    const firstRecord = firstRecordOf(laneReport);
    firstRecord.scenario = "scenario-extra";

    expect(() => validate(plan(), laneReport)).toThrow(
      "lane report contained unexpected scenario-extra/state-a",
    );
  });

  it("rejects live records backed by mock-provider evidence", () => {
    const liveFilters = ["scenario:scenario-a"];
    const lanePlan = plan([FIRST_PAIR], 1, liveFilters);
    const laneReport = report({
      authMode: "live",
      includeFilters: liveFilters,
      pairs: [FIRST_PAIR],
      repeat: 1,
    });
    const firstRecord = firstRecordOf(laneReport);
    (firstRecord.providerEvidence as JsonObject).source = "mock-provider-log";

    expect(() =>
      validate(lanePlan, laneReport, {
        authMode: "live",
        includeFilters: liveFilters,
        repeat: 1,
      }),
    ).toThrow("live record scenario-a/state-a provider source was mock-provider-log");
  });

  it("accepts live timeline evidence with observed provider requests", () => {
    const liveFilters = ["scenario:scenario-a"];
    const lanePlan = plan([FIRST_PAIR], 1, liveFilters);
    const laneReport = report({
      authMode: "live",
      includeFilters: liveFilters,
      pairs: [FIRST_PAIR],
      repeat: 1,
    });

    expect(
      validate(lanePlan, laneReport, {
        authMode: "live",
        includeFilters: liveFilters,
        repeat: 1,
      }),
    ).toEqual({
      authMode: "live",
      pairCount: 1,
      recordCount: 1,
      repeat: 1,
    });
  });

  it("rejects live evidence for a different provider model", () => {
    const liveFilters = ["scenario:scenario-a"];
    const lanePlan = plan([FIRST_PAIR], 1, liveFilters);
    const laneReport = report({
      authMode: "live",
      includeFilters: liveFilters,
      pairs: [FIRST_PAIR],
      repeat: 1,
    });
    (firstRecordOf(laneReport).providerEvidence as JsonObject).models = [
      { value: "gpt-5.5", count: 1 },
    ];

    expect(() =>
      validate(lanePlan, laneReport, {
        authMode: "live",
        includeFilters: liveFilters,
        repeat: 1,
      }),
    ).toThrow("live record scenario-a/state-a provider model did not match gpt-5.6");
  });

  it("rejects mixed live provider models", () => {
    const liveFilters = ["scenario:scenario-a"];
    const lanePlan = plan([FIRST_PAIR], 1, liveFilters);
    const laneReport = report({
      authMode: "live",
      includeFilters: liveFilters,
      pairs: [FIRST_PAIR],
      repeat: 1,
    });
    const providerEvidence = firstRecordOf(laneReport).providerEvidence as JsonObject;
    providerEvidence.requestCount = 2;
    providerEvidence.models = [
      { value: MODEL, count: 1 },
      { value: "gpt-5.5", count: 1 },
    ];

    expect(() =>
      validate(lanePlan, laneReport, {
        authMode: "live",
        includeFilters: liveFilters,
        repeat: 1,
      }),
    ).toThrow("live record scenario-a/state-a provider model evidence was not exact");
  });

  it("rejects live provider model count drift", () => {
    const liveFilters = ["scenario:scenario-a"];
    const lanePlan = plan([FIRST_PAIR], 1, liveFilters);
    const laneReport = report({
      authMode: "live",
      includeFilters: liveFilters,
      pairs: [FIRST_PAIR],
      repeat: 1,
    });
    (firstRecordOf(laneReport).providerEvidence as JsonObject).models = [
      { value: MODEL, count: 2 },
    ];

    expect(() =>
      validate(lanePlan, laneReport, {
        authMode: "live",
        includeFilters: liveFilters,
        repeat: 1,
      }),
    ).toThrow("live record scenario-a/state-a provider model count did not match request count");
  });

  it("rejects plan and report schema drift", () => {
    const badPlan = plan();
    badPlan.schemaVersion = "kova.matrix.plan.v0";
    expect(() => validate(badPlan, report())).toThrow("unexpected lane plan schema");

    const badReport = report();
    badReport.schemaVersion = "kova.report.v0";
    expect(() => validate(plan(), badReport)).toThrow("unexpected lane report schema");
  });

  it("rejects plan and report include-filter drift", () => {
    const badPlan = plan();
    (badPlan.controls as JsonObject).include = ["scenario:scenario-a"];
    expect(() => validate(badPlan, report())).toThrow("lane plan include filters did not match");

    const badReport = report();
    (badReport.controls as JsonObject).include = ["scenario:scenario-a"];
    expect(() => validate(plan(), badReport)).toThrow("lane report include filters did not match");
  });

  it("rejects requested and record auth drift", () => {
    const laneReport = report();
    (laneReport.auth as JsonObject).requestedMode = "live";
    expect(() => validate(plan(), laneReport)).toThrow("lane report requested auth did not match");

    const recordAuthDrift = report();
    (firstRecordOf(recordAuthDrift).auth as JsonObject).mode = "live";
    expect(() => validate(plan(), recordAuthDrift)).toThrow(
      "record scenario-a/state-a auth mode did not match",
    );
  });

  it("rejects malformed record state", () => {
    const laneReport = report();
    firstRecordOf(laneReport).state = "state-a";

    expect(() => validate(plan(), laneReport)).toThrow("invalid lane report record 0 state");
  });

  it("rejects malformed JSON through the CLI", () => {
    const result = runCli({ lanePlan: "{not-json" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--plan is not valid JSON");
  });

  it("rejects zero repeat and missing CLI arguments", () => {
    const zeroRepeat = runCli({ repeat: "0" });
    expect(zeroRepeat.status).toBe(1);
    expect(zeroRepeat.stderr).toContain("invalid expected repeat");

    const missingAuth = runCli({ includeAuth: false });
    expect(missingAuth.status).toBe(1);
    expect(missingAuth.stderr).toContain("invalid --auth");
  });
});
