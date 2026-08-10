import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCodeModeConfig } from "./code-mode-runtime.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: vi.fn(async (file: Parameters<typeof original.readFile>[0]) => {
      if (String(file).endsWith("quickjs.wasm")) {
        throw new Error("synthetic QuickJS initialization failure");
      }
      return await original.readFile(file);
    }),
  };
});

describe("Code Mode worker initialization", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("does not report a worker when QuickJS initialization fails", async () => {
    const { runCodeModeWorker } = await import("./code-mode-worker.js");
    const config = resolveCodeModeConfig({ tools: { codeMode: true } } as never);
    const onWorkerSpawned = vi.fn();

    const result = await runCodeModeWorker({
      workerData: {
        kind: "exec",
        source: "return true;",
        config,
        catalog: [],
      },
      timeoutMs: 10_000,
      onWorkerSpawned,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "runtime_unavailable",
      error: "synthetic QuickJS initialization failure",
    });
    expect(onWorkerSpawned).not.toHaveBeenCalled();
  });
});
