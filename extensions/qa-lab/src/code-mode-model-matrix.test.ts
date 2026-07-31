// Code Mode model matrix tests cover repeatable small-model acceptance evidence.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyCodeModeMatrixCell,
  runCodeModeModelMatrix,
  validateQaEvidenceSummaryJson,
  type CodeModeMatrixCellResult,
} from "../../../scripts/code-mode-model-matrix.ts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Code Mode model matrix classification", () => {
  const successEnvelope = {
    ok: true,
    status: "ok",
    final: "CM-EXPECTED",
    payloads: [{ text: "CM-EXPECTED" }],
    codeModeEngaged: true,
    bridgeCalls: { search: 0, describe: 0, call: 1, sequence: ["read"] },
    toolSummary: { calls: 1, tools: ["exec"] },
    model: "qwen3.5:9b",
    provider: "ollama",
    sessionId: "session",
  } satisfies Parameters<typeof classifyCodeModeMatrixCell>[0]["envelope"];

  it("requires engagement, tool execution, effect, and exact final text", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: successEnvelope,
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }),
    ).toEqual({
      failureCategory: null,
      passed: true,
      oracle: {
        answer: true,
        effect: true,
        engagement: true,
        identity: true,
        toolExecution: true,
      },
    });
  });

  it("keeps provider failures distinct from model task failures", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "HTTP 402 payment required",
        effectPassed: false,
        envelope: {
          ...successEnvelope,
          ok: false,
          status: "error",
          final: "",
          error: { kind: "error_payload", message: "credits depleted" },
        },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }).failureCategory,
    ).toBe("provider_billing");
  });

  it("does not fail a successful run because diagnostics mention a recovered provider error", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "recovered after a transient network socket error",
        effectPassed: true,
        envelope: successEnvelope,
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }).failureCategory,
    ).toBeNull();
  });

  it("fails a successful envelope when JSON stdout has trailing output", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "unexpected stdout after JSON: noisy log",
        effectPassed: true,
        envelope: successEnvelope,
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        stdoutContractValid: false,
        task: "read",
      }).failureCategory,
    ).toBe("harness_error");
  });

  it("classifies a direct read with extra prose as an answer mismatch", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: { search: 0, describe: 0, call: 0 },
          codeModeEngaged: false,
          final: "The value is CM-EXPECTED.",
          toolSummary: { calls: 1, tools: ["read"], sequence: ["read"] },
        },
        expected: "CM-EXPECTED",
        mode: "direct",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }),
    ).toMatchObject({
      failureCategory: "answer_mismatch",
      oracle: { answer: false, toolExecution: true },
    });
  });

  it("requires outer tool-call evidence for direct and automatic cells", () => {
    for (const mode of ["direct", "auto"] as const) {
      expect(
        classifyCodeModeMatrixCell({
          diagnostics: "",
          effectPassed: true,
          envelope: {
            ...successEnvelope,
            codeModeEngaged: mode === "auto",
            toolSummary: { calls: 0, tools: [] },
          },
          expected: "CM-EXPECTED",
          mode,
          model: "ollama/qwen3.5:9b",
          task: "read",
        }).failureCategory,
      ).toBe("tool_execution");
    }
  });

  it("accepts nested or bounded native evidence when automatic Code Mode engages", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: { search: 1, describe: 1, call: 0 },
          codeModeEngaged: true,
          toolSummary: { calls: 1, tools: ["exec"] },
        },
        expected: "CM-EXPECTED",
        mode: "auto",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }),
    ).toMatchObject({
      failureCategory: "tool_execution",
      oracle: { toolExecution: false },
      passed: false,
    });
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: successEnvelope,
        expected: "CM-EXPECTED",
        mode: "auto",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }),
    ).toMatchObject({
      failureCategory: null,
      oracle: { toolExecution: true },
      passed: true,
    });
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: undefined,
          toolSummary: { calls: 1, tools: ["read"], sequence: ["read"] },
        },
        expected: "CM-EXPECTED",
        mode: "auto",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }),
    ).toMatchObject({
      failureCategory: null,
      oracle: { toolExecution: true },
      passed: true,
    });
  });

  it("requires the task's ordered direct tool sequence", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: undefined,
          codeModeEngaged: false,
          toolSummary: {
            calls: 3,
            tools: ["read", "write"],
            sequence: ["read", "read", "write"],
          },
        },
        expected: "CM-EXPECTED",
        mode: "direct",
        model: "ollama/qwen3.5:9b",
        task: "dependent-read-write",
      }),
    ).toMatchObject({
      failureCategory: "tool_execution",
      oracle: { toolExecution: false },
      passed: false,
    });
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: undefined,
          codeModeEngaged: false,
          toolSummary: {
            calls: 3,
            tools: ["read", "write"],
            sequence: ["read", "write", "read"],
          },
        },
        expected: "CM-EXPECTED",
        mode: "direct",
        model: "ollama/qwen3.5:9b",
        task: "dependent-read-write",
      }),
    ).toMatchObject({
      failureCategory: null,
      oracle: { toolExecution: true },
      passed: true,
    });
  });

  it("rejects otherwise complete direct and bridge sequences with tool failures", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: undefined,
          codeModeEngaged: false,
          toolSummary: {
            calls: 3,
            tools: ["read", "write"],
            sequence: ["read", "write", "read"],
            failures: 1,
          },
        },
        expected: "CM-EXPECTED",
        mode: "direct",
        model: "ollama/qwen3.5:9b",
        task: "dependent-read-write",
      }),
    ).toMatchObject({
      failureCategory: "tool_execution",
      oracle: { toolExecution: false },
      passed: false,
    });
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: {
            search: 0,
            describe: 0,
            call: 3,
            sequence: ["read", "write", "read"],
            failures: 1,
          },
        },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "dependent-read-write",
      }),
    ).toMatchObject({
      failureCategory: "tool_execution",
      oracle: { toolExecution: false },
      passed: false,
    });
  });

  it("requires ordered bridge or bounded native evidence for forced Code Mode", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: { search: 1, describe: 1, call: 0 },
          toolSummary: { calls: 1, tools: ["exec"] },
        },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }).failureCategory,
    ).toBe("tool_execution");
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: undefined,
          toolSummary: { calls: 1, tools: ["read"], sequence: ["read"] },
        },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }).failureCategory,
    ).toBeNull();
  });

  it("rejects ambiguous mixed ordering across multiple bridge boundaries", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: { search: 0, describe: 0, call: 2, sequence: ["read", "read"] },
          toolSummary: {
            calls: 3,
            tools: ["exec", "edit"],
            sequence: ["exec", "edit", "exec"],
          },
        },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "edit-readback",
      }),
    ).toMatchObject({
      failureCategory: "tool_execution",
      oracle: { toolExecution: false },
      passed: false,
    });
  });

  it("requires every nested step in the dependent read-write-read scenario", () => {
    const base = {
      ...successEnvelope,
      bridgeCalls: {
        search: 0,
        describe: 0,
        call: 3,
        sequence: ["read", "write", "read"],
      },
      toolSummary: { calls: 2, tools: ["exec"] },
    };
    const classify = (sequence: string[]) =>
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...base,
          bridgeCalls: { search: 0, describe: 0, call: sequence.length, sequence },
        },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "dependent-read-write",
      });

    expect(classify(["read", "write"])).toMatchObject({
      failureCategory: "tool_execution",
      oracle: { toolExecution: false },
      passed: false,
    });
    expect(classify(["read", "read", "write"])).toMatchObject({
      failureCategory: "tool_execution",
      oracle: { toolExecution: false },
      passed: false,
    });
    expect(classify(["search", "read", "write", "read"])).toMatchObject({
      failureCategory: null,
      oracle: { toolExecution: true },
      passed: true,
    });
  });

  it("requires both reads in the two-file scenario", () => {
    const classify = (sequence: string[]) =>
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: { search: 0, describe: 0, call: sequence.length, sequence },
        },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "read-two-files",
      });

    expect(classify(["read"])).toMatchObject({
      failureCategory: "tool_execution",
      passed: false,
    });
    expect(classify(["read", "read"])).toMatchObject({
      failureCategory: null,
      passed: true,
    });
  });

  it("requires edit plus read-back in the edit scenario", () => {
    const classify = (sequence: string[]) =>
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: { search: 0, describe: 0, call: sequence.length, sequence },
        },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "edit-readback",
      });

    expect(classify(["read", "edit"])).toMatchObject({
      failureCategory: "tool_execution",
      passed: false,
    });
    expect(classify(["read", "edit", "read"])).toMatchObject({
      failureCategory: null,
      passed: true,
    });
  });

  it("rejects forced Code Mode runs that never engaged", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: { ...successEnvelope, codeModeEngaged: false },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }).failureCategory,
    ).toBe("activation");
  });

  it("rejects a successful response from a different model route", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: { ...successEnvelope, model: "fallback-model" },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }).failureCategory,
    ).toBe("model_mismatch");
  });

  it("reports an agent error before evaluating missing activation metadata", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: false,
        envelope: {
          ...successEnvelope,
          ok: false,
          status: "error",
          final: "",
          codeModeEngaged: undefined,
          error: { kind: "agent_error", message: "run failed" },
        },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }).failureCategory,
    ).toBe("agent_error");
  });
});

describe("Code Mode model matrix artifacts", () => {
  it("keeps repetitions contiguous within each model, mode, and task cohort", async () => {
    const repoRoot = tempDirs.make("openclaw-code-mode-order-test-");
    try {
      const result = await runCodeModeModelMatrix(
        {
          allowFailures: false,
          dryRun: true,
          keepState: false,
          models: ["ollama/first", "ollama/second"],
          modes: ["direct", "code"],
          outputDir: "artifacts",
          repetitions: 2,
          repoRoot,
          tasks: ["read", "edit-readback"],
          thinking: "off",
          timeoutSeconds: 10,
        },
        {
          readSourceIdentity: async () => ({
            gitSha: "abc123",
            sourceDirty: false,
            sourcePatchSha256: null,
          }),
        },
      );

      expect(result.exitCode).toBe(0);
      const manifest = JSON.parse(
        await fs.readFile(path.join(repoRoot, "artifacts", "manifest.json"), "utf8"),
      ) as { cells: string[] };
      expect(manifest.cells).toEqual([
        "ollama-first-de6aa7a784-direct-read-1",
        "ollama-first-de6aa7a784-direct-read-2",
        "ollama-first-de6aa7a784-direct-edit-readback-1",
        "ollama-first-de6aa7a784-direct-edit-readback-2",
        "ollama-first-de6aa7a784-code-read-1",
        "ollama-first-de6aa7a784-code-read-2",
        "ollama-first-de6aa7a784-code-edit-readback-1",
        "ollama-first-de6aa7a784-code-edit-readback-2",
        "ollama-second-18cc17809a-direct-read-1",
        "ollama-second-18cc17809a-direct-read-2",
        "ollama-second-18cc17809a-direct-edit-readback-1",
        "ollama-second-18cc17809a-direct-edit-readback-2",
        "ollama-second-18cc17809a-code-read-1",
        "ollama-second-18cc17809a-code-read-2",
        "ollama-second-18cc17809a-code-edit-readback-1",
        "ollama-second-18cc17809a-code-edit-readback-2",
      ]);
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("builds and records identity from an external product checkout", async () => {
    const repoRoot = tempDirs.make("openclaw-code-mode-harness-test-");
    const targetRoot = tempDirs.make("openclaw-code-mode-target-test-");
    try {
      await fs.mkdir(path.join(repoRoot, "packages"));
      await fs.mkdir(path.join(targetRoot, "packages"));
      const buildRoots: string[] = [];
      const result = await runCodeModeModelMatrix(
        {
          allowFailures: false,
          dryRun: false,
          keepState: false,
          models: ["ollama/qwen3.5:9b"],
          modes: ["code"],
          outputDir: "artifacts",
          repetitions: 1,
          repoRoot,
          targetRoot,
          tasks: ["read"],
          thinking: "off",
          timeoutSeconds: 10,
        },
        {
          buildCliArtifacts: async (root) => {
            buildRoots.push(root);
          },
          readBuildSha256: async (root) => {
            expect(root).toBe(targetRoot);
            return "build123";
          },
          readSourceIdentity: async (root) => {
            expect(root).toBe(targetRoot);
            return {
              gitSha: "target123",
              sourceDirty: false,
              sourcePatchSha256: null,
            };
          },
          runCell: async ({ cell, gitSha }) => ({
            buildSha256: "build123",
            bridgeCalls: { search: 0, describe: 0, call: 1, sequence: ["read"] },
            codeModeEngaged: true,
            elapsedMs: 10,
            executionTransport: "bridge",
            expected: "CM-EXPECTED",
            failureCategory: null,
            final: "CM-EXPECTED",
            gitSha,
            id: cell.id,
            mode: cell.mode,
            model: cell.model,
            observedModel: "qwen3.5:9b",
            observedProvider: "ollama",
            oracle: {
              answer: true,
              effect: true,
              engagement: true,
              identity: true,
              toolExecution: true,
            },
            passed: true,
            repetition: cell.repetition,
            sourceDirty: false,
            sourcePatchSha256: null,
            status: "ok",
            task: cell.task,
            timestamp: "2026-07-30T00:00:00.000Z",
            toolSummary: { calls: 1, tools: ["exec"] },
          }),
        },
      );

      expect(result.exitCode).toBe(0);
      expect(buildRoots).toEqual([targetRoot]);
      await expect(
        fs.readFile(path.join(repoRoot, "artifacts", "manifest.json"), "utf8").then(JSON.parse),
      ).resolves.toMatchObject({
        gitSha: "target123",
        target: "external",
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
      await fs.rm(targetRoot, { force: true, recursive: true });
    }
  });

  it("rejects output inside Git metadata", async () => {
    const repoRoot = tempDirs.make("openclaw-code-mode-git-test-");
    try {
      await fs.mkdir(path.join(repoRoot, ".git"));
      await expect(
        runCodeModeModelMatrix(
          {
            allowFailures: false,
            dryRun: true,
            keepState: false,
            models: ["ollama/qwen3.5:9b"],
            modes: ["code"],
            outputDir: path.join(".git", "refs", "evidence"),
            repetitions: 1,
            repoRoot,
            tasks: ["read"],
            thinking: "off",
            timeoutSeconds: 10,
          },
          {
            readSourceIdentity: async () => ({
              gitSha: "abc123",
              sourceDirty: false,
              sourcePatchSha256: null,
            }),
          },
        ),
      ).rejects.toThrow("must not overlap Git metadata");
      await expect(fs.access(path.join(repoRoot, ".git", "refs"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("rejects case aliases of missing runtime artifacts", async () => {
    const repoRoot = tempDirs.make("openclaw-code-mode-case-test-");
    try {
      const canonicalRoot = await fs.realpath(repoRoot);
      const rootName = path.basename(canonicalRoot);
      const letterIndex = rootName.search(/[a-z]/iu);
      const letter = rootName[letterIndex] ?? "";
      const alternateLetter =
        letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase();
      const alternateRoot = path.join(
        path.dirname(canonicalRoot),
        `${rootName.slice(0, letterIndex)}${alternateLetter}${rootName.slice(letterIndex + 1)}`,
      );
      const caseInsensitive = await fs.realpath(alternateRoot).then(
        (resolved) => resolved === canonicalRoot,
        () => false,
      );
      if (!caseInsensitive) {
        return;
      }

      await expect(
        runCodeModeModelMatrix(
          {
            allowFailures: false,
            dryRun: true,
            keepState: false,
            models: ["ollama/qwen3.5:9b"],
            modes: ["code"],
            outputDir: path.join("DIST", "evidence"),
            repetitions: 1,
            repoRoot,
            tasks: ["read"],
            thinking: "off",
            timeoutSeconds: 10,
          },
          {
            readSourceIdentity: async () => ({
              gitSha: "abc123",
              sourceDirty: false,
              sourcePatchSha256: null,
            }),
          },
        ),
      ).rejects.toThrow("must not overlap runtime artifacts");
      await expect(fs.access(path.join(repoRoot, "DIST", "evidence"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("rejects package artifact namespaces before reservation creates them", async () => {
    const repoRoot = tempDirs.make("openclaw-code-mode-package-test-");
    try {
      await fs.mkdir(path.join(repoRoot, "packages"));
      await expect(
        runCodeModeModelMatrix(
          {
            allowFailures: false,
            dryRun: true,
            keepState: false,
            models: ["ollama/qwen3.5:9b"],
            modes: ["code"],
            outputDir: path.join("packages", "new-package", "dist", "evidence"),
            repetitions: 1,
            repoRoot,
            tasks: ["read"],
            thinking: "off",
            timeoutSeconds: 10,
          },
          {
            readSourceIdentity: async () => ({
              gitSha: "abc123",
              sourceDirty: false,
              sourcePatchSha256: null,
            }),
          },
        ),
      ).rejects.toThrow("must not overlap runtime artifacts");
      await expect(fs.access(path.join(repoRoot, "packages", "new-package"))).rejects.toMatchObject(
        {
          code: "ENOENT",
        },
      );
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it.each(["dist", path.join("packages", "agent-core", "dist")])(
    "rejects output inside build-created runtime artifacts: %s",
    async (artifactDir) => {
      const repoRoot = tempDirs.make("openclaw-code-mode-build-test-");
      let hashed = false;
      try {
        await expect(
          runCodeModeModelMatrix(
            {
              allowFailures: false,
              dryRun: false,
              keepState: false,
              models: ["ollama/qwen3.5:9b"],
              modes: ["code"],
              outputDir: path.join(artifactDir, "evidence"),
              repetitions: 1,
              repoRoot,
              tasks: ["read"],
              thinking: "off",
              timeoutSeconds: 10,
            },
            {
              buildCliArtifacts: async () => {
                await fs.mkdir(path.join(repoRoot, artifactDir), { recursive: true });
              },
              readBuildSha256: async () => {
                hashed = true;
                return "build123";
              },
              readSourceIdentity: async () => ({
                gitSha: "abc123",
                sourceDirty: false,
                sourcePatchSha256: null,
              }),
            },
          ),
        ).rejects.toThrow("must not overlap runtime artifacts");
        expect(hashed).toBe(false);
        await expect(fs.access(path.join(repoRoot, artifactDir, "evidence"))).rejects.toMatchObject(
          {
            code: "ENOENT",
          },
        );
      } finally {
        await fs.rm(repoRoot, { force: true, recursive: true });
      }
    },
  );

  it("continues after cell crashes and reports first-repetition versus any success", async () => {
    const repoRoot = tempDirs.make("openclaw-code-mode-matrix-test-");
    try {
      let calls = 0;
      const result = await runCodeModeModelMatrix(
        {
          allowFailures: false,
          dryRun: false,
          keepState: false,
          models: ["ollama/qwen3.5:9b"],
          modes: ["code"],
          outputDir: "artifacts",
          repetitions: 2,
          repoRoot,
          tasks: ["read"],
          thinking: "off",
          timeoutSeconds: 10,
        },
        {
          buildCliArtifacts: async () => {},
          now: () => new Date("2026-07-28T12:00:00Z"),
          readBuildSha256: async () => {
            const entries = await fs.readdir(path.join(repoRoot, "artifacts"));
            expect(entries).toEqual([]);
            return "build123";
          },
          readGitSha: async () => "abc123",
          runCell: async ({ cell, gitSha }) => {
            calls += 1;
            if (cell.repetition === 1) {
              throw new Error("fixture exploded");
            }
            return {
              buildSha256: "build123",
              bridgeCalls: { search: 0, describe: 0, call: 1 },
              codeModeEngaged: true,
              elapsedMs: 10,
              executionTransport: "bridge",
              expected: "CM-EXPECTED",
              failureCategory: null,
              final: "CM-EXPECTED",
              gitSha,
              id: cell.id,
              mode: cell.mode,
              model: cell.model,
              observedModel: "qwen3.5:9b",
              observedProvider: "ollama",
              oracle: {
                answer: true,
                effect: true,
                engagement: true,
                identity: true,
                toolExecution: true,
              },
              passed: true,
              repetition: cell.repetition,
              sourceDirty: false,
              sourcePatchSha256: null,
              status: "ok",
              task: cell.task,
              timestamp: "2026-07-28T12:00:00.000Z",
              toolSummary: { calls: 1, tools: ["exec"] },
            } satisfies CodeModeMatrixCellResult;
          },
        },
      );

      expect(calls).toBe(2);
      expect(result.exitCode).toBe(1);
      const summary = JSON.parse(
        await fs.readFile(path.join(repoRoot, "artifacts", "summary.json"), "utf8"),
      ) as {
        counts: { total: number; passed: number; failed: number };
        groupCounts: {
          total: number;
          firstRepetitionPassed: number;
          anyRepetitionPassed: number;
          toolFailureFreePassed: number;
        };
        groups: Array<{
          firstRepetitionPassed: boolean;
          anyRepetitionPassed: boolean;
        }>;
      };
      expect(summary.counts).toEqual({ total: 2, passed: 1, failed: 1 });
      expect(summary.groupCounts).toEqual({
        total: 1,
        firstRepetitionPassed: 0,
        anyRepetitionPassed: 1,
        toolFailureFreePassed: 0,
      });
      expect(summary.groups).toMatchObject([
        { firstRepetitionPassed: false, anyRepetitionPassed: true },
      ]);
      const lines = (await fs.readFile(path.join(repoRoot, "artifacts", "results.jsonl"), "utf8"))
        .trim()
        .split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        failureCategory: "harness_error",
        error: { kind: "harness_error", message: "fixture exploded" },
      });
      const evidence = validateQaEvidenceSummaryJson(
        JSON.parse(await fs.readFile(path.join(repoRoot, "artifacts", "qa-evidence.json"), "utf8")),
      );
      expect(evidence.entries).toHaveLength(2);
      expect(evidence.entries[0]).toMatchObject({
        test: {
          kind: "script-test",
          source: { path: "scripts/code-mode-model-matrix.ts" },
        },
        execution: {
          provider: {
            id: "ollama",
            model: { name: "qwen3.5:9b", ref: "ollama/qwen3.5:9b" },
          },
          artifacts: [
            { kind: "manifest", path: "manifest.json" },
            { kind: "summary", path: "summary.json" },
            { kind: "results", path: "results.jsonl" },
          ],
        },
        result: {
          status: "fail",
          failure: { class: "harness_error", reason: "harness_error" },
        },
      });
      expect(evidence.entries[1]).toMatchObject({
        result: { status: "pass", timing: { wallMs: 10 } },
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });
});
