import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createComputerTool } from "../../src/agents/tools/computer-tool.js";

type ComputerToolOptions = NonNullable<Parameters<typeof createComputerTool>[0]>;

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  cleanup: vi.fn<(reason: string) => Promise<void>>(),
  execFile: vi.fn(() => {
    throw new Error("Unexpected desktop process invocation");
  }),
  mkdir: vi.fn(async () => {}),
  writeFile: vi.fn(async () => {
    throw new Error("Unexpected proof artifact write");
  }),
}));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("node:fs/promises", () => ({ mkdir: mocks.mkdir, writeFile: mocks.writeFile }));
vi.mock("../../src/agents/tools/computer-tool.js", () => ({
  createComputerTool: (options: ComputerToolOptions) => {
    options.registerRunCleanup?.(mocks.cleanup);
    return { execute: mocks.execute };
  },
}));
vi.mock("../../src/agents/tools/nodes-utils.js", () => ({
  listNodes: async () => [
    {
      nodeId: "fixture-node",
      connected: true,
      commands: ["computer.act", "screen.snapshot"],
      computerUse: { provider: { id: "peekaboo" } },
    },
  ],
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.cleanup.mockReset().mockResolvedValue(undefined);
  process.argv = [
    process.execPath,
    path.resolve("scripts/dev/computer-use-macos-live-proof.ts"),
    "--provider",
    "peekaboo",
    "--window-title",
    "Synthetic fixture",
    "--text",
    "fixture text",
    "--artifacts",
    "synthetic-proof-artifacts",
  ];
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("computer-use live proof cleanup", () => {
  it.each([false, true])(
    "closes its execution after the first action fails (cleanup fails: %s)",
    async (cleanupFails) => {
      const actionError = new Error("Synthetic snapshot failure");
      const cleanupError = new Error("Synthetic cleanup failure");
      mocks.execute.mockRejectedValue(actionError);
      if (cleanupFails) {
        mocks.cleanup.mockRejectedValue(cleanupError);
      }

      const error = await import("../../scripts/dev/computer-use-macos-live-proof.ts").catch(
        (cause: unknown) => cause,
      );

      expect(mocks.execute).toHaveBeenCalledOnce();
      expect(mocks.cleanup).toHaveBeenCalledExactlyOnceWith("error");
      expect(mocks.execFile).not.toHaveBeenCalled();
      expect(mocks.writeFile).not.toHaveBeenCalled();
      if (cleanupFails) {
        expect(error).toBeInstanceOf(AggregateError);
        if (!(error instanceof AggregateError)) {
          throw error;
        }
        expect(error.errors).toHaveLength(2);
        expect(error.errors[0]).toBe(actionError);
        expect(error.errors[1]).toBe(cleanupError);
        expect(error.cause).toBe(cleanupError);
      } else {
        expect(error).toBe(actionError);
      }
    },
  );
});
