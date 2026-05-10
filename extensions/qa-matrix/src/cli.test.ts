import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runQaMatrixCommand } = vi.hoisted(() => ({
  runQaMatrixCommand: vi.fn(),
}));

vi.mock("./cli.runtime.js", () => ({
  runQaMatrixCommand,
}));

import { matrixQaCliRegistration } from "./cli.js";

function mockProcessWrite(
  _chunk: string | Uint8Array,
  encodingOrCallback?: BufferEncoding | ((err?: Error | null) => void),
  callback?: (err?: Error | null) => void,
) {
  if (typeof encodingOrCallback === "function") {
    encodingOrCallback();
  } else {
    callback?.();
  }
  return true;
}

describe("matrix qa cli registration", () => {
  const originalDisableForceExit = process.env.OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    runQaMatrixCommand.mockReset();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(mockProcessWrite);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(mockProcessWrite);
  });

  afterEach(() => {
    if (originalDisableForceExit === undefined) {
      delete process.env.OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT;
    } else {
      process.env.OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT = originalDisableForceExit;
    }
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("keeps disposable Matrix lane flags focused", () => {
    const qa = new Command();

    matrixQaCliRegistration.register(qa);

    const matrix = qa.commands.find((command) => command.name() === "matrix");
    const optionNames = matrix?.options.map((option) => option.long) ?? [];

    for (const optionName of [
      "--repo-root",
      "--output-dir",
      "--provider-mode",
      "--model",
      "--alt-model",
      "--scenario",
      "--fast",
      "--profile",
      "--fail-fast",
      "--sut-account",
    ]) {
      expect(optionNames).toContain(optionName);
    }
    expect(optionNames).not.toContain("--credential-source");
    expect(optionNames).not.toContain("--credential-role");
  });

  it("exits with failure after Matrix artifacts are written for a failed run", async () => {
    const qa = new Command();
    matrixQaCliRegistration.register(qa);
    runQaMatrixCommand.mockRejectedValue(new Error("Matrix QA failed.\nreport: /tmp/report.md"));

    await expect(qa.parseAsync(["node", "openclaw", "matrix"])).rejects.toThrow("process.exit(1)");

    expect(runQaMatrixCommand).toHaveBeenCalledOnce();
    expect(stderrSpy).toHaveBeenCalledWith("Matrix QA failed.\nreport: /tmp/report.md\n");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("can disable the forced exit for direct test harnesses", async () => {
    process.env.OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT = "1";
    const qa = new Command();
    matrixQaCliRegistration.register(qa);
    runQaMatrixCommand.mockRejectedValue(new Error("scenario failed"));

    await expect(qa.parseAsync(["node", "openclaw", "matrix"])).rejects.toThrow("scenario failed");

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
