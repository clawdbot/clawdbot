import { describe, expect, it, vi } from "vitest";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import {
  coordinateSandboxBackendHandle,
  resolveSandboxRuntimeActivityKey,
  withSandboxRuntimeMutations,
} from "./runtime-activity.js";

function createHandle(): SandboxBackendHandle {
  return {
    id: "test",
    runtimeId: "runtime",
    runtimeLabel: "runtime",
    workdir: "/workspace",
    async buildExecSpec() {
      return { argv: ["true"], env: {}, stdinMode: "pipe-closed", finalizeToken: "raw" };
    },
    async finalizeExec() {},
    async runShellCommand() {
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
    },
  };
}

describe("sandbox runtime activity", () => {
  it("blocks new operations behind a queued destructive mutation", async () => {
    const raw = createHandle();
    const backend = coordinateSandboxBackendHandle(raw);
    const first = await backend.buildExecSpec({ command: "first", env: {}, usePty: false });
    const order: string[] = [];
    const mutation = withSandboxRuntimeMutations(
      [resolveSandboxRuntimeActivityKey(backend.id, backend.runtimeId)],
      async () => {
        order.push("mutation");
      },
    );
    const nextOperation = backend.runShellCommand({ script: "true" }).then(() => {
      order.push("next");
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(order).toEqual([]);
    await backend.finalizeExec?.({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: first.finalizeToken,
    });
    await Promise.all([mutation, nextOperation]);

    expect(order).toEqual(["mutation", "next"]);

    await withSandboxRuntimeMutations(
      [resolveSandboxRuntimeActivityKey(backend.id, backend.runtimeId)],
      async (lifecycle) => lifecycle.retire(),
    );
    await expect(
      backend.buildExecSpec({ command: "stale", env: {}, usePty: false }),
    ).rejects.toThrow("was recycled");
    const fresh = coordinateSandboxBackendHandle(createHandle());
    const freshExec = await fresh.buildExecSpec({ command: "fresh", env: {}, usePty: false });
    expect(freshExec).toMatchObject({ argv: ["true"] });
    await fresh.finalizeExec?.({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: freshExec.finalizeToken,
    });
  });

  it("releases the execution lease when backend finalization fails", async () => {
    const raw = createHandle();
    raw.finalizeExec = vi.fn(async () => {
      throw new Error("finalize failed");
    });
    const backend = coordinateSandboxBackendHandle(raw);
    const exec = await backend.buildExecSpec({ command: "true", env: {}, usePty: false });

    await expect(
      backend.finalizeExec?.({
        status: "failed",
        exitCode: 1,
        timedOut: false,
        token: exec.finalizeToken,
      }),
    ).rejects.toThrow("finalize failed");
    await expect(
      withSandboxRuntimeMutations(
        [resolveSandboxRuntimeActivityKey(backend.id, backend.runtimeId)],
        async () => "removed",
      ),
    ).resolves.toBe("removed");
  });
});
