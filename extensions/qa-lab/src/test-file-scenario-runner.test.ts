import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { validateQaEvidenceSummaryJson } from "./evidence-summary.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";
import {
  qaTestFileScenarioRunnerTesting,
  runQaTestFileScenarios,
  type QaScenarioCommandExecution,
} from "./test-file-scenario-runner.js";

const tempRoots: string[] = [];
const { cleanup: cleanupTempDirs, makeTempDir } = createTempDirHarness();

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readPid(filePath: string, timeoutMs: number) {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    try {
      const pid = Number(await fs.readFile(filePath, "utf8"));
      if (Number.isInteger(pid) && pid > 0) {
        return pid;
      }
    } catch {
      // retry until the process writes its pid
    }
    await sleep(5);
  }
  throw new Error(`timeout waiting for pid in ${filePath}`);
}

async function waitForDead(pid: number, timeoutMs: number) {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!isProcessRunning(pid)) {
      return;
    }
    await sleep(5);
  }
  throw new Error(`process ${pid} still alive`);
}

function makeTestFileScenario(
  executionKind: "script" | "vitest" | "playwright",
  pathLocal: string,
  testNamePattern?: string,
): QaSeedScenarioWithSource {
  return {
    id: `scenario-${executionKind}`,
    title: `${executionKind} scenario`,
    surface: executionKind === "playwright" ? "control-ui" : "qa-lab",
    category: executionKind === "playwright" ? "control-ui.browser-ui" : "qa-lab.coverage",
    coverage: {
      primary: [executionKind === "playwright" ? "ui.control" : "qa.coverage"],
      secondary: [executionKind === "playwright" ? "ui.streaming" : "qa.reporting"],
    },
    objective: `Exercise ${executionKind} scenario evidence.`,
    successCriteria: ["The scenario writes structured evidence."],
    docsRefs: ["docs/concepts/qa-e2e-automation.md"],
    codeRefs: [pathLocal],
    sourcePath: `qa/scenarios/ui/scenario-${executionKind}.md`,
    execution: {
      kind: executionKind,
      path: pathLocal,
      ...(testNamePattern ? { testNamePattern } : {}),
      ...(executionKind === "script"
        ? { args: ["--once", "--artifact-base", "${outputDir}"] }
        : {}),
    },
  };
}

async function makeTempRepo(prefix: string) {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(repoRoot);
  await fs.mkdir(path.join(repoRoot, ".artifacts", "qa-e2e"), { recursive: true });
  return repoRoot;
}

async function writeScriptProducerEvidence(params: {
  outputDir: string;
  scenarioId?: string;
  status: "blocked" | "fail" | "pass";
  failureReason?: string;
}) {
  const scenarioArtifactBase = path.join(params.outputDir, params.scenarioId ?? "scenario-script");
  const runRoot = path.join(scenarioArtifactBase, "run-1");
  await fs.mkdir(runRoot, { recursive: true });
  await fs.writeFile(
    path.join(runRoot, "qa-evidence.json"),
    `${JSON.stringify(
      {
        kind: "openclaw.qa.evidence-summary",
        schemaVersion: 2,
        generatedAt: "2026-06-14T00:00:00.000Z",
        evidenceMode: "full",
        entries: [
          {
            test: {
              kind: "script-producer-check",
              id: "script-producer.web-ui.smoke",
              title: "Script producer: web-ui smoke",
              source: { path: "scripts/evidence-producer.ts" },
            },
            coverage: [{ id: "ui.control", role: "primary" }],
            execution: {
              runner: "evidence-producer-script",
              environment: { ref: "scenario-ref", os: "darwin", nodeVersion: "v24.0.0" },
              provider: {
                id: "script-producer",
                live: false,
                model: { name: null, ref: null },
                fixture: "mocked-script-evidence",
              },
              packageSource: { kind: "source-checkout", sha: "abc123" },
              artifacts: [],
            },
            result: {
              status: params.status,
              ...(params.failureReason ? { failure: { reason: params.failureReason } } : {}),
              timing: { wallMs: 1 },
            },
          },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(scenarioArtifactBase, "latest-run.json"),
    `${JSON.stringify({ qaEvidence: path.join(runRoot, "qa-evidence.json") }, null, 2)}\n`,
    "utf8",
  );
}

describe("qa test file scenario runner", () => {
  afterEach(async () => {
    qaTestFileScenarioRunnerTesting.resetTimeoutCleanupTimings();
    await Promise.all([
      cleanupTempDirs(),
      ...tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    ]);
  });

  it("runs Playwright scenarios with the repo UI e2e command and writes Playwright evidence", async () => {
    const repoRoot = await makeTempRepo("qa-playwright-scenario-");
    const commands: QaScenarioCommandExecution[] = [];
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-playwright"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      scenarios: [
        makeTestFileScenario(
          "playwright",
          "ui/src/e2e/chat-flow.e2e.test.ts",
          "sends a chat turn through the GUI",
        ),
      ],
      runCommand: async (command) => {
        commands.push(command);
        return {
          exitCode: 0,
          stdout: "pass\n",
          stderr: "",
        };
      },
      env: {
        OPENCLAW_QA_REF: "scenario-ref",
      } as NodeJS.ProcessEnv,
    });

    expect(result.executionKind).toBe("playwright");
    expect(commands.map((command) => command.args)).toEqual([
      ["scripts/ensure-playwright-chromium.mjs", "--skip-ffmpeg"],
      [
        "scripts/run-vitest.mjs",
        "run",
        "--config",
        "test/vitest/vitest.ui-e2e.config.ts",
        "--configLoader",
        "runner",
        "ui/src/e2e/chat-flow.e2e.test.ts",
        "--reporter=verbose",
        "--testNamePattern",
        "sends a chat turn through the GUI",
      ],
    ]);
    expect(commands.map((command) => command.timeoutMs)).toEqual([undefined, undefined]);
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.schemaVersion).toBe(2);
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]).toMatchObject({
      test: {
        kind: "playwright-test",
        id: "scenario-playwright",
        source: {
          path: "ui/src/e2e/chat-flow.e2e.test.ts",
        },
      },
      coverage: [
        {
          id: "ui.control",
          role: "primary",
        },
        {
          id: "ui.streaming",
          role: "secondary",
        },
      ],
      refs: [
        {
          kind: "docs",
          path: "docs/concepts/qa-e2e-automation.md",
        },
        {
          kind: "code",
          path: "ui/src/e2e/chat-flow.e2e.test.ts",
        },
      ],
      execution: {
        runner: "playwright",
        artifacts: [
          {
            kind: "log",
            path: ".artifacts/qa-e2e/scenario-playwright/scenario-playwright.log",
            source: "playwright",
          },
        ],
      },
      result: {
        status: "pass",
      },
    });
  });

  it("can return aggregate evidence without writing a duplicate evidence file", async () => {
    const repoRoot = await makeTempRepo("qa-playwright-memory-evidence-");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-playwright"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      scenarios: [makeTestFileScenario("playwright", "ui/src/e2e/chat-flow.e2e.test.ts")],
      writeEvidenceFile: false,
      runCommand: async () => ({
        exitCode: 0,
        stdout: "pass\n",
        stderr: "",
      }),
    });

    expect(result.evidence.entries).toHaveLength(1);
    await expect(fs.access(result.evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs Vitest scenarios with the declared test path and writes Vitest evidence", async () => {
    const repoRoot = await makeTempRepo("qa-vitest-scenario-");
    const commands: QaScenarioCommandExecution[] = [];
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-vitest"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      scenarios: [makeTestFileScenario("vitest", "extensions/qa-lab/src/coverage-report.test.ts")],
      runCommand: async (command) => {
        commands.push(command);
        return {
          exitCode: 1,
          stdout: "",
          stderr: "failed\n",
        };
      },
    });

    expect(result.executionKind).toBe("vitest");
    expect(commands.map((command) => command.args)).toEqual([
      [
        "scripts/run-vitest.mjs",
        "extensions/qa-lab/src/coverage-report.test.ts",
        "--reporter=verbose",
      ],
    ]);
    expect(commands.map((command) => command.timeoutMs)).toEqual([undefined]);
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.entries[0]).toMatchObject({
      test: {
        kind: "vitest-test",
        id: "scenario-vitest",
        source: {
          path: "extensions/qa-lab/src/coverage-report.test.ts",
        },
      },
      coverage: [
        {
          id: "qa.coverage",
          role: "primary",
        },
        {
          id: "qa.reporting",
          role: "secondary",
        },
      ],
      execution: {
        runner: "vitest",
        artifacts: [
          {
            kind: "log",
            path: ".artifacts/qa-e2e/scenario-vitest/scenario-vitest.log",
            source: "vitest",
          },
        ],
      },
      result: {
        status: "fail",
        failure: {
          reason: "node exited with 1",
        },
      },
    });
  });

  it("runs script scenarios and imports producer QA evidence artifacts", async () => {
    const repoRoot = await makeTempRepo("qa-script-scenario-");
    const commands: QaScenarioCommandExecution[] = [];
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async (command) => {
        commands.push(command);
        const scenarioArtifactBase = path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "scenario-script",
          "scenario-script",
        );
        const runRoot = path.join(scenarioArtifactBase, "run-1");
        await fs.mkdir(path.join(runRoot, "surfaces", "web-ui"), { recursive: true });
        await fs.writeFile(path.join(runRoot, "surfaces", "web-ui", "screenshot.png"), "png");
        await fs.writeFile(
          path.join(runRoot, "qa-evidence.json"),
          `${JSON.stringify(
            {
              kind: "openclaw.qa.evidence-summary",
              schemaVersion: 2,
              generatedAt: "2026-06-14T00:00:00.000Z",
              evidenceMode: "full",
              entries: [
                {
                  test: {
                    kind: "script-producer-check",
                    id: "script-producer.web-ui.smoke",
                    title: "Script producer: web-ui smoke",
                    source: { path: "scripts/evidence-producer.ts" },
                  },
                  coverage: [{ id: "ui.control", role: "primary" }],
                  execution: {
                    runner: "evidence-producer-script",
                    environment: {
                      ref: "scenario-ref",
                      os: "darwin",
                      nodeVersion: "v24.0.0",
                    },
                    provider: {
                      id: "script-producer",
                      live: false,
                      model: { name: null, ref: null },
                      fixture: "mocked-script-evidence",
                    },
                    packageSource: { kind: "source-checkout", sha: "abc123" },
                    artifacts: [
                      {
                        kind: "screenshot",
                        path: "surfaces/web-ui/screenshot.png",
                        source: "script-producer:web-ui:smoke",
                      },
                    ],
                  },
                  result: { status: "pass", timing: { wallMs: 1 } },
                },
              ],
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(scenarioArtifactBase, "latest-run.json"),
          `${JSON.stringify({ qaEvidence: path.join(runRoot, "qa-evidence.json") }, null, 2)}\n`,
          "utf8",
        );
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

    expect(result.executionKind).toBe("script");
    expect(commands.map((command) => command.args)).toEqual([
      [
        "--import",
        "tsx",
        "scripts/evidence-producer.ts",
        "--once",
        "--artifact-base",
        path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script", "scenario-script"),
      ],
    ]);
    expect(commands.map((command) => command.timeoutMs)).toEqual([30 * 60_000]);
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]).toMatchObject({
      test: {
        kind: "script-producer-check",
        id: "script-producer.web-ui.smoke",
      },
      coverage: [
        {
          id: "qa.coverage",
          role: "primary",
        },
        {
          id: "qa.reporting",
          role: "secondary",
        },
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
      result: {
        status: "pass",
      },
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
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
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

  describe.skipIf(process.platform === "win32")("script timeout process groups", () => {
    const commandTimeoutMs = 1_500;
    let descendantPid: number | undefined;
    let result: Awaited<ReturnType<typeof runQaTestFileScenarios>>;

    beforeAll(async () => {
      const tempRoot = await makeTempDir("qa-script-timeout-");
      const scriptPath = path.join(tempRoot, "hanging-producer.ts");
      const descendantPidPath = path.join(tempRoot, "descendant.pid");
      const descendantScript = [
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      await fs.writeFile(
        scriptPath,
        [
          "import { spawn } from 'node:child_process';",
          "import { writeFileSync } from 'node:fs';",
          `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' });`,
          `writeFileSync(${JSON.stringify(descendantPidPath)}, String(descendant.pid));`,
          "process.stdout.write('script still running\\n');",
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        "utf8",
      );

      qaTestFileScenarioRunnerTesting.setTimeoutCleanupTimings({
        forceSettleMs: 25,
        killGraceMs: 50,
      });
      const run = runQaTestFileScenarios({
        repoRoot: process.cwd(),
        outputDir: path.join(tempRoot, "out"),
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        scenarios: [makeTestFileScenario("script", scriptPath)],
        commandTimeoutMs,
      });
      descendantPid = await readPid(descendantPidPath, commandTimeoutMs);
      result = await run;
      await waitForDead(descendantPid, 2_000);
    });

    afterAll(() => {
      if (descendantPid !== undefined && isProcessRunning(descendantPid)) {
        process.kill(descendantPid, "SIGKILL");
      }
    });

    it("times out script scenarios and kills descendant process groups", () => {
      expect(result.results[0]?.status).toBe("fail");
      expect(result.results[0]?.failureMessage).toMatch(
        new RegExp(`timed out after ${commandTimeoutMs}ms`, "u"),
      );
      if (descendantPid === undefined) {
        throw new Error("descendant pid was not captured");
      }
      expect(isProcessRunning(descendantPid)).toBe(false);
    });
  });

  it("force-kills Windows scenario command trees when graceful taskkill fails", () => {
    const originalSystemRoot = process.env.SystemRoot;
    const originalWindir = process.env.WINDIR;
    process.env.SystemRoot = "C:\\Windows";
    delete process.env.WINDIR;
    const runTaskkill = vi
      .fn()
      .mockReturnValueOnce({ status: 1 })
      .mockReturnValueOnce({ status: 0 });

    try {
      expect(
        qaTestFileScenarioRunnerTesting.killQaScenarioWindowsProcessTree(
          12345,
          "SIGTERM",
          runTaskkill,
        ),
      ).toBe(true);
      const taskkillPath = path.win32.join("C:\\Windows", "System32", "taskkill.exe");
      expect(runTaskkill).toHaveBeenNthCalledWith(1, taskkillPath, ["/pid", "12345", "/T"], {
        stdio: "ignore",
        windowsHide: true,
      });
      expect(runTaskkill).toHaveBeenNthCalledWith(2, taskkillPath, ["/pid", "12345", "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } finally {
      if (originalSystemRoot === undefined) {
        delete process.env.SystemRoot;
      } else {
        process.env.SystemRoot = originalSystemRoot;
      }
      if (originalWindir === undefined) {
        delete process.env.WINDIR;
      } else {
        process.env.WINDIR = originalWindir;
      }
    }
  });

  it("fails script scenarios that exit cleanly after timeout termination", async () => {
    const repoRoot = process.cwd();
    const tempRoot = await makeTempDir("qa-script-timeout-clean-exit-");
    const scriptPath = path.join(tempRoot, "clean-exit-after-timeout.ts");
    await fs.writeFile(
      scriptPath,
      [
        "process.stdout.write('waiting for timeout\\n');",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );

    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(tempRoot, "out"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      scenarios: [makeTestFileScenario("script", scriptPath)],
      commandTimeoutMs: 100,
    });

    expect(result.results[0]?.status).toBe("fail");
    expect(result.results[0]?.failureMessage).toMatch(/timed out after 100ms/u);
  });

  it("imports producer QA evidence artifacts from failed script scenarios", async () => {
    const repoRoot = await makeTempRepo("qa-script-failed-scenario-");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script-failed"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async () => {
        const scenarioArtifactBase = path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "scenario-script-failed",
          "scenario-script",
        );
        const runRoot = path.join(scenarioArtifactBase, "run-1");
        await fs.mkdir(runRoot, { recursive: true });
        await fs.writeFile(
          path.join(runRoot, "qa-evidence.json"),
          `${JSON.stringify(
            {
              kind: "openclaw.qa.evidence-summary",
              schemaVersion: 2,
              generatedAt: "2026-06-14T00:00:00.000Z",
              evidenceMode: "full",
              entries: [
                {
                  test: {
                    kind: "script-producer-check",
                    id: "script-producer.web-ui.smoke",
                    title: "Script producer: web-ui smoke",
                    source: { path: "scripts/evidence-producer.ts" },
                  },
                  coverage: [{ id: "ui.control", role: "primary" }],
                  execution: {
                    runner: "evidence-producer-script",
                    environment: {
                      ref: "scenario-ref",
                      os: "darwin",
                      nodeVersion: "v24.0.0",
                    },
                    provider: {
                      id: "script-producer",
                      live: false,
                      model: { name: null, ref: null },
                      fixture: "failed-producer-evidence",
                    },
                    packageSource: { kind: "source-checkout", sha: "abc123" },
                    artifacts: [],
                  },
                  result: {
                    status: "fail",
                    failure: {
                      reason: "Script producer check failed.",
                    },
                    timing: { wallMs: 1 },
                  },
                },
              ],
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(scenarioArtifactBase, "latest-run.json"),
          `${JSON.stringify({ qaEvidence: path.join(runRoot, "qa-evidence.json") }, null, 2)}\n`,
          "utf8",
        );
        return {
          exitCode: 1,
          stdout: "",
          stderr: "script failed\n",
        };
      },
      env: {
        OPENCLAW_QA_REF: "scenario-ref",
      } as NodeJS.ProcessEnv,
    });

    expect(result.results[0]).toMatchObject({
      status: "fail",
      failureMessage: "node exited with 1",
      producerEvidence: {
        entries: [
          {
            test: {
              id: "script-producer.web-ui.smoke",
            },
            result: {
              status: "fail",
            },
          },
        ],
      },
    });
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.entries).toHaveLength(2);
    expect(evidence.entries[0]).toMatchObject({
      test: {
        kind: "script-producer-check",
        id: "script-producer.web-ui.smoke",
      },
      coverage: [
        { id: "qa.coverage", role: "primary" },
        { id: "qa.reporting", role: "secondary" },
      ],
      result: {
        status: "fail",
        failure: {
          reason: "Script producer check failed.",
        },
      },
    });
    expect(evidence.entries[1]).toMatchObject({
      test: {
        kind: "script-test",
        id: "scenario-script",
        source: {
          path: "scripts/evidence-producer.ts",
        },
      },
      result: {
        status: "fail",
        failure: {
          reason: "node exited with 1",
        },
      },
    });
  });

  it("fails script scenario results when imported producer evidence fails", async () => {
    const repoRoot = await makeTempRepo("qa-script-producer-fail-");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script-producer-fail"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async () => {
        const scenarioArtifactBase = path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "scenario-script-producer-fail",
          "scenario-script",
        );
        const runRoot = path.join(scenarioArtifactBase, "run-1");
        await fs.mkdir(runRoot, { recursive: true });
        await fs.writeFile(
          path.join(runRoot, "qa-evidence.json"),
          `${JSON.stringify(
            {
              kind: "openclaw.qa.evidence-summary",
              schemaVersion: 2,
              generatedAt: "2026-06-14T00:00:00.000Z",
              evidenceMode: "full",
              entries: [
                {
                  test: {
                    kind: "script-producer-check",
                    id: "script-producer.web-ui.smoke",
                    title: "Script producer: web-ui smoke",
                    source: { path: "scripts/evidence-producer.ts" },
                  },
                  coverage: [{ id: "ui.control", role: "primary" }],
                  execution: {
                    runner: "evidence-producer-script",
                    environment: {
                      ref: "scenario-ref",
                      os: "darwin",
                      nodeVersion: "v24.0.0",
                    },
                    provider: {
                      id: "script-producer",
                      live: false,
                      model: { name: null, ref: null },
                      fixture: "mocked-script-evidence",
                    },
                    packageSource: { kind: "source-checkout", sha: "abc123" },
                    artifacts: [],
                  },
                  result: {
                    status: "fail",
                    failure: {
                      reason: "Script producer check failed.",
                    },
                    timing: { wallMs: 1 },
                  },
                },
              ],
            },
            null,
            2,
          )}\n`,
          "utf8",
        );
        await fs.writeFile(
          path.join(scenarioArtifactBase, "latest-run.json"),
          `${JSON.stringify({ qaEvidence: path.join(runRoot, "qa-evidence.json") }, null, 2)}\n`,
          "utf8",
        );
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

    expect(result.results[0]).toMatchObject({
      status: "fail",
      failureMessage: "Script producer check failed.",
    });
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]).toMatchObject({
      test: {
        id: "script-producer.web-ui.smoke",
      },
      result: {
        status: "fail",
      },
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
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
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

  it("allows blocked imported producer evidence for opt-in script scenarios", async () => {
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
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
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
      status: "pass",
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

  it("carries the suite profile into merged producer evidence", async () => {
    const repoRoot = await makeTempRepo("qa-script-profile-");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script-profile"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async () => {
        const scenarioOutputDir = path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "scenario-script-profile",
          "scenario-script",
        );
        await fs.mkdir(scenarioOutputDir, { recursive: true });
        await fs.writeFile(
          path.join(scenarioOutputDir, "qa-evidence.json"),
          `${JSON.stringify({
            kind: "openclaw.qa.evidence-summary",
            schemaVersion: 2,
            generatedAt: "2026-06-14T00:00:00.000Z",
            evidenceMode: "full",
            entries: [
              {
                test: {
                  kind: "script-producer-check",
                  id: "script-producer.web-ui.smoke",
                  title: "Script producer: web-ui smoke",
                  source: { path: "scripts/evidence-producer.ts" },
                },
                coverage: [{ id: "ui.control", role: "primary" }],
                result: { status: "pass", timing: { wallMs: 1 } },
              },
            ],
          })}\n`,
          "utf8",
        );
        return { exitCode: 0, stdout: "script pass\n", stderr: "" };
      },
      env: {
        OPENCLAW_QA_REF: "scenario-ref",
        OPENCLAW_QA_PROFILE: "smoke-ci",
      } as NodeJS.ProcessEnv,
    });

    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.profile).toBe("smoke-ci");
  });

  it("keeps producer artifacts outside the repo root absolute instead of emitting ../ paths", async () => {
    const repoRoot = await makeTempRepo("qa-script-external-artifact-");
    const externalArtifact = path.join(os.tmpdir(), "qa-external-artifact.png");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-script-external"),
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      scenarios: [makeTestFileScenario("script", "scripts/evidence-producer.ts")],
      runCommand: async () => {
        const scenarioOutputDir = path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "scenario-script-external",
          "scenario-script",
        );
        await fs.mkdir(scenarioOutputDir, { recursive: true });
        await fs.writeFile(
          path.join(scenarioOutputDir, "qa-evidence.json"),
          `${JSON.stringify({
            kind: "openclaw.qa.evidence-summary",
            schemaVersion: 2,
            generatedAt: "2026-06-14T00:00:00.000Z",
            evidenceMode: "full",
            entries: [
              {
                test: {
                  kind: "script-producer-check",
                  id: "script-producer.web-ui.smoke",
                  title: "Script producer: web-ui smoke",
                  source: { path: "scripts/evidence-producer.ts" },
                },
                coverage: [{ id: "ui.control", role: "primary" }],
                execution: {
                  runner: "evidence-producer-script",
                  environment: { ref: "scenario-ref", os: "darwin", nodeVersion: "v24.0.0" },
                  provider: {
                    id: "script-producer",
                    live: false,
                    model: { name: null, ref: null },
                    fixture: "mocked-script-evidence",
                  },
                  packageSource: { kind: "source-checkout", sha: "abc123" },
                  artifacts: [
                    {
                      kind: "screenshot",
                      path: externalArtifact,
                      source: "script-producer:web-ui:smoke",
                    },
                  ],
                },
                result: { status: "pass", timing: { wallMs: 1 } },
              },
            ],
          })}\n`,
          "utf8",
        );
        return { exitCode: 0, stdout: "script pass\n", stderr: "" };
      },
      env: { OPENCLAW_QA_REF: "scenario-ref" } as NodeJS.ProcessEnv,
    });

    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    const artifactPath = evidence.entries[0]?.execution?.artifacts[0]?.path;
    expect(artifactPath).toBe(path.normalize(externalArtifact));
    expect(artifactPath?.includes("..")).toBe(false);
  });

  it("imports the standalone UX Matrix producer as coverage-free infrastructure", async () => {
    const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-ux-matrix-producer-"));
    tempRoots.push(outputDir);
    // The runner accepts scenario-shaped execution input, but this test fixture is not cataloged
    // and deliberately carries no product taxonomy coverage.
    const infrastructureFixture: QaSeedScenarioWithSource = {
      id: "scenario-script",
      title: "UX Matrix producer infrastructure fixture",
      surface: "qa-lab",
      objective: "Exercise the standalone UX Matrix evidence producer through the script runner.",
      successCriteria: ["The runner imports the producer's structured evidence bundle."],
      codeRefs: ["scripts/qa/ux-matrix-evidence-producer.ts"],
      sourcePath: "test/scripts/qa-ux-matrix-evidence-producer.test.ts",
      execution: {
        kind: "script",
        path: "scripts/qa/ux-matrix-evidence-producer.ts",
        allowBlockedEvidence: true,
        args: ["--artifact-base", "${outputDir}", "--skip-visual-proof"],
      },
    };

    const result = await runQaTestFileScenarios({
      repoRoot: process.cwd(),
      outputDir,
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      scenarios: [infrastructureFixture],
      env: { OPENCLAW_QA_REF: "infrastructure-fixture" } as NodeJS.ProcessEnv,
    });
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );

    expect(result.executionKind).toBe("script");
    expect(result.results[0]).toMatchObject({ status: "pass" });
    expect(result.results[0]?.producerEvidence?.entries).toHaveLength(3);
    expect(evidence.entries.map((entry) => entry.test.id)).toEqual([
      "ux-matrix.qa-lab.producer-artifact-fixture",
      "ux-matrix.control-ui.screenshot-artifact",
      "ux-matrix.cli.entrypoint-help",
    ]);
    expect(evidence.entries.every((entry) => entry.coverage.length === 0)).toBe(true);
    expect(
      evidence.entries.flatMap(
        (entry) => entry.execution?.artifacts.map((artifact) => artifact.kind) ?? [],
      ),
    ).toEqual(expect.arrayContaining(["html", "log"]));
    expect(
      evidence.entries
        .flatMap((entry) => entry.execution?.artifacts.map((artifact) => artifact.path) ?? [])
        .some((artifactPath) => artifactPath.includes(path.join(outputDir, "scenario-script"))),
    ).toBe(true);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
