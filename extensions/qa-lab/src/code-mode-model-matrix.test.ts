// Code Mode model matrix tests cover repeatable small-model acceptance evidence.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodeModeMatrixAgentEnv,
  classifyCodeModeMatrixCell,
  modelCellPrefix,
  parseCodeModeMatrixOptions,
  reserveCodeModeMatrixOutputDir,
  resolveCodeModeMatrixOutputDir,
  runCodeModeModelMatrix,
  validateQaEvidenceSummaryJson,
  type CodeModeMatrixCellResult,
  type CodeModeMatrixTask,
} from "../../../scripts/code-mode-model-matrix.ts";

const extendedTasks = [
  "large-result-reduction",
  "parallel-independent-reads",
  "dependent-chain",
] as const satisfies readonly CodeModeMatrixTask[];

// A synthetic CLI, not a model or Code Mode runtime: exercise the real runner's
// fixture preparation, process envelope, effect oracle, and artifact projection.
// It consumes only task files/arguments; no provider imports or credentials.
const fixtureCli = String.raw`
import fs from "node:fs/promises";
import path from "node:path";
const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const workspace = option("--cwd");
const prompt = process.argv[4];
let calls = 0;
const read = async (name) => {
  calls++;
  return await fs.readFile(path.join(workspace, name), "utf8");
};
const readJson = async (name) => JSON.parse(await read(name));
let answer;
if (prompt.includes("orders.jsonl")) {
  const rules = await readJson("rules.json");
  const orders = await read("orders.jsonl");
  if (Buffer.byteLength(orders) <= 65536 || Buffer.byteLength(orders) > 131072) {
    throw new Error("reduction fixture must require bounded large-result handling");
  }
  let count = 0;
  let sum = 0;
  for (const line of orders.trim().split("\n")) {
    const order = JSON.parse(line);
    if (order.region !== rules.region || order.units < rules.minUnits) continue;
    count++;
    sum += order.units * order.unitPriceCents;
  }
  answer = [rules.verificationCode, count, sum].join(":");
} else if (prompt.includes("north.json")) {
  const values = await Promise.all(["north.json", "south.json", "west.json"].map(readJson));
  answer = values.map((entry) => entry.value).join("|");
} else if (prompt.includes("start.json")) {
  const start = await readJson("start.json");
  const route = await readJson(start.next);
  answer = (await readJson(route.next)).value;
} else {
  throw new Error("unsupported fixture prompt");
}
if (option("--thinking") !== "missing-effect") {
  await fs.writeFile(path.join(workspace, "result.txt"), answer);
  calls++;
  if (await read("result.txt") !== answer) throw new Error("readback mismatch");
}
const engaged = option("--code-mode") === "code";
const [provider, model] = option("--model").split("/");
console.log(JSON.stringify({
  ok: true, status: "ok", final: option("--thinking") === "wrong-answer" ? "wrong" : answer,
  payloads: [], model, provider, sessionId: "fixture-only", codeModeEngaged: engaged,
  assistantTurns: 2,
  ...(engaged ? { bridgeCalls: { search: 0, describe: 0, call: calls } } : {}),
  toolSummary: { calls: engaged ? 1 : calls, tools: engaged ? ["exec"] : ["read", "write"] }
}));
`;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Code Mode model matrix options", () => {
  it("defaults to the complete bounded matrix", () => {
    expect(parseCodeModeMatrixOptions(["--model", "ollama/qwen3.5:9b"], "/repo")).toMatchObject({
      models: ["ollama/qwen3.5:9b"],
      modes: ["direct", "auto", "code"],
      tasks: ["read", "dependent-read-write"],
      repetitions: 3,
      timeoutSeconds: 180,
      thinking: "off",
      repoRoot: "/repo",
    });
  });

  it("rejects invalid and duplicate extended task selectors", () => {
    for (const tasks of [["unknown"], ["dependent-chain", "dependent-chain"]]) {
      expect(() =>
        parseCodeModeMatrixOptions([
          "--model",
          "fixture/model",
          ...tasks.flatMap((task) => ["--task", task]),
        ]),
      ).toThrow(tasks.length === 1 ? "--task must be one of" : "Duplicate --task");
    }
  });

  it("rejects ambiguous selectors and output paths", () => {
    expect(() => parseCodeModeMatrixOptions([])).toThrow("At least one --model");
    expect(() => parseCodeModeMatrixOptions(["--model", "qwen3.5:9b"])).toThrow("provider/model");
    expect(() =>
      parseCodeModeMatrixOptions(["--model", "ollama/qwen3.5:9b", "--skip-build"]),
    ).toThrow("Unknown argument");
    expect(() =>
      parseCodeModeMatrixOptions([
        "--model",
        "ollama/qwen3.5:9b",
        "--mode",
        "code",
        "--mode",
        "code",
      ]),
    ).toThrow("Duplicate --mode");
    expect(() =>
      resolveCodeModeMatrixOutputDir("/repo", "../outside", new Date("2026-07-28T12:00:00Z")),
    ).toThrow("within the repository");
    expect(() =>
      resolveCodeModeMatrixOutputDir("/repo", "/tmp/out", new Date("2026-07-28T12:00:00Z")),
    ).toThrow("repo-relative");
    expect(() =>
      resolveCodeModeMatrixOutputDir("/repo", ".", new Date("2026-07-28T12:00:00Z")),
    ).toThrow("within the repository");
  });

  it("reserves a fresh output path without symlink traversal", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-output-test-"));
    try {
      const existing = path.join(repoRoot, "existing");
      await fs.mkdir(existing);
      await expect(reserveCodeModeMatrixOutputDir(repoRoot, existing)).rejects.toThrow(
        "must not already exist",
      );

      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-outside-test-"));
      const linked = path.join(repoRoot, "linked");
      await fs.symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
      await expect(
        reserveCodeModeMatrixOutputDir(repoRoot, path.join(linked, "results")),
      ).rejects.toThrow("must not traverse symlinks");
      await fs.rm(outside, { force: true, recursive: true });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("allows only one concurrent run to reserve an output path", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-reserve-test-"));
    try {
      const outputDir = path.join(repoRoot, "nested", "results");
      const attempts = await Promise.allSettled([
        reserveCodeModeMatrixOutputDir(repoRoot, outputDir),
        reserveCodeModeMatrixOutputDir(repoRoot, outputDir),
      ]);

      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      const rejected = attempts.find((attempt) => attempt.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining("must not already exist"),
        }),
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });
});

describe("Code Mode model matrix provider setup", () => {
  it("adds the documented non-secret marker only for local Ollama runs", () => {
    expect(buildCodeModeMatrixAgentEnv("ollama/qwen3.5:9b", "/runtime", {})).toMatchObject({
      NODE_DISABLE_COMPILE_CACHE: "1",
      OLLAMA_API_KEY: "ollama-local",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join("/runtime", "dist", "extensions"),
    });
    expect(
      buildCodeModeMatrixAgentEnv("ollama/qwen3.5:9b", "/runtime", {
        OLLAMA_API_KEY: "configured-value",
      }).OLLAMA_API_KEY,
    ).toBe("configured-value");
    expect(buildCodeModeMatrixAgentEnv("huggingface/model", "/runtime", {}).OLLAMA_API_KEY).toBe(
      undefined,
    );
  });
});

describe("Code Mode model matrix identity", () => {
  it("keeps punctuation variants distinct", () => {
    expect(modelCellPrefix("ollama/foo.bar")).not.toBe(modelCellPrefix("ollama/foo-bar"));
  });
});

describe("Code Mode model matrix classification", () => {
  const successEnvelope = {
    ok: true,
    status: "ok",
    final: "CM-EXPECTED",
    payloads: [{ text: "CM-EXPECTED" }],
    codeModeEngaged: true,
    bridgeCalls: { search: 0, describe: 0, call: 1 },
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

  it("uses outer tool-call evidence for automatic cells that engage Code Mode", () => {
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
      failureCategory: null,
      oracle: { toolExecution: true },
      passed: true,
    });
  });

  it("keeps nested bridge-call evidence mandatory for forced Code Mode", () => {
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

describe("Code Mode model matrix extended fixtures", () => {
  it.each([
    ["off", null],
    ["wrong-answer", "answer_mismatch"],
    ["missing-effect", "effect_mismatch"],
  ] as const)(
    "runs task fixtures through the process/evidence boundary: %s",
    async (thinking, failureCategory) => {
      const repoRoot = tempDirs.make("openclaw-matrix-fixtures-");
      await fs.mkdir(path.join(repoRoot, "dist"));
      await fs.mkdir(path.join(repoRoot, "node_modules"));
      await fs.writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ type: "module" }));
      await fs.writeFile(path.join(repoRoot, "dist", "entry.js"), fixtureCli);
      const options = parseCodeModeMatrixOptions(
        [
          "--model",
          "fixture/model",
          "--repetitions",
          "1",
          "--keep-state",
          "--mode",
          "code",
          ...(failureCategory ? [] : ["--mode", "direct"]),
          ...extendedTasks.flatMap((task) => ["--task", task]),
          "--thinking",
          thinking,
          "--output-dir",
          "artifacts",
        ],
        repoRoot,
      );
      const result = await runCodeModeModelMatrix(options, {
        buildCliArtifacts: async () => {},
        readBuildSha256: async () => "fixture-build",
        readGitSha: async () => "fixture-source",
      });
      const readArtifact = async (name: string) =>
        await fs.readFile(path.join(result.outputDir, name), "utf8");
      const rows = (await readArtifact("results.jsonl"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as CodeModeMatrixCellResult);
      expect(result.exitCode).toBe(failureCategory ? 1 : 0);
      expect(rows).toHaveLength(failureCategory ? 3 : 6);
      expect(JSON.parse(await readArtifact("manifest.json"))).toMatchObject({
        tasks: extendedTasks,
        cells: rows.map((row) => row.id),
      });
      for (const row of rows) {
        expect(row).toMatchObject({
          failureCategory,
          passed: failureCategory === null,
          assistantTurns: 2,
          oracle: {
            answer: thinking !== "wrong-answer",
            effect: thinking !== "missing-effect",
            engagement: true,
            identity: true,
            toolExecution: true,
          },
        });
        expect(row.elapsedMs).toBeGreaterThanOrEqual(0);
        const workspace = path.join(result.outputDir, "state", row.id, "workspace");
        if (thinking === "missing-effect") {
          await expect(fs.access(path.join(workspace, "result.txt"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        } else {
          expect(await fs.readFile(path.join(workspace, "result.txt"), "utf8")).toBe(row.expected);
        }
        if (row.mode === "direct") {
          const codeRow = rows.find(
            (candidate) => candidate.task === row.task && candidate.mode === "code",
          )!;
          expect(row.expected).toBe(codeRow.expected);
          expect(row.bridgeCalls).toBeUndefined();
          const codeWorkspace = path.join(result.outputDir, "state", codeRow.id, "workspace");
          for (const name of await fs.readdir(workspace)) {
            expect(await fs.readFile(path.join(workspace, name), "utf8")).toBe(
              await fs.readFile(path.join(codeWorkspace, name), "utf8"),
            );
          }
        }
      }
      const evidence = validateQaEvidenceSummaryJson(
        JSON.parse(await readArtifact("qa-evidence.json")),
      );
      expect(evidence.entries).toHaveLength(rows.length);
      evidence.entries.forEach((entry, index) => {
        expect(entry.result).toMatchObject({
          status: failureCategory ? "fail" : "pass",
          timing: { wallMs: Math.max(1, rows[index]!.elapsedMs) },
        });
        if (failureCategory) {
          expect(entry.result.failure?.class).toBe(failureCategory);
        }
      });
    },
  );

  it("plans extended tasks without building, executing, or fabricating passing evidence", async () => {
    const repoRoot = tempDirs.make("openclaw-matrix-plan-");
    const options = parseCodeModeMatrixOptions(
      [
        "--model",
        "fixture/model",
        "--mode",
        "code",
        "--repetitions",
        "1",
        "--dry-run",
        ...extendedTasks.flatMap((task) => ["--task", task]),
      ],
      repoRoot,
    );
    const forbidden = async (): Promise<never> => {
      throw new Error("dry run must not execute");
    };
    const result = await runCodeModeModelMatrix(options, {
      readGitSha: async () => "fixture-source",
      buildCliArtifacts: forbidden,
      readBuildSha256: forbidden,
      runCell: forbidden,
    });
    expect(result.summary).toEqual({ status: "dry-run", total: 3 });
    const manifest = JSON.parse(
      await fs.readFile(path.join(result.outputDir, "manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({ tasks: extendedTasks, buildSha256: null });
    expect(manifest.cells).toHaveLength(3);
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(path.join(result.outputDir, "qa-evidence.json"), "utf8")),
    );
    expect(evidence.entries).toEqual([]);
    await expect(fs.access(path.join(result.outputDir, "results.jsonl"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("Code Mode model matrix artifacts", () => {
  it("rejects output inside Git metadata", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-git-test-"));
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
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-case-test-"));
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
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-package-test-"));
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
      const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-build-test-"));
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

  it("continues after cell crashes and reports first-pass versus eventual success", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-matrix-test-"));
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
        groupCounts: { total: number; firstPassPassed: number; eventualPassed: number };
        groups: Array<{ firstPassPassed: boolean; eventualPassed: boolean }>;
      };
      expect(summary.counts).toEqual({ total: 2, passed: 1, failed: 1 });
      expect(summary.groupCounts).toEqual({
        total: 1,
        firstPassPassed: 0,
        eventualPassed: 1,
      });
      expect(summary.groups).toMatchObject([
        {
          firstPassPassed: false,
          eventualPassed: true,
          metrics: {
            assistantTurns: { samples: 0, total: null, p50: null },
            costUsd: { samples: 0, total: null, p50: null },
            outerToolCalls: { samples: 1, total: 1, p50: 1 },
            bridgeToolCalls: { samples: 1, total: 1, p50: 1 },
            bridgeSearchCalls: { samples: 1, total: 0, p50: 0 },
            bridgeDescribeCalls: { samples: 1, total: 0, p50: 0 },
          },
        },
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
