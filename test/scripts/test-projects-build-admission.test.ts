import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../helpers/promise.js";

const commands = vi.hoisted(() => ({ prepare: vi.fn(), prepareE2e: vi.fn(), reader: vi.fn() }));
vi.mock("../../scripts/lib/managed-child-process.mts", () => ({
  runManagedCommand: commands.prepare,
}));
vi.mock("../../scripts/lib/vitest-build-prerequisites.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/vitest-build-prerequisites.mts")>()),
  runE2eGlobalSetup: commands.prepareE2e,
}));
vi.mock("../../scripts/run-vitest.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/run-vitest.mts")>()),
  spawnWatchedVitestProcess: commands.reader,
}));
vi.mock("../../scripts/lib/vitest-shard-timings.mts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/vitest-shard-timings.mts")>()),
  readShardTimings: () => new Map(),
  writeShardTimings: () => {},
}));

const modelTarget = "src/agents/embedded-agent-runner/model-resolution-consistency.test.ts";
const targets = [modelTarget, "extensions/qa-lab/src/suite-process-lifecycle.test.ts"];
const e2eTarget = "test/openclaw-launcher-version.e2e.test.ts";
const e2eConfig = "test/vitest/vitest.e2e.config.ts";
let originalArgv: string[];
let originalExitCode: typeof process.exitCode;
let terminal: ReturnType<typeof createDeferred<unknown>>;

beforeEach(() => {
  vi.resetModules();
  commands.prepare.mockReset();
  commands.prepareE2e.mockReset();
  commands.reader.mockReset().mockImplementation(() => ({
    completion: Promise.resolve({ code: 0, signal: null }),
    getForwardedSignal: () => undefined,
  }));
  originalArgv = process.argv;
  originalExitCode = process.exitCode;
  process.exitCode = undefined;
  vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", "");
  vi.stubEnv("OPENCLAW_BUILD_PRIVATE_QA", "");
  vi.stubEnv("OPENCLAW_E2E_SKIP_BUILD", "");
  vi.stubEnv("OPENCLAW_E2E_USE_PREBUILT_DIST", "");
  terminal = createDeferred<unknown>();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((value: unknown) => {
    if (value instanceof Error || /^\[test\] (passed|failed|skipped) /u.test(String(value))) {
      terminal.resolve(value);
    }
  });
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function start(args: string[]) {
  process.argv = [process.execPath, "scripts/test-projects.mts", ...args];
  await import("../../scripts/test-projects.mts");
}

describe("test-projects build admission", () => {
  it.each([false, true])(
    "holds every reader until preparation completes (parallel=%s)",
    async (parallel) => {
      vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", parallel ? "2" : "");
      const preparation = createDeferred<number>();
      const readers = createDeferred<{ code: number; signal: null }>();
      commands.prepare.mockReturnValue(preparation.promise);
      commands.reader.mockImplementation(() => ({
        completion: readers.promise,
        getForwardedSignal: () => undefined,
      }));
      await start(targets);
      try {
        expect(commands.reader).not.toHaveBeenCalled();
        expect(commands.prepare).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            args: ["scripts/run-node.mjs", "--version"],
            env: expect.objectContaining({ OPENCLAW_BUILD_PRIVATE_QA: "1" }),
          }),
        );
        preparation.resolve(0);
        await vi.waitFor(() => expect(commands.reader).toHaveBeenCalledTimes(parallel ? 2 : 1));
      } finally {
        preparation.resolve(0);
        readers.resolve({ code: 0, signal: null });
        await terminal.promise;
      }
      expect(await terminal.promise).toMatch(/^\[test\] passed 2 Vitest shards/u);
      expect(commands.reader).toHaveBeenCalledTimes(2);
      expect(process.exitCode).toBeUndefined();
    },
  );

  it.each(["exit", "throw"])("admits no readers when preparation fails by %s", async (failure) => {
    commands.prepare.mockImplementation(async () => {
      if (failure === "throw") {
        throw new Error("build failed");
      }
      return 7;
    });
    await start(targets);
    await terminal.promise;
    expect(commands.reader).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(failure === "throw" ? 1 : 7);
  });

  it("starts unrelated tests without runtime preparation", async () => {
    await start([modelTarget]);
    expect(await terminal.promise).toMatch(/^\[test\] passed 1 Vitest shard/u);
    expect(commands.prepare).not.toHaveBeenCalled();
    expect(commands.reader).toHaveBeenCalledOnce();
  });

  it("coalesces mixed E2E and private QA preparation before marking only E2E prebuilt", async () => {
    vi.stubEnv("OPENCLAW_TEST_PROJECTS_PARALLEL", "2");
    const preparation = createDeferred();
    commands.prepareE2e.mockReturnValue(preparation.promise);
    await start([...targets, e2eTarget]);
    try {
      expect(commands.prepareE2e).toHaveBeenCalledOnce();
      expect(commands.prepare).not.toHaveBeenCalled();
      expect(commands.reader).not.toHaveBeenCalled();
    } finally {
      preparation.resolve();
      await terminal.promise;
    }
    expect(await terminal.promise).toMatch(/^\[test\] passed 3 Vitest shards/u);
    expect(commands.prepare).not.toHaveBeenCalled();
    expect(commands.reader).toHaveBeenCalledTimes(3);
    for (const [options] of commands.reader.mock.calls) {
      expect(options.env.OPENCLAW_E2E_USE_PREBUILT_DIST).toBe(
        options.pnpmArgs.includes(e2eConfig) ? "1" : "",
      );
    }
  });

  it("admits no mixed readers when E2E preparation fails", async () => {
    commands.prepareE2e.mockRejectedValue(new Error("E2E build failed"));
    await start([...targets, e2eTarget]);
    await terminal.promise;
    expect(commands.prepare).not.toHaveBeenCalled();
    expect(commands.reader).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each(["OPENCLAW_E2E_SKIP_BUILD", "OPENCLAW_E2E_USE_PREBUILT_DIST"] as const)(
    "preserves the explicit %s contract",
    async (key) => {
      vi.stubEnv(key, "1");
      await start([...targets, e2eTarget]);
      await terminal.promise;
      expect(commands.prepareE2e).not.toHaveBeenCalled();
      expect(commands.prepare).not.toHaveBeenCalled();
      expect(commands.reader).toHaveBeenCalledTimes(3);
      for (const [options] of commands.reader.mock.calls) {
        expect(options.env[key]).toBe("1");
      }
    },
  );
});
