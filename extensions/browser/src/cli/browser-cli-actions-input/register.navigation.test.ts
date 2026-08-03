// Browser tests cover register.navigation plugin behavior.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as browserCliResizeModule from "../browser-cli-resize.js";
import * as browserCliSharedModule from "../browser-cli-shared.js";
import {
  createBrowserProgram,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "../browser-cli.test-support.js";
import * as cliCoreApiModule from "../core-api.js";

const mocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn<
    (
      opts?: unknown,
      req?: unknown,
      extra?: { timeoutMs?: number },
    ) => Promise<Record<string, unknown>>
  >(async () => ({ url: "https://example.test/landing" })),
  runBrowserResizeWithOutput: vi.fn(async () => {}),
}));

vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(mocks.callBrowserRequest);
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
    mocks.callBrowserRequest.mockClear();
    mocks.runBrowserResizeWithOutput.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it("sends navigate requests with the URL and target id", async () => {
    const program = createNavigationProgram();

    await program.parseAsync(
      ["browser", "navigate", "https://example.test/page", "--target-id", "tab-1"],
      { from: "user" },
    );

    const request = mocks.callBrowserRequest.mock.calls.at(-1)?.[1] as
      | { method?: string; path?: string; body?: Record<string, unknown> }
      | undefined;
    const options = mocks.callBrowserRequest.mock.calls.at(-1)?.[2] as
      | { timeoutMs?: number }
      | undefined;
    expect(request).toMatchObject({
      method: "POST",
      path: "/navigate",
      body: { url: "https://example.test/page", targetId: "tab-1" },
    });
    expect(options?.timeoutMs).toBe(20000);
  });

  it("passes normalized resize dimensions and target id to the resize helper", async () => {
    const program = createNavigationProgram();

    await program.parseAsync(["browser", "resize", "1024", "768", "--target-id", "tab-2"], {
      from: "user",
    });

    expect(mocks.runBrowserResizeWithOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        width: 1024,
        height: 768,
        targetId: "tab-2",
        timeoutMs: 20000,
        successMessage: "resized to 1024x768",
      }),
    );
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

  it("navigate and resize commands are registered after removing dead import (#83878)", async () => {
    const program = createNavigationProgram();
    const browserCmd = program.commands.find((c) => c.name() === "browser");
    expect(browserCmd).toBeDefined();

    const cmds = browserCmd!.commands.map((c) => c.name());
    expect(cmds).toContain("resize");
    expect(cmds).toContain("navigate");

    // Verify the shared module still exports requireRef (used by other modules)
    const shared = await import("./shared.js");
    expect(typeof shared.requireRef).toBe("function");
  });
});
