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
  registerBrowserActionObserveCommands(browser, parentOpts);
  return program;
}

describe("browser action observe commands", () => {
  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
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

  it("passes responsebody limits through to the request and outer timeout", async () => {
    const program = createActionObserveProgram();

    await program.parseAsync(
      ["browser", "responsebody", "**/api", "--timeout-ms", "+030000", "--max-chars", "0100"],
      { from: "user" },
    );

    const request = mocks.callBrowserRequest.mock.calls.at(-1)?.[1] as
      | { body?: { timeoutMs?: number; maxChars?: number } }
      | undefined;
    const options = mocks.callBrowserRequest.mock.calls.at(-1)?.[2] as
      | { timeoutMs?: number }
      | undefined;
    expect(request?.body?.timeoutMs).toBe(30000);
    expect(request?.body?.maxChars).toBe(100);
    expect(options?.timeoutMs).toBe(30000);
  });
});
