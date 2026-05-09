import process from "node:process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildProgram } from "./build-program.js";

describe("buildProgram version alias handling", () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = [...process.argv];
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  it("exits with version output for root -v", () => {
    process.argv = ["node", "openclaw", "-v"];
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as typeof process.exit);

    expect(() => buildProgram()).toThrow("process.exit:0");
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("does not treat subcommand -v as root version alias", () => {
    process.argv = ["node", "openclaw", "acp", "-v"];
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`unexpected process.exit:${String(code)}`);
    }) as typeof process.exit);

    buildProgram();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
