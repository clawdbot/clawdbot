// Tests version fast-path output before the full entrypoint loads.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../test/helpers/promise.js";
import { tryHandleRootVersionFastPath } from "./entry.version-fast-path.js";

vi.mock("./cli/argv.js", () => ({
  isRootHelpInvocation: () => false,
  isRootVersionInvocation: (argv: string[]) => argv.includes("--version"),
}));

vi.mock("./cli/container-target.js", () => ({
  parseCliContainerArgs: (argv: string[]) => ({ ok: true, container: null, argv }),
  resolveCliContainerTarget: (argv: string[], env: NodeJS.ProcessEnv = process.env) =>
    argv.includes("--container") ? "demo" : (env.OPENCLAW_CONTAINER ?? null),
}));

describe("entry root version fast path", () => {
  it("prints version output and skips host handling when container-targeted", async () => {
    const output = vi.fn();
    const taggedExit = createDeferred();
    const plainExit = createDeferred();
    const exit = vi
      .fn()
      .mockImplementationOnce(() => taggedExit.resolve())
      .mockImplementationOnce(() => plainExit.resolve());
    const resolveVersion = vi.fn<
      () => Promise<{
        VERSION: string;
        resolveCommitHash: (params: { moduleUrl: string }) => string | null;
      }>
    >(async () => ({
      VERSION: "9.9.9-test",
      resolveCommitHash: vi.fn(() => "abc1234"),
    }));

    expect(
      tryHandleRootVersionFastPath(["node", "openclaw", "--version"], {
        output,
        exit,
        resolveVersion,
      }),
    ).toBe(true);
    await taggedExit.promise;
    expect(output).toHaveBeenCalledWith("OpenClaw 9.9.9-test (abc1234)");
    expect(exit).toHaveBeenCalledWith(0);

    output.mockClear();
    exit.mockClear();
    resolveVersion.mockResolvedValueOnce({
      VERSION: "9.9.9-test",
      resolveCommitHash: vi.fn(() => null),
    });

    expect(
      tryHandleRootVersionFastPath(["node", "openclaw", "--version"], {
        output,
        exit,
        resolveVersion,
      }),
    ).toBe(true);
    await plainExit.promise;
    expect(output).toHaveBeenCalledWith("OpenClaw 9.9.9-test");
    expect(exit).toHaveBeenCalledWith(0);

    output.mockClear();
    exit.mockClear();
    expect(
      tryHandleRootVersionFastPath(["node", "openclaw", "--container", "demo", "--version"], {
        output,
        exit,
        resolveVersion,
      }),
    ).toBe(false);
    expect(resolveVersion).toHaveBeenCalledTimes(2);
    expect(output).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();

    expect(
      tryHandleRootVersionFastPath(["node", "openclaw", "--version"], {
        env: { OPENCLAW_CONTAINER: "demo" },
        output,
        exit,
        resolveVersion,
      }),
    ).toBe(false);
  });

  describe("default error diagnostics", () => {
    let logging: typeof import("./logging.js");

    beforeAll(async () => {
      // Cold diagnostics can compile worker artifacts; prepare them before behavior deadlines.
      [logging] = await Promise.all([
        import("./logging.js"),
        import("./cli/dotenv.js"),
        import("./logging/json-console-line.js"),
      ]);
    });

    it("calls exit(1) via injected exit hook when resolveVersion rejects", async () => {
      const completed = createDeferred();
      const exit = vi.fn(() => completed.resolve());
      const output = vi.fn();
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const resolveVersion = vi
        .fn<() => Promise<never>>()
        .mockRejectedValue(new Error("version resolution failed"));

      try {
        const handled = tryHandleRootVersionFastPath(["node", "openclaw", "--version"], {
          output,
          exit,
          resolveVersion,
        });
        await withTestTimeout(completed.promise, 10_000, "version failure did not exit");
        expect(handled).toBe(true);
        expect(resolveVersion).toHaveBeenCalledTimes(1);
        expect(exit).toHaveBeenCalledWith(1);
        expect(output).not.toHaveBeenCalled();
        expect(exit).toHaveBeenCalledTimes(1);
        expect(stderrSpy.mock.calls.map(([value]) => String(value)).join("\n")).toContain(
          "version resolution failed",
        );
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it("structures version-resolution failures for JSON console output", async () => {
      const completed = createDeferred();
      const exit = vi.fn(() => completed.resolve());
      const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const resolveVersion = vi
        .fn<() => Promise<never>>()
        .mockRejectedValue(new Error("version resolution failed"));
      logging.setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "json" });

      try {
        const handled = tryHandleRootVersionFastPath(["node", "openclaw", "--version"], {
          exit,
          resolveVersion,
        });
        await withTestTimeout(completed.promise, 10_000, "JSON version failure did not exit");
        expect(handled).toBe(true);
        expect(exit).toHaveBeenCalledWith(1);
        const line = stderrSpy.mock.calls.map(([value]) => String(value)).join("");
        expect(JSON.parse(line)).toMatchObject({
          level: "error",
          message: expect.stringContaining("version resolution failed"),
        });
      } finally {
        logging.resetLogger();
        stderrSpy.mockRestore();
      }
    });
  });

  it("calls injected onError when provided and resolveVersion rejects", async () => {
    const exit = vi.fn();
    const completed = createDeferred();
    const onError = vi.fn(() => completed.resolve());
    const resolveVersion = vi
      .fn<() => Promise<never>>()
      .mockRejectedValue(new Error("version resolution failed"));

    expect(
      tryHandleRootVersionFastPath(["node", "openclaw", "--version"], {
        exit,
        onError,
        resolveVersion,
      }),
    ).toBe(true);
    await completed.promise;
    expect(resolveVersion).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });
});
