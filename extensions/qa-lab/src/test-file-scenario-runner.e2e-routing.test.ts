// QA native Vitest scenarios must select the configuration that owns E2E files.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import {
  runQaTestFileScenarios,
  type QaScenarioCommandExecution,
} from "./test-file-scenario-runner.js";

describe("QA native Vitest scenario routing", () => {
  it("runs E2E test scenarios under the existing Gateway E2E configuration", async () => {
    const repoRoot = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-qa-vitest-e2e-routing-")),
    );
    const commands: QaScenarioCommandExecution[] = [];
    const testPath = "extensions/ollama/src/node-inference.paired-node.e2e.test.ts";
    const scenario: QaSeedScenarioWithSource = {
      id: "ollama-paired-node-inference",
      title: "Ollama paired-node inference",
      surface: "models",
      category: "agent-runtime.local-and-self-hosted-providers",
      coverage: { primary: [], secondary: ["gateway.remote-host-commands"] },
      objective: "Run local inference through an authenticated paired Gateway node.",
      successCriteria: ["The real Gateway routes inference to its paired node."],
      docsRefs: ["docs/providers/ollama.md"],
      codeRefs: [testPath],
      sourcePath: "qa/scenarios/models/ollama-paired-node-inference.yaml",
      execution: { kind: "vitest", path: testPath },
    };

    try {
      const requestedTestFile = path.join(repoRoot, testPath);
      await fs.mkdir(path.dirname(requestedTestFile), { recursive: true });
      await fs.writeFile(requestedTestFile, "// native scenario fixture\n", "utf8");
      const result = await runQaTestFileScenarios({
        repoRoot,
        outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", scenario.id),
        providerMode: "mock-openai",
        primaryModel: "mock-openai/gpt-5.6-luna",
        scenarios: [scenario],
        runCommand: async (command) => {
          commands.push(command);
          const reportArg = command.args.find((arg) => arg.startsWith("--outputFile.json="));
          if (!reportArg) {
            throw new Error("native Vitest scenario did not request a JSON test report");
          }
          await fs.writeFile(
            reportArg.slice("--outputFile.json=".length),
            JSON.stringify({
              numFailedTests: 0,
              numPassedTests: 1,
              success: true,
              testResults: [
                {
                  name: path.join(repoRoot, testPath),
                  status: "passed",
                  assertionResults: [{ fullName: "runs paired node inference", status: "passed" }],
                },
              ],
            }),
            "utf8",
          );
          return { exitCode: 0, stdout: "1 passed\n", stderr: "" };
        },
      });

      expect(result.executionKind).toBe("vitest");
      expect(result.results).toMatchObject([{ status: "pass" }]);
      expect(result.evidence.entries[0]?.result.status).toBe("pass");
      expect(commands.map((command) => command.args)).toEqual([
        [
          "scripts/run-vitest.mjs",
          "run",
          "--config",
          "test/vitest/vitest.e2e.config.ts",
          testPath,
          "--reporter=verbose",
          "--reporter=json",
          `--outputFile.json=${path.join(
            repoRoot,
            ".artifacts",
            "qa-e2e",
            scenario.id,
            `${scenario.id}.vitest-report.json`,
          )}`,
        ],
      ]);
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});
