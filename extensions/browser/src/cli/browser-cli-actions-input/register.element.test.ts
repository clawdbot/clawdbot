// Browser tests cover register.element plugin behavior.
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

function getLastActionBody(): Record<string, unknown> | undefined {
  return (mocks.callBrowserRequest.mock.calls.at(-1)?.[1] as { body?: Record<string, unknown> })
    ?.body;
}

describe("browser element commands", () => {
  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it.each([
    {
      name: "click",
      argv: [
        "browser",
        "click",
        " ref-1 ",
        "--target-id",
        "tab-1",
        "--double",
        "--button",
        "right",
        "--modifiers",
        "Shift, Alt",
      ],
      expectedBody: {
        kind: "click",
        ref: "ref-1",
        targetId: "tab-1",
        doubleClick: true,
        button: "right",
        modifiers: ["Shift", "Alt"],
      },
    },
    {
      name: "click-coords",
      argv: [
        "browser",
        "click-coords",
        "12.5",
        "42",
        "--target-id",
        "tab-2",
        "--double",
        "--button",
        "middle",
        "--delay-ms",
        "25",
      ],
      expectedBody: {
        kind: "clickCoords",
        x: 12.5,
        y: 42,
        targetId: "tab-2",
        doubleClick: true,
        button: "middle",
        delayMs: 25,
      },
    },
    {
      name: "type",
      argv: ["browser", "type", "input-1", "hello", "--submit", "--slowly", "--target-id", "tab-2"],
      expectedBody: {
        kind: "type",
        ref: "input-1",
        text: "hello",
        submit: true,
        slowly: true,
        targetId: "tab-2",
      },
    },
    {
      name: "press",
      argv: ["browser", "press", "Enter", "--target-id", "tab-3"],
      expectedBody: { kind: "press", key: "Enter", targetId: "tab-3" },
    },
    {
      name: "hover",
      argv: ["browser", "hover", "node-1", "--target-id", "tab-4"],
      expectedBody: { kind: "hover", ref: "node-1", targetId: "tab-4" },
    },
    {
      name: "scrollintoview",
      argv: ["browser", "scrollintoview", "node-2", "--target-id", "tab-5"],
      expectedBody: { kind: "scrollIntoView", ref: "node-2", targetId: "tab-5" },
    },
    {
      name: "drag",
      argv: ["browser", "drag", "start-1", "end-1", "--target-id", "tab-6"],
      expectedBody: {
        kind: "drag",
        startRef: "start-1",
        endRef: "end-1",
        targetId: "tab-6",
      },
    },
    {
      name: "select",
      argv: ["browser", "select", "select-1", "alpha", "beta", "--target-id", "tab-7"],
      expectedBody: {
        kind: "select",
        ref: "select-1",
        values: ["alpha", "beta"],
        targetId: "tab-7",
      },
    },
  ])("sends the expected $name action body", async ({ argv, expectedBody }) => {
    const program = createElementProgram();

    await program.parseAsync(argv, { from: "user" });

    expect(getLastActionBody()).toMatchObject(expectedBody);
  });

  it("rejects a blank required ref before dispatch", async () => {
    const program = createElementProgram();

    await expect(program.parseAsync(["browser", "click", "   "], { from: "user" })).rejects.toThrow(
      "__exit__:1",
    );

    const capture = getBrowserCliRuntimeCapture();
    expect(capture.runtimeErrors.join("\n")).toContain("ref is required");
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
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
