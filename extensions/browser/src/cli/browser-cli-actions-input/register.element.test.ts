import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  >(async () => ({ url: "https://example.test" })),
}));

vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(mocks.callBrowserRequest);
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(cliCoreApiModule.defaultRuntime, "writeJson").mockImplementation(
  browserCliRuntime.writeJson,
);
vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);

const { registerBrowserElementCommands } = await import("./register.element.js");

function createElementProgram(): Command {
  const { program, browser, parentOpts } = createBrowserProgram();
  registerBrowserElementCommands(browser, parentOpts);
  return program;
}

describe("browser element commands", () => {
  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it("rejects non-decimal coordinate values before dispatch", async () => {
    const program = createElementProgram();

    await expect(
      program.parseAsync(["browser", "click-coords", "0x10", "20"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    const capture = getBrowserCliRuntimeCapture();
    expect(capture.runtimeErrors.join("\n")).toContain("Invalid x: must be a finite number");
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("rejects non-decimal delay and timeout options", async () => {
    const delayProgram = createElementProgram();
    await expect(
      delayProgram.parseAsync(["browser", "click-coords", "10", "20", "--delay-ms", "1e3"], {
        from: "user",
      }),
    ).rejects.toThrow("--delay-ms must be a non-negative integer.");

    const timeoutProgram = createElementProgram();
    await expect(
      timeoutProgram.parseAsync(["browser", "scrollintoview", "ref-1", "--timeout-ms", "0x1000"], {
        from: "user",
      }),
    ).rejects.toThrow("--timeout-ms must be a positive integer.");
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("accepts signed and zero-padded integer action options", async () => {
    const delayProgram = createElementProgram();
    await delayProgram.parseAsync(["browser", "click-coords", "10", "20", "--delay-ms", "+0005"], {
      from: "user",
    });
    const delayCall = mocks.callBrowserRequest.mock.calls.at(-1) as unknown[] | undefined;
    const delayRequest = delayCall?.[1] as { body?: { delayMs?: number } } | undefined;
    expect(delayRequest?.body?.delayMs).toBe(5);

    const timeoutProgram = createElementProgram();
    await timeoutProgram.parseAsync(
      ["browser", "scrollintoview", "ref-1", "--timeout-ms", "+020000"],
      { from: "user" },
    );
    const timeoutCall = mocks.callBrowserRequest.mock.calls.at(-1) as unknown[] | undefined;
    const timeoutRequest = timeoutCall?.[1] as { body?: { timeoutMs?: number } } | undefined;
    const timeoutOptions = timeoutCall?.[2] as { timeoutMs?: number } | undefined;
    expect(timeoutRequest?.body?.timeoutMs).toBe(20_000);
    expect(timeoutOptions?.timeoutMs).toBeGreaterThan(20_000);
  });
});
