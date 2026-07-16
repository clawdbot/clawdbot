// Qa Lab Matrix tests cover the thin CLI selector and adapter registration.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runQaMatrixCommand = vi.hoisted(() => vi.fn());

vi.mock("./cli.runtime.js", () => ({ runQaMatrixCommand }));

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

describe("QA Lab Matrix CLI registration", () => {
  const originalDisableForceExit = process.env.OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT;
  const originalExitCode = process.exitCode;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.exitCode = undefined;
    runQaMatrixCommand.mockReset();
    exitSpy = vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(mockProcessWrite);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(mockProcessWrite);
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
    if (originalDisableForceExit === undefined) {
      delete process.env.OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT;
    } else {
      process.env.OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT = originalDisableForceExit;
    }
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("keeps generic Matrix suite defaults in the repo-backed flow catalog", () => {
    expect(matrixQaCliRegistration.adapterFactory?.scenarioIds).toEqual([
      "channel-chat-baseline",
      "channel-canary",
      "channel-dm-group-routing",
      "channel-mention-gating",
      "channel-sender-allowlist",
      "channel-top-level-reply-shape",
      "channel-secondary-conversation-isolation",
      "channel-multi-actor-ordering",
      "thread-follow-up",
      "thread-isolation",
      "thread-reply-override",
      "dm-shared-session",
      "dm-per-room-session",
    ]);
  });

  it("exposes only QA Lab selector flags", () => {
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
      "--fail-fast",
      "--profile",
      "--sut-account",
    ]) {
      expect(optionNames).toContain(optionName);
    }
    expect(optionNames).not.toContain("--credential-source");
    expect(optionNames).not.toContain("--credential-role");
  });

  it("delegates command options to the Matrix runtime", async () => {
    process.env.OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT = "1";
    const qa = new Command();
    matrixQaCliRegistration.register(qa);

    await qa.parseAsync([
      "node",
      "openclaw",
      "matrix",
      "--profile",
      "release",
      "--scenario",
      "matrix-allowlist-hot-reload",
    ]);

    expect(runQaMatrixCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: "release",
        providerMode: "live-frontier",
        scenarioIds: ["matrix-allowlist-hot-reload"],
      }),
    );
  });

  it("exits successfully after Matrix artifacts are written", async () => {
    const qa = new Command();
    matrixQaCliRegistration.register(qa);
    runQaMatrixCommand.mockResolvedValue(undefined);

    await expect(qa.parseAsync(["node", "openclaw", "matrix"])).rejects.toThrow("process.exit(0)");

    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("prints a failed run and exits after its artifacts are written", async () => {
    const qa = new Command();
    matrixQaCliRegistration.register(qa);
    runQaMatrixCommand.mockRejectedValue(new Error("Matrix QA failed.\nreport: /tmp/report.md"));

    await expect(qa.parseAsync(["node", "openclaw", "matrix"])).rejects.toThrow("process.exit(1)");

    expect(stderrSpy).toHaveBeenCalledWith("Matrix QA failed.\nreport: /tmp/report.md\n");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("preserves a failed suite exit code after the runtime returns", async () => {
    const qa = new Command();
    matrixQaCliRegistration.register(qa);
    runQaMatrixCommand.mockImplementation(async () => {
      process.exitCode = 1;
    });

    await expect(qa.parseAsync(["node", "openclaw", "matrix"])).rejects.toThrow("process.exit(1)");

    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("allows direct test harnesses to disable the forced exit", async () => {
    process.env.OPENCLAW_QA_MATRIX_DISABLE_FORCE_EXIT = "1";
    const qa = new Command();
    matrixQaCliRegistration.register(qa);
    runQaMatrixCommand.mockRejectedValue(new Error("scenario failed"));

    await expect(qa.parseAsync(["node", "openclaw", "matrix"])).rejects.toThrow("scenario failed");

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
