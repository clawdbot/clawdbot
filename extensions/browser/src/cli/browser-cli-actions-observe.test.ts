// Browser tests cover browser cli actions observe plugin behavior.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as browserCliSharedModule from "./browser-cli-shared.js";
import {
  createBrowserProgram,
  getBrowserCliRuntime,
  getBrowserCliRuntimeCapture,
} from "./browser-cli.test-support.js";
import * as cliCoreApiModule from "./core-api.js";

const mocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn<
    (
      opts?: unknown,
      req?: unknown,
      extra?: { timeoutMs?: number },
    ) => Promise<Record<string, unknown>>
  >(async () => ({ response: { body: "ok" } })),
}));

vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(mocks.callBrowserRequest);
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(cliCoreApiModule.defaultRuntime, "writeJson").mockImplementation(
  browserCliRuntime.writeJson,
);
vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);

const { registerBrowserActionObserveCommands } = await import("./browser-cli-actions-observe.js");

function createActionObserveProgram(): Command {
  const { program, browser, parentOpts } = createBrowserProgram();
  browser.option("--timeout <ms>", "Timeout in ms", "30000");
  registerBrowserActionObserveCommands(browser, parentOpts);
  return program;
}

describe("browser action observe commands", () => {
  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it.each([
    { command: "console", path: "/console", timeout: "30000" },
    { command: "console", path: "/console", timeout: "60000" },
    { command: "pdf", path: "/pdf", timeout: "30000" },
    { command: "pdf", path: "/pdf", timeout: "60000" },
  ])("inherits parent $timeout ms timeout for $command", async ({ command, path, timeout }) => {
    const program = createActionObserveProgram();
    const parentArgs = timeout === "30000" ? ["--json"] : ["--json", "--timeout", timeout];

    await program.parseAsync(["browser", ...parentArgs, command], { from: "user" });

    expect(mocks.callBrowserRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ timeout }),
      expect.objectContaining({ path }),
    );
  });

  it("rejects non-decimal responsebody numeric flags before dispatch", async () => {
    const program = createActionObserveProgram();

    await expect(
      program.parseAsync(["browser", "responsebody", "**/api", "--timeout-ms", "1e3"], {
        from: "user",
      }),
    ).rejects.toThrow("--timeout-ms must be a positive integer.");
    await expect(
      program.parseAsync(["browser", "responsebody", "**/api", "--max-chars", "-1"], {
        from: "user",
      }),
    ).rejects.toThrow("--max-chars must be a positive integer.");
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("rejects unknown console levels before dispatch", async () => {
    const program = createActionObserveProgram();

    await expect(
      program.parseAsync(["browser", "console", "--level", "bogus"], { from: "user" }),
    ).rejects.toThrow(/error.*warn.*info/u);
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "default",
      timeout: undefined,
      operationTimeoutMs: undefined,
      requestTimeoutMs: 25000,
    },
    { label: "minimum explicit", timeout: "1", operationTimeoutMs: 1, requestTimeoutMs: 5001 },
    {
      label: "signed explicit",
      timeout: "+030000",
      operationTimeoutMs: 30000,
      requestTimeoutMs: 35000,
    },
  ])(
    "keeps the $label responsebody request open past its operation deadline",
    async ({ timeout, operationTimeoutMs, requestTimeoutMs }) => {
      const program = createActionObserveProgram();
      const args = ["browser", "responsebody", "**/api", "--max-chars", "0100"];
      if (timeout !== undefined) {
        args.push("--timeout-ms", timeout);
      }

      await program.parseAsync(args, { from: "user" });

      const request = mocks.callBrowserRequest.mock.calls.at(-1)?.[1] as
        | { body?: { timeoutMs?: number; maxChars?: number } }
        | undefined;
      const options = mocks.callBrowserRequest.mock.calls.at(-1)?.[2] as
        | { timeoutMs?: number }
        | undefined;
      expect(request?.body?.timeoutMs).toBe(operationTimeoutMs);
      expect(request?.body?.maxChars).toBe(100);
      expect(options?.timeoutMs).toBe(requestTimeoutMs);
    },
  );
});
