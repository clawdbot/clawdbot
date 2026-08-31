import * as childProcess from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerClient, isCodexAppServerConnectionClosedError } from "./client.js";
import * as processSnapshot from "./transport-process-snapshot.js";
import { closeCodexAppServerTransportAndWait, hasCodexAppServerNaturalExit } from "./transport.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));

describe.skipIf(process.platform === "win32")("Codex failed launcher startup", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["drained", "held"])("shares the exit budget with %s diagnostic pipes", async (mode) => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      exitCode: 1,
      signalCode: null,
    });
    const diagnostic: string[] = [];
    child.stdout.resume();
    child.stderr.on("data", (data: Buffer) => diagnostic.push(data.toString()));
    const closing = closeCodexAppServerTransportAndWait(child, { drainStdio: true });
    try {
      await vi.advanceTimersByTimeAsync(1_999);
      expect(child.stderr.destroyed).toBe(false);
      expect(hasCodexAppServerNaturalExit(child)).toBe(false);
      child.stderr.write("last startup diagnostic");
      if (mode === "drained") {
        child.stdout.end();
        child.stderr.end();
      } else {
        await vi.advanceTimersByTimeAsync(1);
      }
      await expect(closing).resolves.toBe(mode === "drained");
      expect(diagnostic).toEqual(["last startup diagnostic"]);
      expect(hasCodexAppServerNaturalExit(child)).toBe(mode === "drained");
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  });

  it.each([
    ["signal", "inspection"],
    ["clean", "inspection"],
    ["signal", "commit"],
    ["clean", "commit"],
  ] as const)(
    "reaps inherited-pipe descendants before settling a %s launcher after %s refusal",
    async (exitMode, failure) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-startup-launcher-"));
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      const { createPluginStateSyncKeyedStore } =
        await import("openclaw/plugin-sdk/plugin-state-store-runtime");
      const store = createPluginStateSyncKeyedStore("codex", {
        namespace: "app-server-processes",
        maxEntries: 512,
        overflowPolicy: "reject-new",
      });
      const nativePath = path.join(root, "native.mjs");
      const wrapperPath = path.join(root, "wrapper.mjs");
      const readyPath = path.join(root, "native.pid");
      const inputPath = path.join(root, "input");
      await fs.writeFile(
        nativePath,
        `
import fs from "node:fs";
const [ready, input] = process.argv.slice(2);
process.stdin.on("data", (data) => fs.appendFileSync(input, data));
setInterval(() => {}, 1_000);
fs.writeSync(2, "launcher startup diagnostic\\n");
fs.writeFileSync(ready, String(process.pid));
`,
      );
      // Matches the pinned npm launcher: inherited pipes and signal forwarding,
      // with an additional clean-exit wrapper proving cleanup cause precedence.
      await fs.writeFile(
        wrapperPath,
        `
import { spawn } from "node:child_process";
const [native, ready, input, exitMode] = process.argv.slice(2);
const child = spawn(process.execPath, [native, ready, input], { stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  if (exitMode === "clean") process.exit(0);
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
`,
      );
      const spawn = childProcess.spawn;
      let wrapper: childProcess.ChildProcess | undefined;
      let wrapperClosed: Promise<unknown> | undefined;
      let nativePid: number | undefined;
      let nativeExited = false;
      const spawnSpy = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
        const child = spawn(...args);
        if (Array.isArray(args[1]) && args[1].includes(wrapperPath)) {
          wrapper = child;
          wrapperClosed = once(child, "close");
        }
        return child;
      });
      const readCommand = processSnapshot.readCodexAppServerProcessCommand;
      let inspected!: () => void;
      const inspection = new Promise<void>((resolve) => {
        inspected = resolve;
      });
      vi.spyOn(processSnapshot, "readCodexAppServerProcessCommand").mockImplementation(
        async (observed, deadline) => {
          if (observed.pid !== wrapper?.pid) {
            return readCommand(observed, deadline);
          }
          await expect.poll(() => fs.readFile(readyPath, "utf8").catch(() => "")).not.toBe("");
          nativePid = Number(await fs.readFile(readyPath, "utf8"));
          const command = await readCommand(observed, deadline);
          expect(command).toBeDefined();
          if (failure === "commit") {
            for (let index = 0; index < 512; index++) {
              store.register(`capacity-${index}`, {});
            }
          }
          inspected();
          if (failure === "inspection") {
            throw new processSnapshot.ProcessInspectionError("unavailable");
          }
          return command;
        },
      );
      const started = CodexAppServerClient.start({
        transport: "stdio",
        command: process.execPath,
        commandSource: "config",
        args: [wrapperPath, nativePath, readyPath, inputPath, exitMode],
      }).catch((error: unknown) => error);
      try {
        await Promise.race([
          inspection,
          started.then(() => {
            throw new Error("Startup settled before fixture inspection");
          }),
        ]);
        // Observe actual cleanup before awaiting startup: an outer acquire timeout
        // must not make an unregistered native descendant look safely settled.
        await expect
          .poll(
            async () => {
              const snapshot = await processSnapshot.readCodexAppServerProcessSnapshot(
                Date.now() + 2_000,
              );
              expect(snapshot?.some(({ pid }) => pid === process.pid)).toBe(true);
              const row = snapshot?.find(({ pid }) => pid === nativePid);
              return row !== undefined && !row.state.startsWith("Z");
            },
            { timeout: 5_000 },
          )
          .toBe(false);
        nativeExited = true;
        const error = await started;
        expect(error).toBeInstanceOf(Error);
        expect(isCodexAppServerConnectionClosedError(error)).toBe(false);
        expect((error as Error).message).toContain(
          failure === "inspection" ? "Cannot inspect Codex processes" : "512-row limit",
        );
        expect((error as Error).message).toContain("launcher startup diagnostic");
        expect(
          spawnSpy.mock.calls.filter(
            ([, args]) => Array.isArray(args) && args.includes(wrapperPath),
          ),
        ).toHaveLength(1);
        await expect(fs.access(inputPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(wrapper?.stdout?.destroyed).toBe(true);
        expect(wrapper?.stderr?.destroyed).toBe(true);
        expect(wrapper?.exitCode).toBe(exitMode === "clean" ? 0 : null);
        expect(wrapper?.signalCode).toBe(exitMode === "clean" ? null : "SIGKILL");
      } finally {
        vi.restoreAllMocks();
        nativePid ??= Number(await fs.readFile(readyPath, "utf8").catch(() => "")) || undefined;
        if (nativePid && !nativeExited) {
          try {
            process.kill(nativePid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }
        wrapper?.kill("SIGKILL");
        await wrapperClosed;
        await started;
        store.clear();
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
