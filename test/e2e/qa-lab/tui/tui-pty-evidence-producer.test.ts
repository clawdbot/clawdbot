// TUI PTY evidence producer tests cover validation, command routing, and reports.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  validateQaEvidenceSummaryJson,
  type QaSeedScenarioWithSource,
} from "../../../../extensions/qa-lab/api.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import {
  buildTuiPtyVitestCommand,
  parseTuiPtyProducerOptions,
  runTuiPtyEvidenceProducer,
  validateTuiPtyScenario,
  verifyTuiPtyVitestReport,
  type TuiPtyCase,
} from "./tui-pty-evidence-producer.js";

const SOURCE_PATH = "test/e2e/qa-lab/tui/tui-pty-evidence-producer.ts";
const ASSERTION_SUPPORT_FILE = "src/tui/tui-pty-harness-assertion-test-support.test.ts";
const HARNESS_FILE = "src/tui/tui-pty-harness.e2e.test.ts";
const LOCAL_FILE = "src/tui/tui-pty-local.e2e.test.ts";
const RESET_FILE = "src/tui/tui-reset-transition-pty.e2e.test.ts";
const COVERAGE_ID = "tui.message-composition";
const TEST_NAME = "TUI PTY harness drives the real TUI terminal loop";
const TEST_PATTERN = `^${TEST_NAME}$`;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

function makeScenario(
  params: {
    cases?: unknown[];
    primary?: string[];
    secondary?: string[];
    executionKind?: "script" | "vitest";
    executionPath?: string;
    requireBuiltCli?: unknown;
  } = {},
): QaSeedScenarioWithSource {
  const config = {
    tuiPtyCases: params.cases ?? [makeCase()],
    ...(params.requireBuiltCli !== undefined ? { requireBuiltCli: params.requireBuiltCli } : {}),
  };
  const execution =
    params.executionKind === "vitest"
      ? {
          kind: "vitest" as const,
          path: params.executionPath ?? SOURCE_PATH,
          config,
        }
      : {
          kind: "script" as const,
          path: params.executionPath ?? SOURCE_PATH,
          config,
        };
  return {
    id: "tui-pty-evidence-producer-contract",
    title: "TUI PTY producer test",
    surface: "tui",
    objective: "Prove the TUI PTY evidence producer contract.",
    successCriteria: ["The configured PTY assertion passes."],
    sourcePath: "qa/scenarios/ui/tui-pty-producer-test.yaml",
    coverage: {
      primary: params.primary ?? [],
      ...(params.secondary ? { secondary: params.secondary } : { secondary: [COVERAGE_ID] }),
    },
    execution,
  };
}

function makeCase(overrides: Partial<TuiPtyCase> = {}): TuiPtyCase {
  return {
    coverageId: COVERAGE_ID,
    testFile: HARNESS_FILE,
    testNamePattern: TEST_PATTERN,
    ...overrides,
  };
}

async function makeTempRepo() {
  const repoRoot = tempDirs.make("openclaw-tui-pty-producer-");
  for (const testFile of [ASSERTION_SUPPORT_FILE, HARNESS_FILE, LOCAL_FILE, RESET_FILE]) {
    const absolutePath = path.join(repoRoot, testFile);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, "// fixture\n", "utf8");
  }
  return repoRoot;
}

async function writeBuiltCliArtifacts(repoRoot: string, entry: "entry.js" | "entry.mjs") {
  await fs.writeFile(path.join(repoRoot, "openclaw.mjs"), "// launcher\n", "utf8");
  await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(repoRoot, "dist", entry), "// entry\n", "utf8");
}

async function writeReport(
  reportPath: string,
  params: {
    assertionName?: string;
    failed?: number;
    passed?: number;
    testFile?: string;
  } = {},
) {
  const assertionName = params.assertionName ?? TEST_NAME;
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(
    reportPath,
    `${JSON.stringify({
      numFailedTests: params.failed ?? 0,
      numPassedTests: params.passed ?? 1,
      success: (params.failed ?? 0) === 0,
      testResults: [
        {
          name: params.testFile ?? HARNESS_FILE,
          assertionResults:
            (params.passed ?? 1) > 0
              ? [{ fullName: assertionName, status: "passed", title: assertionName }]
              : [],
        },
      ],
    })}\n`,
    "utf8",
  );
}

describe("TUI PTY evidence producer", () => {
  it("accepts only the two required CLI arguments exactly once", () => {
    expect(
      parseTuiPtyProducerOptions(
        ["--artifact-base", ".artifacts/pty", "--scenario-id", "scenario-id"],
        "/repo",
      ),
    ).toEqual({
      artifactBase: path.resolve("/repo/.artifacts/pty"),
      repoRoot: path.resolve("/repo"),
      scenarioId: "scenario-id",
    });
    expect(() => parseTuiPtyProducerOptions([], "/repo")).toThrow("--artifact-base is required");
    expect(() =>
      parseTuiPtyProducerOptions(["--artifact-base", "out", "--extra", "value"], "/repo"),
    ).toThrow("unsupported TUI PTY evidence producer argument");
    expect(() =>
      parseTuiPtyProducerOptions(
        ["--artifact-base", "one", "--artifact-base", "two", "--scenario-id", "id"],
        "/repo",
      ),
    ).toThrow("--artifact-base was provided more than once");
  });

  it("rejects arbitrary paths, traversal, malformed cases, and invalid patterns", () => {
    expect(() =>
      validateTuiPtyScenario(
        makeScenario({
          cases: [makeCase({ testFile: "../outside.test.ts" as typeof HARNESS_FILE })],
        }),
      ),
    ).toThrow("testFile is not allowlisted");
    expect(() =>
      validateTuiPtyScenario(
        makeScenario({
          cases: [makeCase({ testFile: "src/tui/other.e2e.test.ts" as typeof HARNESS_FILE })],
        }),
      ),
    ).toThrow("testFile is not allowlisted");
    expect(() =>
      validateTuiPtyScenario(makeScenario({ cases: [{ ...makeCase(), extra: true }] })),
    ).toThrow("contains unsupported key extra");
    expect(() =>
      validateTuiPtyScenario(makeScenario({ cases: [makeCase({ testNamePattern: "[" })] })),
    ).toThrow("testNamePattern is invalid");
  });

  it("requires declared coverage, every primary ID, unique cases, and the producer path", () => {
    expect(() =>
      validateTuiPtyScenario(
        makeScenario({ cases: [makeCase({ coverageId: "tui.output-safety" })] }),
      ),
    ).toThrow("coverage ID not owned by scenario");
    expect(() =>
      validateTuiPtyScenario(
        makeScenario({
          primary: [COVERAGE_ID, "tui.output-safety"],
          cases: [makeCase()],
        }),
      ),
    ).toThrow("primary coverage IDs without TUI PTY cases: tui.output-safety");
    expect(() => validateTuiPtyScenario(makeScenario({ cases: [makeCase(), makeCase()] }))).toThrow(
      "duplicate TUI PTY case",
    );
    expect(() => validateTuiPtyScenario(makeScenario({ executionKind: "vitest" }))).toThrow(
      "execution.kind=script",
    );
    expect(() => validateTuiPtyScenario(makeScenario({ executionPath: "test/other.ts" }))).toThrow(
      `must execute ${SOURCE_PATH}`,
    );
  });

  it("normalizes missing and false built requirements to source, and true to built", () => {
    expect(validateTuiPtyScenario(makeScenario()).cliMode).toBe("source");
    expect(validateTuiPtyScenario(makeScenario({ requireBuiltCli: false })).cliMode).toBe("source");
    expect(
      validateTuiPtyScenario(
        makeScenario({
          cases: [makeCase({ testFile: LOCAL_FILE })],
          requireBuiltCli: true,
        }),
      ).cliMode,
    ).toBe("built");
  });

  it.each(["built", 1, null])("rejects invalid requireBuiltCli value %j", (requireBuiltCli) => {
    expect(() => validateTuiPtyScenario(makeScenario({ requireBuiltCli }))).toThrow(
      "execution.config.requireBuiltCli must be a boolean",
    );
  });

  it("rejects harness-only and mixed cases in built mode", () => {
    expect(() => validateTuiPtyScenario(makeScenario({ requireBuiltCli: true }))).toThrow(
      `every testFile to be exactly ${LOCAL_FILE}`,
    );
    expect(() =>
      validateTuiPtyScenario(
        makeScenario({
          requireBuiltCli: true,
          cases: [makeCase({ testFile: LOCAL_FILE }), makeCase()],
        }),
      ),
    ).toThrow(`every testFile to be exactly ${LOCAL_FILE}`);
  });

  it("builds fake and local PTY commands with the required environment", () => {
    vi.stubEnv("OPENCLAW_TUI_PTY_INCLUDE_LOCAL", "1");
    vi.stubEnv("OPENCLAW_TUI_PTY_USE_BUILT_CLI", "inherited");
    const fake = buildTuiPtyVitestCommand({
      cases: [makeCase()],
      cliMode: "source",
      repoRoot: "/repo",
      reportPath: "/artifacts/report.json",
    });
    expect(fake.args).toEqual(
      expect.arrayContaining([
        "scripts/run-vitest.mjs",
        "run",
        "--config",
        "test/vitest/vitest.tui-pty.config.ts",
        HARNESS_FILE,
        "--reporter=json",
        "--outputFile.json=/artifacts/report.json",
      ]),
    );
    expect(fake.env.OPENCLAW_BEHAVIOR_EVIDENCE).toBe("1");
    expect(fake.env.OPENCLAW_TUI_PTY_INCLUDE_LOCAL).toBeUndefined();
    expect(fake.env.OPENCLAW_TUI_PTY_USE_BUILT_CLI).toBeUndefined();

    const oracle = buildTuiPtyVitestCommand({
      cases: [makeCase({ testFile: ASSERTION_SUPPORT_FILE })],
      cliMode: "source",
      repoRoot: "/repo",
      reportPath: "/artifacts/report.json",
    });
    expect(oracle.args).toContain(ASSERTION_SUPPORT_FILE);

    const local = buildTuiPtyVitestCommand({
      cases: [makeCase({ testFile: LOCAL_FILE })],
      cliMode: "built",
      repoRoot: "/repo",
      reportPath: "/artifacts/report.json",
    });
    expect(local.args).toContain(LOCAL_FILE);
    expect(local.env.OPENCLAW_TUI_PTY_INCLUDE_LOCAL).toBe("1");
    expect(local.env.OPENCLAW_TUI_PTY_USE_BUILT_CLI).toBe("1");
  });

  it("rejects wrong-file and unmatched-pattern reports", async () => {
    const repoRoot = await makeTempRepo();
    await expect(
      verifyTuiPtyVitestReport({
        cases: [makeCase()],
        repoRoot,
        report: {
          success: true,
          numFailedTests: 0,
          numPassedTests: 1,
          testResults: [
            {
              name: RESET_FILE,
              assertionResults: [{ fullName: TEST_NAME, status: "passed" }],
            },
          ],
        },
      }),
    ).rejects.toThrow(`no result for configured test file ${HARNESS_FILE}`);
    await expect(
      verifyTuiPtyVitestReport({
        cases: [makeCase()],
        repoRoot,
        report: {
          success: true,
          numFailedTests: 0,
          numPassedTests: 1,
          testResults: [
            {
              name: HARNESS_FILE,
              assertionResults: [{ fullName: "another assertion", status: "passed" }],
            },
          ],
        },
      }),
    ).rejects.toThrow("no passed assertion");
  });

  it("fails when the child writes no fresh report or writes a stale report", async () => {
    const repoRoot = await makeTempRepo();
    const artifactBase = path.join(repoRoot, ".artifacts", "missing-report");
    const scenario = makeScenario();
    const missing = await runTuiPtyEvidenceProducer(
      { artifactBase, repoRoot, scenarioId: scenario.id },
      {
        loadScenario: () => scenario,
        runCommand: async () => ({ exitCode: 0, signal: null }),
      },
    );
    expect(missing.entries[0]?.result).toMatchObject({
      status: "fail",
      failure: { reason: expect.stringContaining("did not write vitest-report.json") },
    });

    const staleBase = path.join(repoRoot, ".artifacts", "stale-report");
    const stale = await runTuiPtyEvidenceProducer(
      { artifactBase: staleBase, repoRoot, scenarioId: scenario.id },
      {
        loadScenario: () => scenario,
        now: () => 10_000,
        runCommand: async (command) => {
          const reportPath = command.args
            .find((arg) => arg.startsWith("--outputFile.json="))
            ?.slice("--outputFile.json=".length);
          await writeReport(reportPath ?? "");
          await fs.utimes(reportPath ?? "", new Date(0), new Date(0));
          return { exitCode: 0, signal: null };
        },
      },
    );
    expect(stale.entries[0]?.result).toMatchObject({
      status: "fail",
      failure: { reason: expect.stringContaining("report is stale") },
    });
  });

  it("fails built preflight for a missing launcher or dist entry without spawning", async () => {
    for (const missing of ["launcher", "dist"] as const) {
      const repoRoot = await makeTempRepo();
      if (missing === "launcher") {
        await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });
        await fs.writeFile(path.join(repoRoot, "dist", "entry.js"), "// entry\n", "utf8");
      } else {
        await fs.writeFile(path.join(repoRoot, "openclaw.mjs"), "// launcher\n", "utf8");
      }
      const scenario = makeScenario({
        cases: [makeCase({ testFile: LOCAL_FILE })],
        requireBuiltCli: true,
      });
      const runCommand = vi.fn(async () => ({ exitCode: 0, signal: null }));
      const artifactBase = path.join(repoRoot, ".artifacts", `missing-${missing}`);
      const evidence = await runTuiPtyEvidenceProducer(
        { artifactBase, repoRoot, scenarioId: scenario.id },
        { loadScenario: () => scenario, runCommand },
      );

      expect(runCommand).not.toHaveBeenCalled();
      expect(evidence.entries[0]).toMatchObject({
        execution: {
          artifacts: [
            { kind: "log", path: "tui-pty-evidence-producer.log" },
            { kind: "proof-matrix", path: "proof-matrix.json" },
          ],
        },
        result: {
          status: "fail",
          failure: {
            reason: expect.stringContaining(
              "cliMode=built requires readable openclaw.mjs and at least one readable dist/entry.js or dist/entry.mjs",
            ),
          },
        },
      });
    }
  });

  it.each(["entry.js", "entry.mjs"] as const)(
    "accepts built CLI artifact %s and records built proof mode",
    async (entry) => {
      const repoRoot = await makeTempRepo();
      await writeBuiltCliArtifacts(repoRoot, entry);
      const artifactBase = path.join(repoRoot, ".artifacts", entry);
      const scenario = makeScenario({
        cases: [makeCase({ testFile: LOCAL_FILE })],
        requireBuiltCli: true,
      });
      await runTuiPtyEvidenceProducer(
        { artifactBase, repoRoot, scenarioId: scenario.id },
        {
          loadScenario: () => scenario,
          runCommand: async (command) => {
            const reportPath = command.args
              .find((arg) => arg.startsWith("--outputFile.json="))
              ?.slice("--outputFile.json=".length);
            await writeReport(reportPath ?? "", { testFile: LOCAL_FILE });
            return { exitCode: 0, signal: null };
          },
        },
      );

      const proofMatrix = JSON.parse(
        await fs.readFile(path.join(artifactBase, "proof-matrix.json"), "utf8"),
      ) as { cliMode: string };
      expect(proofMatrix.cliMode).toBe("built");
    },
  );

  it("writes a sanitized proof matrix and passing QA evidence", async () => {
    const repoRoot = await makeTempRepo();
    const artifactBase = path.join(repoRoot, ".artifacts", "passing-report");
    const scenario = makeScenario();
    const evidence = await runTuiPtyEvidenceProducer(
      { artifactBase, repoRoot, scenarioId: scenario.id },
      {
        loadScenario: () => scenario,
        runCommand: async (command) => {
          const reportPath = command.args
            .find((arg) => arg.startsWith("--outputFile.json="))
            ?.slice("--outputFile.json=".length);
          await writeReport(reportPath ?? "", {
            testFile: path.join(repoRoot, HARNESS_FILE),
          });
          return { exitCode: 0, signal: null };
        },
      },
    );

    expect(validateQaEvidenceSummaryJson(evidence)).toEqual(evidence);
    expect(evidence.entries[0]).toMatchObject({
      coverage: [{ id: COVERAGE_ID, role: "secondary" }],
      result: { status: "pass" },
    });
    const proofMatrix = JSON.parse(
      await fs.readFile(path.join(artifactBase, "proof-matrix.json"), "utf8"),
    ) as { cases: Array<{ coverageId: string; matchedAssertions: string[] }>; cliMode: string };
    expect(proofMatrix.cliMode).toBe("source");
    expect(proofMatrix.cases).toEqual([
      expect.objectContaining({
        coverageId: COVERAGE_ID,
        matchedAssertions: [TEST_NAME],
      }),
    ]);
    const reportText = await fs.readFile(path.join(artifactBase, "vitest-report.json"), "utf8");
    expect(reportText).toContain(`"name": "${HARNESS_FILE}"`);
    expect(reportText).not.toContain(repoRoot);
    await expect(fs.access(path.join(artifactBase, "latest-run.json"))).resolves.toBeUndefined();
    await expect(fs.access(path.join(artifactBase, "qa-evidence.json"))).resolves.toBeUndefined();
  });
});
