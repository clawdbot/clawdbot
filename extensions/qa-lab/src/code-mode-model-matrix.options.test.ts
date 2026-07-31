import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodeModeMatrixAgentEnv,
  buildCodeModeMatrixConfig,
  modelCellPrefix,
  parseCodeModeMatrixOptions,
  reserveCodeModeMatrixOutputDir,
  resolveCodeModeMatrixCellRuntimePaths,
  resolveCodeModeMatrixOutputDir,
  summarizeCodeModeMatrixResults,
  type CodeModeMatrixCellResult,
} from "../../../scripts/code-mode-model-matrix.ts";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Code Mode model matrix options", () => {
  it("separates input-output, last-call, cache, and retry metrics", () => {
    const result = (overrides: Partial<CodeModeMatrixCellResult>): CodeModeMatrixCellResult => ({
      assistantTurns: 2,
      bridgeCalls: { search: 0, describe: 0, call: 1, sequence: ["read"] },
      buildSha256: "build123",
      codeModeEngaged: true,
      elapsedMs: 100,
      executionTransport: "bridge",
      expected: "CM-EXPECTED",
      failureCategory: null,
      fallbackUsed: false,
      final: "CM-EXPECTED",
      firstProviderAttemptSucceeded: true,
      gitSha: "abc123",
      id: "cell",
      lastCallUsage: { input: 100, output: 10, total: 110 },
      mode: "code",
      model: "ollama/qwen3.5:9b",
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
      providerAttemptCount: 1,
      providerRetryCount: 0,
      repetition: 1,
      sourceDirty: false,
      sourcePatchSha256: null,
      startupMs: 40,
      status: "ok",
      task: "read",
      timestamp: "2026-07-30T00:00:00.000Z",
      toolSummary: { calls: 1, tools: ["exec"] },
      usage: { input: 100, output: 10, total: 110 },
      ...overrides,
    });
    const [group] = summarizeCodeModeMatrixResults([
      result({ id: "cell-1" }),
      result({
        assistantTurns: 4,
        elapsedMs: 300,
        failureCategory: "answer_mismatch",
        id: "cell-2",
        lastCallUsage: { input: 200, output: 20, total: 220 },
        passed: false,
        repetition: 2,
        usage: { input: 200, output: 20, cacheRead: 80, total: 300 },
      }),
    ]);

    expect(group).toMatchObject({
      metrics: {
        all: {
          assistantTurns: { captured: 2, p50: 4, total: 6 },
          cacheReadReported: { captured: 2, p50: 1, total: 1 },
          cacheReadTokens: { captured: 1, p50: 80, total: 80 },
          cacheWriteReported: { captured: 2, p50: 0, total: 0 },
          firstProviderAttemptSucceeded: { captured: 2, p50: 1, total: 2 },
          inputOutputTokens: { captured: 2, p50: 220, total: 330 },
          lastCallTotalTokens: { captured: 2, p50: 220, total: 330 },
          providerAttempts: { captured: 2, p50: 1, total: 2 },
          providerRetries: { captured: 2, p50: 0, total: 0 },
          wallMs: { captured: 2, p50: 300, total: 400 },
        },
        passed: {
          cacheReadReported: { captured: 1, p50: 0, total: 0 },
          inputOutputTokens: { captured: 1, p50: 110, total: 110 },
          lastCallTotalTokens: { captured: 1, p50: 110, total: 110 },
        },
      },
    });
  });

  it("defaults to the complete bounded matrix", () => {
    expect(parseCodeModeMatrixOptions(["--model", "ollama/qwen3.5:9b"], "/repo")).toMatchObject({
      models: ["ollama/qwen3.5:9b"],
      modes: ["direct", "auto", "code"],
      agentRuntime: "openclaw",
      localModelLean: true,
      tasks: ["read", "read-two-files", "dependent-read-write", "edit-readback"],
      repetitions: 3,
      seed: undefined,
      temperature: undefined,
      timeoutSeconds: 180,
      thinking: "off",
      repoRoot: "/repo",
    });
  });

  it("parses explicit sampling controls and rejects invalid values", () => {
    expect(
      parseCodeModeMatrixOptions(
        ["--model", "ollama/qwen3.5:4b", "--temperature", "0", "--seed", "42"],
        "/repo",
      ),
    ).toMatchObject({ temperature: 0, seed: 42 });
    expect(() =>
      parseCodeModeMatrixOptions(["--model", "ollama/qwen3.5:4b", "--temperature", "nope"]),
    ).toThrow("non-negative finite number");
    expect(() =>
      parseCodeModeMatrixOptions(["--model", "ollama/qwen3.5:4b", "--seed", "1.5"]),
    ).toThrow("non-negative integer");
  });

  it("resolves a separate product checkout for frozen comparisons", () => {
    expect(
      parseCodeModeMatrixOptions(
        ["--model", "openai/gpt-5.6-sol", "--target-root", "../baseline"],
        "/repo/harness",
      ),
    ).toMatchObject({
      repoRoot: "/repo/harness",
      targetRoot: "/repo/baseline",
    });
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
    const repoRoot = tempDirs.make("openclaw-code-mode-output-test-");
    try {
      const existing = path.join(repoRoot, "existing");
      await fs.mkdir(existing);
      await expect(reserveCodeModeMatrixOutputDir(repoRoot, existing)).rejects.toThrow(
        "must not already exist",
      );

      const outside = tempDirs.make("openclaw-code-mode-outside-test-");
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
    const repoRoot = tempDirs.make("openclaw-code-mode-reserve-test-");
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
    expect(
      buildCodeModeMatrixAgentEnv("ollama/qwen3.5:9b", "/runtime", "/state", {}),
    ).toMatchObject({
      NODE_DISABLE_COMPILE_CACHE: "1",
      OLLAMA_API_KEY: "ollama-local",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join("/runtime", "dist", "extensions"),
      OPENCLAW_CONFIG_PATH: path.join("/state", "openclaw.json"),
      OPENCLAW_STATE_DIR: "/state",
    });
    expect(
      buildCodeModeMatrixAgentEnv("ollama/qwen3.5:9b", "/runtime", "/state", {
        OLLAMA_API_KEY: "configured-value",
      }).OLLAMA_API_KEY,
    ).toBe("configured-value");
    expect(
      buildCodeModeMatrixAgentEnv("huggingface/model", "/runtime", "/state", {}).OLLAMA_API_KEY,
    ).toBeUndefined();
    expect(
      buildCodeModeMatrixAgentEnv(
        "huggingface/model",
        "/runtime",
        "/state",
        {},
        {
          configPath: "/runtime/config/cell.json",
          credentialAgentDir: "/home/user/.openclaw/agents/main/agent",
        },
      ),
    ).toMatchObject({
      OPENCLAW_AGENT_DIR: "/home/user/.openclaw/agents/main/agent",
      OPENCLAW_CONFIG_PATH: "/runtime/config/cell.json",
      OPENCLAW_STATE_DIR: "/state",
    });
  });

  it("runs child CLIs without inherited Vitest runtime markers", () => {
    const env = buildCodeModeMatrixAgentEnv("openai/gpt-5.6", "/runtime", "/state", {
      NODE_ENV: "test",
      VITEST: "true",
      VITEST_MODE: "RUN",
      VITEST_POOL_ID: "pool",
      VITEST_WORKER_ID: "worker",
      UNRELATED_VALUE: "kept",
    });

    expect(env).toMatchObject({ UNRELATED_VALUE: "kept" });
    expect(env.NODE_ENV).toBeUndefined();
    expect(env.VITEST).toBeUndefined();
    expect(env.VITEST_MODE).toBeUndefined();
    expect(env.VITEST_POOL_ID).toBeUndefined();
    expect(env.VITEST_WORKER_ID).toBeUndefined();
  });

  it("pins runtime and sampling controls through supported model config", () => {
    expect(buildCodeModeMatrixConfig("openai/gpt-5.6-sol")).toEqual({
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.6-sol": {
              agentRuntime: { id: "openclaw" },
            },
          },
        },
      },
    });
    expect(buildCodeModeMatrixConfig("openai/gpt-5.6-sol", "default")).toEqual({});
    expect(
      buildCodeModeMatrixConfig(
        "openai/gpt-5.6-sol",
        "default",
        {},
        {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.6-sol": {
                  agentRuntime: { id: "openclaw" },
                  params: { maxTokens: 512 },
                },
              },
            },
          },
        },
      ),
    ).toEqual({
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.6-sol": {
              params: { maxTokens: 512 },
            },
          },
        },
      },
    });
    expect(
      buildCodeModeMatrixConfig(
        "huggingface/qwen",
        "openclaw",
        { temperature: 0 },
        {
          models: {
            providers: {
              huggingface: {
                baseUrl: "https://router.huggingface.co/v1",
                api: "openai-completions",
                models: [
                  {
                    id: "qwen",
                    name: "Qwen",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
          agents: {
            defaults: {
              models: {
                "huggingface/qwen": {
                  params: { maxTokens: 512 },
                },
              },
            },
          },
        },
      ),
    ).toMatchObject({
      models: {
        providers: {
          huggingface: {
            baseUrl: "https://router.huggingface.co/v1",
          },
        },
      },
      agents: {
        defaults: {
          models: {
            "huggingface/qwen": {
              agentRuntime: { id: "openclaw" },
              params: { maxTokens: 512, temperature: 0 },
            },
          },
        },
      },
    });
    expect(
      buildCodeModeMatrixConfig("ollama/qwen3.5:4b", "openclaw", {
        seed: 42,
        temperature: 0,
      }),
    ).toEqual({
      agents: {
        defaults: {
          models: {
            "ollama/qwen3.5:4b": {
              agentRuntime: { id: "openclaw" },
              params: { seed: 42, temperature: 0 },
            },
          },
        },
      },
    });
  });
});

describe("Code Mode model matrix identity", () => {
  it("keeps punctuation variants distinct", () => {
    expect(modelCellPrefix("ollama/foo.bar")).not.toBe(modelCellPrefix("ollama/foo-bar"));
  });

  it("retains a distinct workspace for every repetition", () => {
    const first = resolveCodeModeMatrixCellRuntimePaths("/run", "ollama-qwen-code-read-1");
    const second = resolveCodeModeMatrixCellRuntimePaths("/run", "ollama-qwen-code-read-2");

    expect(first.workspace).toBe(path.join("/run", "workspaces", "ollama-qwen-code-read-1"));
    expect(second.workspace).toBe(path.join("/run", "workspaces", "ollama-qwen-code-read-2"));
    expect(first.workspace).not.toBe(second.workspace);
  });
});
