// Regression tests for code-mode child stderr stream errors in Tool Search.
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type MockSpawnChild = EventEmitter & {
  stderr?: EventEmitter & { setEncoding?: (enc: string) => void };
  send?: (message: unknown, callback?: (error?: Error | null) => void) => boolean;
  connected?: boolean;
  kill?: (signal?: string) => void;
};

function createMockSpawnChild() {
  const child = new EventEmitter() as MockSpawnChild;
  const stderr = new EventEmitter() as MockSpawnChild["stderr"];
  stderr!.setEncoding = vi.fn();
  child.stderr = stderr;
  child.connected = true;
  child.kill = vi.fn();
  child.send = vi.fn(() => true);
  return { child, stderr };
}

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  const spawnLocal = vi.fn(
    (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
      const { child } = createMockSpawnChild();
      return child as unknown as ChildProcess;
    },
  );
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      spawn: spawnLocal as unknown as typeof import("node:child_process").spawn,
    },
  );
});

const spawnMock = vi.mocked(spawn);

let toolSearch: typeof import("./tool-search.js");

describe("tool-search code-mode stream errors", () => {
  beforeAll(async () => {
    toolSearch = await import("./tool-search.js");
  });

  afterEach(() => {
    toolSearch.testing.setToolSearchCodeModeSupportedForTest(undefined);
    toolSearch.testing.setToolSearchMinCodeTimeoutMsForTest(undefined);
  });

  it("rejects stderr errors and leaves the unused stdout unpiped", async () => {
    toolSearch.testing.setToolSearchCodeModeSupportedForTest(true);
    toolSearch.testing.setToolSearchMinCodeTimeoutMsForTest(1000);

    let spawnedChild: MockSpawnChild | undefined;
    spawnMock.mockImplementationOnce(
      (_command: string, _args: readonly string[], _options: SpawnOptions): ChildProcess => {
        const { child, stderr } = createMockSpawnChild();
        spawnedChild = child;
        process.nextTick(() => {
          stderr?.emit("error", new Error("stderr read failed"));
        });
        return child as unknown as ChildProcess;
      },
    );

    const runtime = new toolSearch.ToolSearchRuntime(
      {},
      toolSearch.testing.resolveToolSearchConfig({}),
    );

    await expect(
      toolSearch.testing.runCodeModeChild({
        code: "return 1;",
        config: toolSearch.testing.resolveToolSearchConfig({}),
        logs: [],
        parentToolCallId: "call-stderr-error",
        runtime,
      }),
    ).rejects.toThrow("stderr read failed");
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    expect(spawnedChild?.kill).toHaveBeenCalledOnce();
  });
});
