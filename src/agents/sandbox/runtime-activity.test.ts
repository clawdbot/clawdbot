import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";
import { SANDBOX_STATE_DIR } from "./constants.js";
import {
  coordinateSandboxBackendHandle,
  resolveSandboxRuntimeActivityKey,
  tryWithSandboxRuntimeMutations,
} from "./runtime-activity.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createHandle(runtimeId = "runtime"): SandboxBackendHandle {
  return {
    id: "test",
    runtimeId,
    runtimeLabel: runtimeId,
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
  it("makes active work visible to automatic pruning in another process", async () => {
    const runtimeId = `cross-process-${process.pid}-${Date.now()}`;
    const childSource = String.raw`
      const { coordinateSandboxBackendHandle } = await import("./src/agents/sandbox/runtime-activity.ts");
      const runtimeId = process.argv[1];
      const backend = coordinateSandboxBackendHandle({
        id: "test",
        runtimeId,
        runtimeLabel: runtimeId,
        workdir: "/workspace",
        async buildExecSpec() { return { argv: ["true"], env: {}, stdinMode: "pipe-closed" }; },
        async runShellCommand() { return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }; },
      });
      const spec = await backend.buildExecSpec({ command: "hold", env: {}, usePty: false });
      process.stdout.write("ready\n");
      process.stdin.resume();
      process.stdin.once("end", async () => {
        await backend.finalizeExec?.({ status: "completed", exitCode: 0, timedOut: false, token: spec.finalizeToken });
        process.stdout.write("released\n");
      });
    `;
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", childSource, runtimeId],
      {
        cwd: process.cwd(),
        env: { ...process.env, OPENCLAW_STATE_DIR: path.dirname(SANDBOX_STATE_DIR) },
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    await once(child.stdout, "data");
    const key = resolveSandboxRuntimeActivityKey("test", runtimeId);

    await expect(tryWithSandboxRuntimeMutations([key], async () => undefined)).resolves.toEqual({
      acquired: false,
    });

    child.stdin.end();
    await once(child.stdout, "data");
    await once(child, "exit");
    await expect(tryWithSandboxRuntimeMutations([key], async () => "removed")).resolves.toEqual({
      acquired: true,
      value: "removed",
    });
  });

  it("admits concurrent activity for one runtime across processes", async () => {
    const runtimeId = `concurrent-${process.pid}-${Date.now()}`;
    const childSource = String.raw`
      const { coordinateSandboxBackendHandle } = await import("./src/agents/sandbox/runtime-activity.ts");
      const runtimeId = process.argv[1];
      const backend = coordinateSandboxBackendHandle({
        id: "test",
        runtimeId,
        runtimeLabel: runtimeId,
        workdir: "/workspace",
        async buildExecSpec() { return { argv: ["true"], env: {}, stdinMode: "pipe-closed" }; },
        async runShellCommand() { return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }; },
      });
      const spec = await backend.buildExecSpec({ command: "hold", env: {}, usePty: false });
      process.stdout.write("ready\n");
      process.stdin.resume();
      process.stdin.once("end", async () => {
        await backend.finalizeExec?.({ status: "completed", exitCode: 0, timedOut: false, token: spec.finalizeToken });
      });
    `;
    const start = () =>
      spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "--eval", childSource, runtimeId],
        {
          cwd: process.cwd(),
          env: { ...process.env, OPENCLAW_STATE_DIR: path.dirname(SANDBOX_STATE_DIR) },
          stdio: ["pipe", "pipe", "inherit"],
        },
      );
    const first = start();
    await once(first.stdout, "data");
    const second = start();
    await expect(
      Promise.race([
        once(second.stdout, "data").then(() => true),
        new Promise<false>((resolve) => {
          setTimeout(() => resolve(false), 2_000);
        }),
      ]),
    ).resolves.toBe(true);

    first.stdin.end();
    second.stdin.end();
    await Promise.all([once(first, "exit"), once(second, "exit")]);
  });

  it("rejects a handle after its shared runtime generation changes", async () => {
    const dir = tempDirs.make("openclaw-runtime-generation-");
    const generationPath = path.join(dir, "generation");
    await fs.writeFile(generationPath, "first", "utf8");
    const backend = coordinateSandboxBackendHandle(
      createHandle(`shared-${Date.now()}`),
      async () => {
        if ((await fs.readFile(generationPath, "utf8")) !== "first") {
          throw new Error("Sandbox runtime was recycled before the operation started.");
        }
      },
    );

    await fs.writeFile(generationPath, "second", "utf8");
    await expect(
      backend.buildExecSpec({ command: "stale", env: {}, usePty: false }),
    ).rejects.toThrow("was recycled");
  });

  it("retires a runtime generation after active execution releases", async () => {
    const runtimeId = `retire-${Date.now()}`;
    const raw = createHandle(runtimeId);
    const backend = coordinateSandboxBackendHandle(raw);
    const first = await backend.buildExecSpec({ command: "first", env: {}, usePty: false });
    const key = resolveSandboxRuntimeActivityKey(backend.id, backend.runtimeId);
    await expect(tryWithSandboxRuntimeMutations([key], async () => undefined)).resolves.toEqual({
      acquired: false,
    });
    await backend.finalizeExec?.({
      status: "completed",
      exitCode: 0,
      timedOut: false,
      token: first.finalizeToken,
    });
    await expect(
      tryWithSandboxRuntimeMutations([key], async (lifecycle) => lifecycle.retire()),
    ).resolves.toMatchObject({ acquired: true });
    await expect(
      backend.buildExecSpec({ command: "stale", env: {}, usePty: false }),
    ).rejects.toThrow("was recycled");
    const fresh = coordinateSandboxBackendHandle(createHandle(runtimeId));
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
    const raw = createHandle(`finalize-${Date.now()}`);
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
      tryWithSandboxRuntimeMutations(
        [resolveSandboxRuntimeActivityKey(backend.id, backend.runtimeId)],
        async () => "removed",
      ),
    ).resolves.toEqual({ acquired: true, value: "removed" });
  });
});
