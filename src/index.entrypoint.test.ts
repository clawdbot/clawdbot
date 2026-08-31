// Tests executable behavior for the legacy package entrypoint.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tryHandleRootVersionFastPath } from "./entry.version-fast-path.js";
import { isMainModule } from "./infra/is-main.js";

vi.mock("./cli/run-main.js", () => ({
  runCli: vi.fn(async () => undefined),
}));
vi.mock("./cli/one-shot-exit.js", () => ({
  runCliWithExitFinalization: vi.fn(),
}));
vi.mock("./entry.version-fast-path.js", () => ({
  tryHandleRootVersionFastPath: vi.fn(() => false),
}));
vi.mock("./infra/is-main.js", () => ({
  isMainModule: vi.fn(() => true),
}));

const originalArgv = process.argv;

describe("legacy package executable entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.mocked(isMainModule).mockReturnValue(true);
    vi.mocked(tryHandleRootVersionFastPath).mockReturnValue(false);
    process.argv = ["node", "dist/index.js", "status"];
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("handles root --version before CLI startup", async () => {
    process.argv = ["node", "dist/index.js", "--version"];
    vi.mocked(tryHandleRootVersionFastPath).mockReturnValue(true);

    await import("./index.js?legacy-version-fast-path" as "./index.js");

    const runMain = await import("./cli/run-main.js");
    const exitFinalization = await import("./cli/one-shot-exit.js");
    expect(tryHandleRootVersionFastPath).toHaveBeenCalledWith(process.argv);
    expect(runMain.runCli).not.toHaveBeenCalled();
    expect(exitFinalization.runCliWithExitFinalization).not.toHaveBeenCalled();
  });
});
