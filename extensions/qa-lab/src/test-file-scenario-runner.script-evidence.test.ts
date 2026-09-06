import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateQaEvidenceSummaryJson } from "./evidence-summary.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import {
  runQaTestFileScenarios,
  type QaScenarioCommandExecution,
} from "./test-file-scenario-runner.js";
import {
  buildScriptProducerEvidence,
  QA_TEST_RUNNER_DEFAULTS,
  createScenarioRunnerTestHarness,
  makeTestFileScenario,
  writeScriptProducerEvidence,
} from "./test-file-scenario-runner.test-support.js";

const harness = createScenarioRunnerTestHarness();
const makeTempRepo = (prefix: string) => harness.makeTempRepo(prefix);

afterEach(async () => {
  await harness.cleanup();
});

describe("qa test file scenario runner", () => {
  it.each(
    (
      [
        { evidence: "missing", expectedFailure: /without writing fresh producer QA evidence/u },
        { evidence: "stale", expectedFailure: /without writing fresh producer QA evidence/u },
        { evidence: "empty", expectedFailure: /without reporting an executed producer check/u },
        { evidence: "malformed", expectedFailure: /invalid JSON/u },
        { evidence: "outside", expectedFailure: /inside its scenario output directory/u },
      ] as const
    ).flatMap(({ evidence, expectedFailure }) =>
      (["full", "slim"] as const).map((evidenceMode) => ({
        evidence,
        expectedFailure,
        evidenceMode,
      })),
    ),
  )(
    "retains $evidence producer failure alongside passing evidence in $evidenceMode mode",
    async ({ evidence, evidenceMode, expectedFailure }) => {
      const repoRoot = await makeTempRepo(`qa-script-${evidence}-producer-evidence-`);
      const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script");
      const scenarioOutputDir = path.join(outputDir, "scenario-script");
      const latestRunPath = path.join(scenarioOutputDir, "latest-run.json");
      const evidencePath = path.join(scenarioOutputDir, "qa-evidence.json");

      if (evidence === "stale") {
        await writeScriptProducerEvidence({ outputDir, status: "pass" });
        const staleEvidencePath = path.join(scenarioOutputDir, "run-1", "qa-evidence.json");
        await fs.copyFile(staleEvidencePath, evidencePath);
        const staleTimestamp = new Date(Date.now() - 60_000);
        await Promise.all([
          fs.utimes(staleEvidencePath, staleTimestamp, staleTimestamp),
          fs.utimes(evidencePath, staleTimestamp, staleTimestamp),
        ]);
      }

      const result = await runQaTestFileScenarios({
        repoRoot,
        outputDir,
        ...QA_TEST_RUNNER_DEFAULTS,
        evidenceMode,
        scenarios: [
          makeTestFileScenario("script", "scripts/evidence-producer.ts"),
          {
            ...makeTestFileScenario("script", "scripts/healthy-evidence-producer.ts"),
            id: "healthy-scenario",
          },
        ],
        runCommand: async (command) => {
          if (command.args.includes("scripts/healthy-evidence-producer.ts")) {
            await writeScriptProducerEvidence({
              outputDir,
              scenarioId: "healthy-scenario",
              producerId: "healthy-check",
              status: "pass",
            });
            return { exitCode: 0, stdout: "healthy check passed\n", stderr: "" };
          }
          await fs.mkdir(scenarioOutputDir, { recursive: true });
          if (evidence === "stale") {
            await expect(fs.access(latestRunPath)).rejects.toMatchObject({ code: "ENOENT" });
            await expect(fs.access(evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
            await fs.writeFile(
              latestRunPath,
              JSON.stringify({
                qaEvidence: path.join(scenarioOutputDir, "run-1", "qa-evidence.json"),
              }),
              "utf8",
            );
          } else if (evidence === "empty") {
            await fs.writeFile(
              evidencePath,
              JSON.stringify({
                kind: "openclaw.qa.evidence-summary",
                schemaVersion: 2,
                generatedAt: new Date().toISOString(),
                evidenceMode: "full",
                entries: [],
              }),
              "utf8",
            );
          } else if (evidence === "malformed") {
            await fs.writeFile(evidencePath, "{not valid JSON", "utf8");
          } else if (evidence === "outside") {
            await writeScriptProducerEvidence({
              outputDir,
              scenarioId: "different-script-scenario",
              status: "pass",
            });
            await fs.writeFile(
              latestRunPath,
              JSON.stringify({
                qaEvidence: path.join(
                  outputDir,
                  "different-script-scenario",
                  "run-1",
                  "qa-evidence.json",
                ),
              }),
              "utf8",
            );
          }
          return { exitCode: 0, stdout: "script exited successfully\n", stderr: "" };
        },
      });

      expect(result.results[0]).toMatchObject({ status: "fail" });
      expect(result.results[0]?.failureMessage).toMatch(expectedFailure);
      expect(result.results[1]).toMatchObject({ status: "pass" });
      const exportedEvidence = validateQaEvidenceSummaryJson(
        JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
      );
      expect(exportedEvidence.evidenceMode).toBe(evidenceMode);
      expect(exportedEvidence.entries).toMatchObject([
        { test: { id: "scenario-script" }, result: { status: "fail" } },
        { test: { id: "healthy-check" }, result: { status: "pass" } },
      ]);
      if (evidenceMode === "slim") {
        expect(exportedEvidence.entries.every((entry) => entry.execution === undefined)).toBe(true);
      }
    },
  );

  it("runs script scenarios and imports producer QA evidence artifacts", async () => {
    const repoRoot = await makeTempRepo("qa-script-scenario-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script");
    const commands: QaScenarioCommandExecution[] = [];
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async (command) => {
        commands.push(command);
        const runRoot = path.join(outputDir, "scenario-script", "run-1");
        await fs.mkdir(path.join(runRoot, "surfaces", "web-ui"), { recursive: true });
        await fs.writeFile(path.join(runRoot, "surfaces", "web-ui", "screenshot.png"), "png");
        await writeScriptProducerEvidence({
          artifacts: [
            {
              kind: "screenshot",
              path: "surfaces/web-ui/screenshot.png",
              source: "script-producer:web-ui:smoke",
            },
          ],
          outputDir,
          status: "pass",
        });
        return { exitCode: 0, stdout: "script pass\n", stderr: "" };
      },
      env: { OPENCLAW_QA_REF: "scenario-ref" } as NodeJS.ProcessEnv,
    });

    expect(result.executionKind).toBe("script");
    expect(commands.map((command) => command.args)).toEqual([
      [
        "--import",
        "tsx",
        "scripts/evidence-producer.ts",
        "--once",
        "--artifact-base",
        path.join(outputDir, "scenario-script"),
      ],
    ]);
    expect(commands.map((command) => command.timeoutMs)).toEqual([30 * 60_000]);
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]).toMatchObject({
      test: { kind: "script-producer-check", id: "script-producer.web-ui.smoke" },
      coverage: [
        { id: "qa.coverage", role: "primary" },
        { id: "qa.reporting", role: "secondary" },
      ],
      execution: {
        runner: "evidence-producer-script",
        artifacts: [
          {
            kind: "screenshot",
            path: ".artifacts/qa-e2e/scenario-script/scenario-script/run-1/surfaces/web-ui/screenshot.png",
            source: "script-producer:web-ui:smoke",
          },
        ],
      },
      result: { status: "pass" },
    });
  });
  it("uses script scenario timeout overrides when running producer commands", async () => {
    const repoRoot = await makeTempRepo("qa-script-scenario-timeout-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script-timeout");
    const scenario = makeTestFileScenario("script", "scripts/evidence-producer.ts");
    if (scenario.execution.kind !== "script") {
      throw new Error("expected script scenario");
    }
    scenario.execution.timeoutMs = 3 * 60 * 60_000;

    const commands: QaScenarioCommandExecution[] = [];
    await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [scenario],
      commandTimeoutMs: 30 * 60_000,
      runCommand: async (command) => {
        commands.push(command);
        await writeScriptProducerEvidence({
          outputDir,
          status: "pass",
        });
        return {
          exitCode: 0,
          stdout: "script pass\n",
          stderr: "",
        };
      },
      env: {
        OPENCLAW_QA_REF: "scenario-ref",
      } as NodeJS.ProcessEnv,
    });

    expect(commands.map((command) => command.timeoutMs)).toEqual([3 * 60 * 60_000]);
  });

  it("imports producer QA evidence artifacts from failed script scenarios", async () => {
    const repoRoot = await makeTempRepo("qa-script-failed-scenario-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script-failed");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async () => {
        await writeScriptProducerEvidence({
          failureReason: "Script producer check failed.",
          outputDir,
          status: "fail",
        });
        return { exitCode: 1, stdout: "", stderr: "script failed\n" };
      },
      env: { OPENCLAW_QA_REF: "scenario-ref" } as NodeJS.ProcessEnv,
    });

    expect(result.results[0]).toMatchObject({
      status: "fail",
      failureMessage: "node exited with 1",
      producerEvidence: {
        entries: [
          {
            test: { id: "script-producer.web-ui.smoke" },
            result: { status: "fail" },
          },
        ],
      },
    });
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.entries).toHaveLength(2);
    expect(evidence.entries[0]).toMatchObject({
      test: { kind: "script-producer-check", id: "script-producer.web-ui.smoke" },
      coverage: [
        { id: "qa.coverage", role: "primary" },
        { id: "qa.reporting", role: "secondary" },
      ],
      result: {
        status: "fail",
        failure: { reason: "Script producer check failed." },
      },
    });
    expect(evidence.entries[1]).toMatchObject({
      test: {
        kind: "script-test",
        id: "scenario-script",
        source: { path: "scripts/evidence-producer.ts" },
      },
      result: {
        status: "fail",
        failure: { reason: "node exited with 1" },
      },
    });
  });
  it("suppresses a failed-script fallback row already owned by producer scenario evidence", async () => {
    const repoRoot = await makeTempRepo("qa-script-duplicate-scenario-evidence-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script-duplicate");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async () => {
        await writeScriptProducerEvidence({
          outputDir,
          producerId: "scenario-script",
          status: "fail",
          failureReason: "producer recorded the script failure",
        });
        return { exitCode: 1, stdout: "", stderr: "script failed\n" };
      },
      env: { OPENCLAW_QA_REF: "scenario-ref" } as NodeJS.ProcessEnv,
    });

    expect(result.results[0]).toMatchObject({ status: "fail" });
    expect(result.evidence.entries).toHaveLength(1);
    expect(result.evidence.entries[0]).toMatchObject({
      test: { id: "scenario-script" },
      result: { failure: { reason: "producer recorded the script failure" }, status: "fail" },
    });
  });

  it.each([
    { producerStatus: "pass" as const, terminal: "exit" as const },
    { producerStatus: "blocked" as const, terminal: "timeout" as const },
    { producerStatus: "skipped" as const, terminal: "exit" as const },
  ])(
    "makes a $terminal failure override colliding $producerStatus producer evidence",
    async ({ producerStatus, terminal }) => {
      const commandName = path.basename(process.execPath);
      const tempRoot = await makeTempRepo(`qa-script-terminal-${terminal}-${producerStatus}-`);
      const outputDir = path.join(tempRoot, "out");
      const scriptPath = path.join(tempRoot, "terminal-evidence-producer.mjs");
      const producerEvidence = buildScriptProducerEvidence({
        additionalEntries: buildScriptProducerEvidence({
          producerId: "producer-diagnostic",
          status: "pass",
        }).entries,
        artifacts: [{ kind: "log", path: "producer.log" }],
        producerId: "scenario-script",
        status: producerStatus,
      });
      const result = await runQaTestFileScenarios({
        repoRoot: process.cwd(),
        outputDir,
        ...QA_TEST_RUNNER_DEFAULTS,
        scenarios: [makeTestFileScenario("script", scriptPath)],
        commandTimeoutMs: 1_000,
        runCommand: async (command) => {
          const artifactBase = path.join(outputDir, "scenario-script");
          expect(command.args).toEqual([
            "--import",
            "tsx",
            scriptPath,
            "--once",
            "--artifact-base",
            artifactBase,
          ]);
          expect(command.timeoutMs).toBe(1_000);

          const runRoot = path.join(artifactBase, "run-1");
          await fs.mkdir(runRoot, { recursive: true });
          await fs.writeFile(path.join(runRoot, "producer.log"), "producer evidence\n", "utf8");
          await fs.writeFile(
            path.join(runRoot, "qa-evidence.json"),
            JSON.stringify(producerEvidence),
            "utf8",
          );
          await fs.writeFile(
            path.join(artifactBase, "latest-run.json"),
            JSON.stringify({ qaEvidence: "run-1/qa-evidence.json" }),
            "utf8",
          );

          return {
            exitCode: terminal === "timeout" ? 1 : 7,
            signal: null,
            stdout: "",
            stderr: "",
            ...(terminal === "timeout"
              ? { failureMessage: `${commandName} timed out after ${command.timeoutMs}ms` }
              : {}),
          };
        },
      });

      expect(result.results[0]).toMatchObject({
        failureMessage:
          terminal === "timeout"
            ? expect.stringContaining("timed out after 1000ms")
            : `${commandName} exited with 7`,
        status: "fail",
      });
      expect(result.evidence.entries).toHaveLength(2);
      expect(
        result.evidence.entries.find((entry) => entry.test.id === "scenario-script"),
      ).toMatchObject({
        coverage: [
          { id: "qa.coverage", role: "primary" },
          { id: "qa.reporting", role: "secondary" },
        ],
        execution: {
          artifacts: [{ kind: "log", path: expect.stringContaining("producer.log") }],
          runner: "evidence-producer-script",
        },
        result: {
          failure: {
            reason: `${commandName} ${
              terminal === "timeout" ? "timed out after 1000ms" : "exited with 7"
            }`,
          },
          status: "fail",
        },
      });
      expect(
        result.evidence.entries.find((entry) => entry.test.id === "producer-diagnostic"),
      ).toMatchObject({ result: { status: "pass" } });
    },
  );

  it("fails script scenario results when imported producer evidence fails", async () => {
    const repoRoot = await makeTempRepo("qa-script-producer-fail-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script-producer-fail");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async () => {
        await writeScriptProducerEvidence({
          failureReason: "Script producer check failed.",
          outputDir,
          status: "fail",
        });
        return { exitCode: 0, stdout: "script pass\n", stderr: "" };
      },
      env: { OPENCLAW_QA_REF: "scenario-ref" } as NodeJS.ProcessEnv,
    });

    expect(result.results[0]).toMatchObject({
      status: "fail",
      failureMessage: "Script producer check failed.",
    });
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]).toMatchObject({
      test: { id: "script-producer.web-ui.smoke" },
      result: { status: "fail" },
    });
  });
  it("fails script scenario results when imported producer evidence is blocked by default", async () => {
    const repoRoot = await makeTempRepo("qa-script-producer-blocked-");
    const outputDir = path.join(
      repoRoot,
      ".artifacts",
      "qa-e2e",
      "scenario-script-producer-blocked",
    );
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async () => {
        await writeScriptProducerEvidence({
          outputDir,
          status: "blocked",
          failureReason: "Playwright browser is missing.",
        });
        return {
          exitCode: 0,
          stdout: "script blocked\n",
          stderr: "",
        };
      },
      env: {
        OPENCLAW_QA_REF: "scenario-ref",
      } as NodeJS.ProcessEnv,
    });

    expect(result.results[0]).toMatchObject({
      status: "blocked",
      failureMessage: "Playwright browser is missing.",
    });
  });

  it("keeps all-blocked producer evidence blocked for opt-in script scenarios", async () => {
    const repoRoot = await makeTempRepo("qa-script-producer-blocked-allowed-");
    const outputDir = path.join(
      repoRoot,
      ".artifacts",
      "qa-e2e",
      "scenario-script-producer-blocked-allowed",
    );
    const scenario = makeTestFileScenario("script", "scripts/evidence-producer.ts");
    if (scenario.execution.kind !== "script") {
      throw new Error("expected script scenario");
    }
    scenario.execution.allowBlockedEvidence = true;

    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [scenario],
      runCommand: async () => {
        await writeScriptProducerEvidence({
          outputDir,
          status: "blocked",
          failureReason: "Playwright browser is missing.",
        });
        return {
          exitCode: 0,
          stdout: "script blocked\n",
          stderr: "",
        };
      },
      env: {
        OPENCLAW_QA_REF: "scenario-ref",
      } as NodeJS.ProcessEnv,
    });

    expect(result.results[0]).toMatchObject({
      status: "blocked",
      failureMessage: "Playwright browser is missing.",
      producerEvidence: {
        entries: [
          {
            test: {
              id: "script-producer.web-ui.smoke",
            },
            result: {
              status: "blocked",
            },
          },
        ],
      },
    });
  });

  it("allows blocked producer checks when another check genuinely passes", async () => {
    const repoRoot = await makeTempRepo("qa-script-producer-blocked-mixed-");
    const outputDir = path.join(
      repoRoot,
      ".artifacts",
      "qa-e2e",
      "scenario-script-producer-blocked-mixed",
    );
    const scenario = makeTestFileScenario("script", "scripts/evidence-producer.ts");
    if (scenario.execution.kind !== "script") {
      throw new Error("expected script scenario");
    }
    scenario.execution.allowBlockedEvidence = true;

    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [scenario],
      runCommand: async () => {
        await writeScriptProducerEvidence({
          additionalEntries: buildScriptProducerEvidence({
            producerId: "script-producer.web-ui.executed",
            status: "pass",
          }).entries,
          outputDir,
          status: "blocked",
          failureReason: "Playwright browser is missing.",
        });
        return {
          exitCode: 0,
          stdout: "script mixed\n",
          stderr: "",
        };
      },
      env: {
        OPENCLAW_QA_REF: "scenario-ref",
      } as NodeJS.ProcessEnv,
    });

    expect(result.results[0]).toMatchObject({
      status: "pass",
      producerEvidence: {
        entries: [{ result: { status: "blocked" } }, { result: { status: "pass" } }],
      },
    });
  });

  it.each([
    {
      name: "blocked plus skipped without a pass",
      statuses: ["blocked", "skipped"] as const,
      allowBlockedEvidence: true,
      expectedStatus: "blocked",
    },
    {
      name: "all skipped",
      statuses: ["skipped"] as const,
      allowBlockedEvidence: false,
      expectedStatus: "skipped",
    },
    {
      name: "pass plus skipped",
      statuses: ["pass", "skipped"] as const,
      allowBlockedEvidence: false,
      expectedStatus: "skipped",
    },
    {
      name: "allowed blocked plus pass plus skipped",
      statuses: ["blocked", "pass", "skipped"] as const,
      allowBlockedEvidence: true,
      expectedStatus: "skipped",
    },
  ])(
    "keeps $name producer precedence",
    async ({ statuses, allowBlockedEvidence, expectedStatus }) => {
      const repoRoot = await makeTempRepo("qa-script-producer-skipped-");
      const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script-skipped");
      const [firstStatus, ...additionalStatuses] = statuses;
      const scenario = makeTestFileScenario("script", "scripts/evidence-producer.ts");
      if (scenario.execution.kind !== "script") {
        throw new Error("expected script scenario");
      }
      scenario.execution.allowBlockedEvidence = allowBlockedEvidence;
      const result = await runQaTestFileScenarios({
        repoRoot,
        outputDir,
        ...QA_TEST_RUNNER_DEFAULTS,
        scenarios: [scenario],
        runCommand: async () => {
          await writeScriptProducerEvidence({
            additionalEntries: additionalStatuses.flatMap(
              (status, index) =>
                buildScriptProducerEvidence({
                  producerId: `script-producer.web-ui.additional-${index}`,
                  status,
                }).entries,
            ),
            outputDir,
            status: firstStatus,
          });
          return { exitCode: 0, stdout: "script completed\n", stderr: "" };
        },
      });

      expect(result.results[0]).toMatchObject({ status: expectedStatus });
      expect(
        result.results[0]?.producerEvidence?.entries.map((entry) => entry.result.status),
      ).toEqual(statuses);
    },
  );

  it("carries the suite profile into merged producer evidence", async () => {
    const repoRoot = await makeTempRepo("qa-script-profile-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script-profile");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async () => {
        await writeScriptProducerEvidence({
          evidenceLocation: "scenario-root",
          latestRun: "none",
          outputDir,
          profile: "smoke-ci",
          status: "pass",
        });
        return { exitCode: 0, stdout: "script pass\n", stderr: "" };
      },
      env: {
        OPENCLAW_QA_REF: "scenario-ref",
        OPENCLAW_QA_PROFILE: "smoke-ci",
      } as NodeJS.ProcessEnv,
    });

    expect(result.evidence.profile).toBe("smoke-ci");
  });
  it("keeps producer artifacts outside the repo root absolute instead of emitting ../ paths", async () => {
    const repoRoot = await makeTempRepo("qa-script-external-artifact-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script-external");
    const externalArtifact = path.join(os.tmpdir(), "qa-external-artifact.png");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async () => {
        await writeScriptProducerEvidence({
          artifacts: [{ kind: "screenshot", path: externalArtifact }],
          outputDir,
          status: "pass",
        });
        return { exitCode: 0, stdout: "script pass\n", stderr: "" };
      },
      env: { OPENCLAW_QA_REF: "scenario-ref" } as NodeJS.ProcessEnv,
    });

    const artifactPath = result.evidence.entries[0]?.execution?.artifacts[0]?.path;
    expect(artifactPath).toBe(path.normalize(externalArtifact));
    expect(artifactPath?.includes("..")).toBe(false);
  });
  it("imports coverage-free structured evidence through the real script lifecycle", async () => {
    const tempRoot = await harness.makeTempDir("qa-script-real-evidence-");
    const outputDir = path.join(tempRoot, "out");
    const scriptPath = path.join(tempRoot, "minimal-evidence-producer.mjs");
    const producerEvidence = buildScriptProducerEvidence({
      artifacts: [{ kind: "log", path: "artifact.log" }],
      coverage: [],
      status: "pass",
    });
    await fs.writeFile(
      scriptPath,
      [
        "import fs from 'node:fs/promises';",
        "import path from 'node:path';",
        "const artifactBaseIndex = process.argv.indexOf('--artifact-base');",
        "if (artifactBaseIndex < 0) throw new Error('missing --artifact-base');",
        "const artifactBase = process.argv[artifactBaseIndex + 1];",
        "const runRoot = path.join(artifactBase, 'run-1');",
        "await fs.mkdir(runRoot, { recursive: true });",
        "await fs.writeFile(path.join(runRoot, 'artifact.log'), 'structured evidence\\n', 'utf8');",
        `const evidence = ${JSON.stringify(producerEvidence)};`,
        "await fs.writeFile(path.join(runRoot, 'qa-evidence.json'), JSON.stringify(evidence), 'utf8');",
        "await fs.writeFile(path.join(artifactBase, 'latest-run.json'), JSON.stringify({ qaEvidence: 'run-1/qa-evidence.json' }), 'utf8');",
      ].join("\n"),
      "utf8",
    );
    const infrastructureFixture: QaSeedScenarioWithSource = {
      id: "scenario-script",
      title: "Temporary script evidence fixture",
      surface: "qa-lab",
      objective: "Exercise structured evidence import through the real script lifecycle.",
      successCriteria: ["The runner imports coverage-free producer evidence and artifacts."],
      codeRefs: ["external/qa/minimal-evidence-producer.mjs"],
      sourcePath: "external/qa/minimal-evidence-scenario.yaml",
      execution: {
        kind: "script",
        path: scriptPath,
        args: ["--artifact-base", "${outputDir}"],
      },
    };

    const result = await runQaTestFileScenarios({
      repoRoot: process.cwd(),
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [infrastructureFixture],
      commandTimeoutMs: 20_000,
      env: { OPENCLAW_QA_REF: "temporary-script-fixture" } as NodeJS.ProcessEnv,
    });

    expect(result.executionKind).toBe("script");
    expect(result.results[0]).toMatchObject({
      status: "pass",
      producerEvidence: {
        entries: [{ test: { id: "script-producer.web-ui.smoke" } }],
      },
    });
    expect(result.evidence.entries[0]).toMatchObject({
      coverage: [],
      execution: {
        artifacts: [
          {
            kind: "log",
            path: path.join(outputDir, "scenario-script", "run-1", "artifact.log"),
          },
        ],
      },
      test: { id: "script-producer.web-ui.smoke" },
    });
  });
});
