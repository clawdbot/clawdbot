// Browser tests cover register.form wait eval plugin behavior.
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
  >(async () => ({ result: true })),
}));

vi.spyOn(browserCliSharedModule, "callBrowserRequest").mockImplementation(mocks.callBrowserRequest);
const browserCliRuntime = getBrowserCliRuntime();
vi.spyOn(cliCoreApiModule.defaultRuntime, "log").mockImplementation(browserCliRuntime.log);
vi.spyOn(cliCoreApiModule.defaultRuntime, "writeJson").mockImplementation(
  browserCliRuntime.writeJson,
);
vi.spyOn(cliCoreApiModule.defaultRuntime, "error").mockImplementation(browserCliRuntime.error);
vi.spyOn(cliCoreApiModule.defaultRuntime, "exit").mockImplementation(browserCliRuntime.exit);

const { registerBrowserActionInputCommands } = await import("./register.js");

function createActionInputProgram(): Command {
  const { program, browser, parentOpts } = createBrowserProgram();
  registerBrowserActionInputCommands(browser, parentOpts);
  return program;
}

function getLastActionBody(): Record<string, unknown> | undefined {
  return (mocks.callBrowserRequest.mock.calls.at(-1)?.[1] as { body?: Record<string, unknown> })
    ?.body;
}

describe("browser action input fill command", () => {
  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it("sends normalized fill fields and target id to the act route", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      [
        "browser",
        "fill",
        "--fields",
        '[{"ref":"name","value":"Ada"},{"ref":"enabled","value":true}]',
        "--target-id",
        "tab-1",
      ],
      { from: "user" },
    );

    expect(getLastActionBody()).toMatchObject({
      kind: "fill",
      fields: [
        { ref: "name", type: "text", value: "Ada" },
        { ref: "enabled", type: "text", value: true },
      ],
      targetId: "tab-1",
    });
    expect(mocks.callBrowserRequest.mock.calls.at(-1)?.[2]).toEqual({ timeoutMs: 65_000 });
  });

  it("reports malformed fields without sending a browser request", async () => {
    const program = createActionInputProgram();

    await expect(
      program.parseAsync(["browser", "fill", "--fields", "NOT JSON {{{"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(getBrowserCliRuntimeCapture().runtimeErrors.join("\n")).toContain(
      "fields must be valid JSON.",
    );
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("rejects conflicting inline and file fields before dispatch", async () => {
    const program = createActionInputProgram();

    await expect(
      program.parseAsync(
        ["browser", "fill", "--fields", "[]", "--fields-file", "/tmp/browser-fields.json"],
        { from: "user" },
      ),
    ).rejects.toThrow("__exit__:1");

    expect(getBrowserCliRuntimeCapture().runtimeErrors.join("\n")).toContain(
      "Specify only one of --fields or --fields-file",
    );
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });
});

describe("browser action input wait command", () => {
  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it("keeps the outer request open longer than a time-based wait", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "wait", "--time", "+025000"], { from: "user" });

    const options = mocks.callBrowserRequest.mock.calls.at(-1)?.[2] as
      | { timeoutMs?: number }
      | undefined;
    expect(options?.timeoutMs).toBeGreaterThan(25000);
  });

  it("keeps the outer request open for time delay plus condition timeout", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(["browser", "wait", "--time", "1000", "--text", "Ready"], {
      from: "user",
    });

    const options = mocks.callBrowserRequest.mock.calls.at(-1)?.[2] as
      | { timeoutMs?: number }
      | undefined;
    expect(options?.timeoutMs).toBe(26_000);
  });

  it("budgets every supplied wait condition before adding transport slack", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      [
        "browser",
        "wait",
        "#result",
        "--time",
        "1000",
        "--text",
        "Ready",
        "--text-gone",
        "Loading",
        "--url",
        "**/done",
        "--load",
        "networkidle",
        "--fn",
        "() => true",
        "--timeout-ms",
        "2000",
      ],
      { from: "user" },
    );

    const options = mocks.callBrowserRequest.mock.calls.at(-1)?.[2] as
      | { timeoutMs?: number }
      | undefined;
    expect(options?.timeoutMs).toBe(18_000);
  });

  it("rejects non-decimal wait numeric options before sending the wait request", async () => {
    const program = createActionInputProgram();

    await expect(
      program.parseAsync(["browser", "wait", "--time", "1e3"], { from: "user" }),
    ).rejects.toThrow("--time must be a non-negative integer.");
    await expect(
      program.parseAsync(["browser", "wait", "--text", "Ready", "--timeout-ms", "0x1000"], {
        from: "user",
      }),
    ).rejects.toThrow("--timeout-ms must be a positive integer.");
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });

  it("rejects unsupported load states before sending the wait request", async () => {
    const program = createActionInputProgram();

    await expect(
      program.parseAsync(["browser", "wait", "--load", "complete"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    const capture = getBrowserCliRuntimeCapture();
    expect(capture.runtimeErrors.join("\n")).toContain("Invalid --load value: complete");
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });
});

describe("browser action input evaluate command", () => {
  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    getBrowserCliRuntimeCapture().resetRuntimeCapture();
  });

  it("sends evaluate function, ref, and target id to the act route", async () => {
    const program = createActionInputProgram();

    await program.parseAsync(
      [
        "browser",
        "evaluate",
        "--fn",
        "el => el.textContent",
        "--ref",
        "button-1",
        "--target-id",
        "tab-2",
      ],
      { from: "user" },
    );

    expect(getLastActionBody()).toMatchObject({
      kind: "evaluate",
      fn: "el => el.textContent",
      ref: "button-1",
      targetId: "tab-2",
    });
    expect(mocks.callBrowserRequest.mock.calls.at(-1)?.[2]).toEqual({ timeoutMs: 65_000 });
  });

  it.each([
    { rawTimeout: "+030000", actionTimeoutMs: 30_000, requestTimeoutMs: 35_250 },
    { rawTimeout: "1", actionTimeoutMs: 1, requestTimeoutMs: 5_750 },
  ])(
    "preserves the $rawTimeout evaluate timeout and canonical outer deadline",
    async ({ rawTimeout, actionTimeoutMs, requestTimeoutMs }) => {
      const program = createActionInputProgram();

      await program.parseAsync(
        ["browser", "evaluate", "--fn", "() => true", "--timeout-ms", rawTimeout],
        { from: "user" },
      );

      const request = mocks.callBrowserRequest.mock.calls.at(-1)?.[1] as
        | { body?: { timeoutMs?: number } }
        | undefined;
      const options = mocks.callBrowserRequest.mock.calls.at(-1)?.[2] as
        | { timeoutMs?: number }
        | undefined;
      expect(request?.body?.timeoutMs).toBe(actionTimeoutMs);
      expect(options?.timeoutMs).toBe(requestTimeoutMs);
    },
  );

  it("rejects non-decimal evaluate timeouts before dispatch", async () => {
    const program = createActionInputProgram();

    await expect(
      program.parseAsync(["browser", "evaluate", "--fn", "() => true", "--timeout-ms", "1e3"], {
        from: "user",
      }),
    ).rejects.toThrow("--timeout-ms must be a positive integer.");
    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
  });
});
