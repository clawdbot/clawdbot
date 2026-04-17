import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const runMatrixQaLive = vi.hoisted(() => vi.fn());
const closeGlobalDispatcher = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./runners/contract/runtime.js", () => ({
  runMatrixQaLive,
}));
vi.mock("undici", () => ({
  getGlobalDispatcher: () => ({
    close: closeGlobalDispatcher,
  }),
}));

import { runQaMatrixCommand } from "./cli.runtime.js";

const tmpDirs: string[] = [];

describe("matrix qa cli runtime", () => {
  const originalRunNodeOutputLog = process.env.OPENCLAW_RUN_NODE_OUTPUT_LOG;

  afterEach(async () => {
    vi.clearAllMocks();
    if (originalRunNodeOutputLog === undefined) {
      delete process.env.OPENCLAW_RUN_NODE_OUTPUT_LOG;
    } else {
      process.env.OPENCLAW_RUN_NODE_OUTPUT_LOG = originalRunNodeOutputLog;
    }
    await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("rejects non-env credential sources for the disposable Matrix lane", async () => {
    await expect(
      runQaMatrixCommand({
        credentialSource: "convex",
      }),
    ).rejects.toThrow("Matrix QA currently supports only --credential-source env");
  });

  it("passes through default env credential source options", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-cli-"));
    tmpDirs.push(repoRoot);
    runMatrixQaLive.mockResolvedValue({
      reportPath: "/tmp/matrix-report.md",
      summaryPath: "/tmp/matrix-summary.json",
      observedEventsPath: "/tmp/matrix-events.json",
    });
    const originalStdoutWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;

    try {
      await runQaMatrixCommand({
        repoRoot,
        outputDir: ".artifacts/qa-e2e/matrix",
        providerMode: "mock-openai",
        credentialSource: "env",
      });
    } finally {
      process.stdout.write = originalStdoutWrite;
    }

    expect(runMatrixQaLive).toHaveBeenCalledWith(
      expect.objectContaining({
        repoRoot,
        outputDir: path.join(repoRoot, ".artifacts/qa-e2e/matrix"),
        providerMode: "mock-openai",
        credentialSource: "env",
      }),
    );
    expect(closeGlobalDispatcher).toHaveBeenCalledTimes(1);
  });

  it("reuses a run-node output log instead of installing a nested tee", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-cli-"));
    tmpDirs.push(repoRoot);
    const outputPath = path.join(repoRoot, "run-node-output.log");
    process.env.OPENCLAW_RUN_NODE_OUTPUT_LOG = outputPath;
    runMatrixQaLive.mockResolvedValue({
      reportPath: "/tmp/matrix-report.md",
      summaryPath: "/tmp/matrix-summary.json",
      observedEventsPath: "/tmp/matrix-events.json",
    });
    const originalStdoutWrite = process.stdout.write;
    process.stdout.write = vi.fn(() => true) as unknown as typeof process.stdout.write;

    try {
      await runQaMatrixCommand({
        repoRoot,
        outputDir: ".artifacts/qa-e2e/matrix",
        providerMode: "mock-openai",
        credentialSource: "env",
      });
    } finally {
      process.stdout.write = originalStdoutWrite;
    }

    expect(runMatrixQaLive).toHaveBeenCalledOnce();
    await expect(readFile(outputPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves the Matrix QA failure when output log cleanup also fails", async () => {
    const repoRoot = await mkdtemp(path.join(os.tmpdir(), "matrix-qa-cli-"));
    tmpDirs.push(repoRoot);
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "matrix");
    await mkdir(path.join(outputDir, "matrix-qa-output.log"), { recursive: true });
    runMatrixQaLive.mockRejectedValue(new Error("scenario failed"));
    const stderrChunks: string[] = [];
    const originalStdoutWrite = process.stdout.write;
    const originalStderrWrite = process.stderr.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Buffer) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      await expect(
        runQaMatrixCommand({
          repoRoot,
          outputDir: ".artifacts/qa-e2e/matrix",
          providerMode: "mock-openai",
          credentialSource: "env",
        }),
      ).rejects.toThrow("scenario failed");
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }

    expect(stderrChunks.join("")).toContain("Matrix QA output log error");
  });
});
