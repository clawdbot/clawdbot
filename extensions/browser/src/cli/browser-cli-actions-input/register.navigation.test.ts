import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as browserCliResizeModule from "../browser-cli-resize.js";
import {
  createBrowserProgram,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "../browser-cli.test-support.js";
import * as cliCoreApiModule from "../core-api.js";

const mocks = vi.hoisted(() => ({
  runBrowserResizeWithOutput: vi.fn(async () => {}),
}));

vi.spyOn(browserCliResizeModule, "runBrowserResizeWithOutput").mockImplementation(
  mocks.runBrowserResizeWithOutput,
);
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(cliCoreApiModule.defaultRuntime, "writeJson").mockImplementation(
  browserCliRuntime.writeJson,
);
vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);

const { registerBrowserNavigationCommands } = await import("./register.navigation.js");

function createNavigationProgram(): Command {
  const { program, browser, parentOpts } = createBrowserProgram();
  registerBrowserNavigationCommands(browser, parentOpts);
  return program;
}

describe("browser navigation commands", () => {
  beforeEach(() => {
    mocks.runBrowserResizeWithOutput.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it("rejects non-decimal resize dimensions before dispatch", async () => {
    const program = createNavigationProgram();

    await expect(
      program.parseAsync(["browser", "resize", "1e3", "768"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    const capture = getBrowserCliRuntimeCapture();
    expect(capture.runtimeErrors.join("\n")).toContain("Invalid width: must be a positive integer");
    expect(mocks.runBrowserResizeWithOutput).not.toHaveBeenCalled();
  });

  it("rejects excessive resize dimensions before dispatch", async () => {
    const program = createNavigationProgram();

    await expect(
      program.parseAsync(["browser", "resize", "8193", "768"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    const capture = getBrowserCliRuntimeCapture();
    expect(capture.runtimeErrors.join("\n")).toContain("Invalid width: maximum is 8192");
    expect(mocks.runBrowserResizeWithOutput).not.toHaveBeenCalled();
  });
});
