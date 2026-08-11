// Tests executable behavior for the legacy package entrypoint.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tryHandleRootVersionFastPath } from "./entry.version-fast-path.js";
import { isMainModule } from "./infra/is-main.js";

type IndexModule = typeof import("./index.js");

vi.mock("./cli/run-main.js", () => ({
  runCli: vi.fn(async () => undefined),
}));

vi.mock("./cli/one-shot-exit.js", () => ({
  runCliWithExitFinalization: vi.fn(({ run }: { run: () => Promise<void> }) => {
    void run();
  }),
}));

vi.mock("./entry.version-fast-path.js", () => ({
  tryHandleRootVersionFastPath: vi.fn(() => false),
}));

vi.mock("./infra/is-main.js", () => ({
  isMainModule: vi.fn(() => true),
}));

vi.mock("./infra/unhandled-rejections.js", () => ({
  installUnhandledRejectionHandler: vi.fn(),
  isBenignUncaughtExceptionError: vi.fn(() => false),
  isUncaughtExceptionHandled: vi.fn(() => false),
}));

vi.mock("./runtime.js", () => ({
  restoreRuntimeTerminalState: vi.fn(),
}));

const originalArgv = process.argv;
const originalExit = process.exit;

describe("legacy package executable entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(isMainModule).mockReturnValue(true);
    vi.mocked(tryHandleRootVersionFastPath).mockReturnValue(false);
    process.argv = ["node", "dist/index.js", "status"];
    process.exit = vi.fn() as unknown as typeof process.exit;
  });

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    vi.restoreAllMocks();
  });

  it("handles root --version before loading runtime startup", async () => {
    process.argv = ["node", "dist/index.js", "--version"];
    vi.mocked(tryHandleRootVersionFastPath).mockReturnValue(true);

    (await import("./index.js?legacy-version-fast-path" as "./index.js")) as IndexModule;

    const runMain = await import("./cli/run-main.js");
    const runtime = await import("./runtime.js");
    const exitFinalization = await import("./cli/one-shot-exit.js");
    expect(tryHandleRootVersionFastPath).toHaveBeenCalledWith(process.argv);
    expect(runMain.runCli).not.toHaveBeenCalled();
    expect(exitFinalization.runCliWithExitFinalization).not.toHaveBeenCalled();
    expect(runtime.restoreRuntimeTerminalState).not.toHaveBeenCalled();
  });

  it("keeps normal legacy CLI execution when version fast path does not match", async () => {
    (await import("./index.js?legacy-normal-exec" as "./index.js")) as IndexModule;

    const runMain = await import("./cli/run-main.js");
    const exitFinalization = await import("./cli/one-shot-exit.js");
    expect(tryHandleRootVersionFastPath).toHaveBeenCalledWith(process.argv);
    expect(exitFinalization.runCliWithExitFinalization).toHaveBeenCalledTimes(1);
    expect(runMain.runCli).toHaveBeenCalledWith(process.argv, {
      retainConsoleRoutingUntilProcessExit: true,
    });
  });
});
