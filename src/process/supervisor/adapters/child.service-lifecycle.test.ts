import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as realDelay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForPidFile } from "../../../../test/helpers/process-wait.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { killPidIfAlive } from "../../../test-utils/process-tree.js";
import { createProcessSupervisor } from "../supervisor.js";
import { createChildAdapter } from "./child.js";

const activePids = new Set<number>();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
  if (process.platform !== "linux") {
    return true;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // kill(pid, 0) also succeeds for a terminated process awaiting reaping.
    return stat.charAt(stat.lastIndexOf(")") + 2) !== "Z";
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("timed out waiting for process state");
    }
    await realDelay(20);
  }
}

function parsePidPair(output: string): [number, number] {
  const match = /(\d+)\s+(\d+)/u.exec(output);
  if (!match?.[1] || !match[2]) {
    throw new Error(`expected PID pair in output: ${JSON.stringify(output)}`);
  }
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)];
}

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.OPENCLAW_SERVICE_MARKER;
  for (const pid of activePids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await waitFor(() => [...activePids].every((pid) => !isAlive(pid))).catch(() => {});
  activePids.clear();
});

describe.skipIf(process.platform === "win32")("POSIX child invocation identity", () => {
  it.each(["direct", "service-managed"] as const)(
    "preserves caller-selected argv0 through the %s path",
    async (mode) => {
      if (mode === "service-managed") {
        process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
      }
      const tempDir = tempDirs.make(`openclaw-${mode}-argv0-`);
      const executableAlias = path.join(tempDir, "claude-shim");
      await symlink(process.execPath, executableAlias);
      const run = await createProcessSupervisor().spawn({
        mode: "child",
        argv: [process.execPath, "-e", "process.stdout.write(process.argv0)"],
        argv0: executableAlias,
        sessionId: `argv0-${mode}`,
        backendId: "argv0-test",
        stdinMode: "pipe-closed" as const,
      });

      await expect(run.wait()).resolves.toMatchObject({
        reason: "exit",
        exitCode: 0,
        exitSignal: null,
        stdout: executableAlias,
      });
      await run.waitForExtinction?.();
    },
  );
});

describe.skipIf(process.platform === "win32")("service-managed child lifecycle", () => {
  it("cancels the complete admitted command group before settling", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    const adapter = await createChildAdapter({
      argv: [
        "/bin/sh",
        "-c",
        'sleep 60 >/dev/null 2>&1 & child=$!; printf "%s %s\\n" "$$" "$child"; wait',
      ],
      stdinMode: "pipe-closed",
    });
    let output = "";
    adapter.onStdout((chunk) => {
      output += chunk;
    });
    await waitFor(() => /^\d+ \d+/u.test(output));
    const [rootPid, descendantPid] = parsePidPair(output);
    activePids.add(rootPid);
    activePids.add(descendantPid);

    adapter.kill("SIGTERM");
    await adapter.wait();
    await waitFor(() => !isAlive(rootPid));

    expect(isAlive(descendantPid)).toBe(false);
  });

  it.each([
    { reason: "overall-timeout" as const, timeoutMs: 100, noOutputTimeoutMs: undefined },
    { reason: "no-output-timeout" as const, timeoutMs: undefined, noOutputTimeoutMs: 100 },
  ])("removes the group before returning $reason", async (timing) => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    // Deadlines include construction. Hold the clock until the real PID banner
    // so this case tests admitted-group cleanup independently of startup speed.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const supervisor = createProcessSupervisor();
    let output = "";
    try {
      const run = await supervisor.spawn({
        mode: "child",
        argv: [
          "/bin/sh",
          "-c",
          'sleep 60 >/dev/null 2>&1 & child=$!; printf "%s %s\\n" "$$" "$child"; wait',
        ],
        stdinMode: "pipe-closed",
        sessionId: "service-lifecycle-test",
        backendId: "service-lifecycle-test",
        timeoutMs: timing.timeoutMs,
        noOutputTimeoutMs: timing.noOutputTimeoutMs,
        onStdout: (chunk) => {
          output += chunk;
        },
      });
      await waitFor(() => /^\d+ \d+/u.test(output));
      const [rootPid, descendantPid] = parsePidPair(output);
      activePids.add(rootPid);
      activePids.add(descendantPid);
      expect(isAlive(rootPid) && isAlive(descendantPid)).toBe(true);
      await vi.advanceTimersByTimeAsync(100);
      const exit = await run.wait();
      expect(exit.reason).toBe(timing.reason);
      expect(parsePidPair(exit.stdout)).toEqual([rootPid, descendantPid]);
      await waitFor(() => !isAlive(rootPid) && !isAlive(descendantPid));
    } finally {
      vi.useRealTimers();
      await supervisor.shutdown();
    }
  });

  it("preserves construction cleanup uncertainty while the real command self-cleans", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    const cwd = tempDirs.make("openclaw-service-secret-construction-");
    const pidPath = path.join(cwd, "command.pid");
    const termPath = path.join(cwd, "command.term.pid");
    const command = `
      process.on("SIGTERM", () => {
        require("node:fs").writeFileSync(${JSON.stringify(termPath)}, String(process.pid));
        process.exit(0);
      });
      require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
      setInterval(() => {}, 1000);
    `;
    const supervisor = createProcessSupervisor();
    const runId = "service-secret-construction";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pendingRun = supervisor.spawn({
      runId,
      scopeKey: runId,
      mode: "child",
      argv: [process.execPath, "-e", command],
      stdinMode: "pipe-closed",
      sessionId: "service-secret-construction",
      backendId: "service-secret-construction",
      timeoutMs: 500,
      secretInput: {
        fd: 3,
        createData: () => Buffer.alloc(8 * 1024 * 1024, 97),
      },
    });
    let commandPid: number | undefined;
    try {
      const startedPid = await waitForPidFile(pidPath, 5_000, realDelay);
      commandPid = startedPid;
      activePids.add(startedPid);
      expect(isAlive(startedPid)).toBe(true);
      expect(supervisor.getRecord(runId)).toMatchObject({ state: "starting" });
      await vi.advanceTimersByTimeAsync(500);
      expect(supervisor.getRecord(runId)).toMatchObject({
        state: "exited",
        terminationReason: "overall-timeout",
      });
      const run = await pendingRun;
      await expect(run.wait()).resolves.toMatchObject({
        reason: "overall-timeout",
        timedOut: true,
      });
      await expect(supervisor.waitForScope(runId)).rejects.toThrow("cleanup identity lost");
      await expect(run.waitForExtinction?.()).rejects.toThrow("cleanup identity lost");
      await expect(supervisor.shutdown()).rejects.toThrow("cleanup identity lost");
      // TERM must still reach the command after failed cleanup joins. Dedicated
      // escalation cases cover commands that keep running through the TERM grace.
      await waitForPidFile(termPath, 5_000, realDelay);
      await waitFor(() => !isAlive(startedPid));
    } finally {
      vi.useRealTimers();
      supervisor.cancel(runId);
      killPidIfAlive(commandPid);
      await pendingRun.catch(() => {});
      await supervisor.shutdown().catch(() => {});
    }
  });

  it("preserves root-result timing while retaining descendant cleanup ownership", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    const adapter = await createChildAdapter({
      argv: [
        "/bin/sh",
        "-c",
        'sleep 0.4 >/dev/null 2>&1 & child=$!; printf "%s %s\\n" "$$" "$child"; exit 0',
      ],
      stdinMode: "pipe-closed",
    });
    let output = "";
    adapter.onStdout((chunk) => {
      output += chunk;
    });
    const startedAt = Date.now();
    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
    const elapsed = Date.now() - startedAt;
    const [, descendantPid] = parsePidPair(output);
    activePids.add(descendantPid);

    expect(elapsed).toBeLessThan(300);
    expect(isAlive(descendantPid)).toBe(true);
    await adapter.waitForExtinction?.();
    await waitFor(() => !isAlive(descendantPid));
  });

  it("flushes forwarded output before exposing the root result", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    const outputBytes = 8 * 1024 * 1024;
    const adapter = await createChildAdapter({
      argv: [process.execPath, "-e", `process.stdout.write(Buffer.alloc(${outputBytes}, 120))`],
      stdinMode: "pipe-closed",
    });
    let receivedBytes = 0;
    adapter.onStdout((chunk) => {
      receivedBytes += Buffer.byteLength(chunk);
    });

    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
    expect(receivedBytes).toBe(outputBytes);
  });

  it("retains output emitted before adapter listeners subscribe", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    const adapter = await createChildAdapter({
      argv: [
        process.execPath,
        "-e",
        'process.stdout.write("early stdout"); process.stderr.write("early stderr");',
      ],
      stdinMode: "pipe-closed",
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });

    let stdout = "";
    let stderr = "";
    adapter.onStdout((chunk) => {
      stdout += chunk;
    });
    adapter.onStderr((chunk) => {
      stderr += chunk;
    });

    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
    expect(stdout).toBe("early stdout");
    expect(stderr).toBe("early stderr");
  });

  it("preserves an exited root result when cleanup races forwarded output", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    const outputBytes = 8 * 1024 * 1024;
    const adapter = await createChildAdapter({
      argv: [
        "/bin/sh",
        "-c",
        `${process.execPath} -e 'process.stdout.write(Buffer.alloc(${outputBytes}, 120))'; sleep 60 >/dev/null 2>&1 & exit 0`,
      ],
      stdinMode: "pipe-closed",
    });
    const rootPid = adapter.pid!;
    activePids.add(rootPid);
    let receivedBytes = 0;
    adapter.onStdout((chunk) => {
      receivedBytes += Buffer.byteLength(chunk);
    });
    await waitFor(() => !isAlive(rootPid));

    adapter.kill("SIGTERM");

    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
    expect(receivedBytes).toBe(outputBytes);
  });

  it("revalidates and escalates when the group ignores SIGTERM", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    const adapter = await createChildAdapter({
      argv: [
        "/bin/sh",
        "-c",
        `trap '' TERM; /bin/sh -c 'trap "" TERM; sleep 60' >/dev/null 2>&1 & child=$!; printf "%s %s\\n" "$$" "$child"; wait`,
      ],
      stdinMode: "pipe-closed",
    });
    let output = "";
    adapter.onStdout((chunk) => {
      output += chunk;
    });
    await waitFor(() => /^\d+ \d+/u.test(output));
    const [rootPid, descendantPid] = parsePidPair(output);
    activePids.add(rootPid);
    activePids.add(descendantPid);

    adapter.kill("SIGTERM");
    await adapter.wait();
    await waitFor(() => !isAlive(rootPid) && !isAlive(descendantPid));
  });

  it("self-cleans when lineage closes but a descendant retains output", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    const tempDir = tempDirs.make("openclaw-service-child-natural-lineage-");
    const descendantPath = path.join(tempDir, "descendant.cjs");
    const rootPath = path.join(tempDir, "root.cjs");
    await writeFile(
      descendantPath,
      `
        const fs = require("node:fs");
        fs.closeSync(3);
        process.send("ready");
        setInterval(() => {}, 1000);
      `,
      "utf8",
    );
    await writeFile(
      rootPath,
      `
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, [${JSON.stringify(descendantPath)}], {
          stdio: ["ignore", 1, 2, 3, "ipc"],
        });
        child.once("message", () => {
          process.stdout.write(process.pid + " " + child.pid + "\\n", () => {
            child.disconnect();
            process.exit(0);
          });
        });
      `,
      "utf8",
    );
    const adapter = await createChildAdapter({
      argv: [process.execPath, rootPath],
      stdinMode: "pipe-closed",
    });
    let output = "";
    adapter.onStdout((chunk) => {
      output += chunk;
    });
    await waitFor(() => /^\d+ \d+/u.test(output));
    const [rootPid, descendantPid] = parsePidPair(output);
    activePids.add(rootPid);
    activePids.add(descendantPid);

    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
    await waitFor(() => !isAlive(rootPid) && !isAlive(descendantPid));
  });

  it("preserves the supervisor TERM grace for a delayed authentic root result", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    const tempDir = tempDirs.make("openclaw-service-child-term-grace-");
    const descendantPath = path.join(tempDir, "descendant.cjs");
    const rootPath = path.join(tempDir, "root.cjs");
    await writeFile(
      descendantPath,
      `
        const fs = require("node:fs");
        process.on("SIGTERM", () => {
          fs.closeSync(3);
          process.exit(0);
        });
        process.send("ready");
        setInterval(() => {}, 1000);
      `,
      "utf8",
    );
    await writeFile(
      rootPath,
      `
        const fs = require("node:fs");
        const { spawn } = require("node:child_process");
        const child = spawn(process.execPath, [${JSON.stringify(descendantPath)}], {
          stdio: ["ignore", 1, 2, 3, "ipc"],
        });
        process.on("SIGTERM", () => {
          fs.closeSync(3);
          setTimeout(() => {
            fs.writeSync(1, "graceful stdout\\n");
            fs.writeSync(2, "graceful stderr\\n");
            process.exit(23);
          }, 1500);
        });
        child.once("message", () => {
          process.stdout.write(process.pid + " " + child.pid + "\\n");
          child.disconnect();
        });
        setInterval(() => {}, 1000);
      `,
      "utf8",
    );
    let streamedStdout = "";
    let streamedStderr = "";
    const run = await createProcessSupervisor().spawn({
      mode: "child",
      argv: [process.execPath, rootPath],
      stdinMode: "pipe-closed",
      sessionId: "service-term-grace-test",
      backendId: "service-term-grace-test",
      onStdout: (chunk) => {
        streamedStdout += chunk;
      },
      onStderr: (chunk) => {
        streamedStderr += chunk;
      },
    });
    await waitFor(() => /^\d+ \d+/u.test(streamedStdout));
    const [rootPid, descendantPid] = parsePidPair(streamedStdout);
    activePids.add(rootPid);
    activePids.add(descendantPid);

    run.cancel();
    const exit = await run.wait();

    expect(exit).toMatchObject({
      reason: "manual-cancel",
      exitCode: 23,
      exitSignal: null,
    });
    expect(exit.stdout).toContain("graceful stdout\n");
    expect(exit.stderr).toBe("graceful stderr\n");
    expect(streamedStdout).toContain("graceful stdout\n");
    expect(streamedStderr).toBe("graceful stderr\n");
    await waitFor(() => !isAlive(rootPid) && !isAlive(descendantPid));
  });

  it.each([
    { label: "after TERM grace", repeatKill: false },
    { label: "when repeated KILL arrives", repeatKill: true },
  ])("hard-cleans output-holding descendants $label", async ({ repeatKill }) => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    const tempDir = tempDirs.make("openclaw-service-child-lineage-term-");
    const descendantPath = path.join(tempDir, "descendant.cjs");
    const rootPath = path.join(tempDir, "root.cjs");
    await writeFile(
      descendantPath,
      `
        const fs = require("node:fs");
        process.on("SIGTERM", () => {
          try { fs.closeSync(3); } catch {}
        });
        process.stdout.write(process.ppid + " " + process.pid + "\\n");
        setInterval(() => {}, 1000);
      `,
      "utf8",
    );
    await writeFile(
      rootPath,
      `
        const { spawn } = require("node:child_process");
        process.on("SIGTERM", () => process.exit(0));
        spawn(process.execPath, [${JSON.stringify(descendantPath)}], {
          stdio: ["ignore", 1, 2, 3],
        });
        setInterval(() => {}, 1000);
      `,
      "utf8",
    );
    const adapter = await createChildAdapter({
      argv: [process.execPath, rootPath],
      stdinMode: "pipe-closed",
    });
    let output = "";
    adapter.onStdout((chunk) => {
      output += chunk;
    });
    await waitFor(() => /^\d+ \d+/u.test(output));
    const [rootPid, descendantPid] = parsePidPair(output);
    activePids.add(rootPid);
    activePids.add(descendantPid);

    adapter.kill("SIGTERM");
    if (repeatKill) {
      await waitFor(() => !isAlive(rootPid));
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 200);
      });
      expect(isAlive(descendantPid)).toBe(true);
      adapter.kill("SIGKILL");
    }
    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
    await waitFor(() => !isAlive(rootPid) && !isAlive(descendantPid));
  });

  it("preserves split UTF-8 sequences on service stdout and stderr", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    const adapter = await createChildAdapter({
      argv: [
        process.execPath,
        "-e",
        `setTimeout(() => {
          process.stdout.write(Buffer.from([0xf0, 0x9f]));
          process.stderr.write(Buffer.from([0xf0, 0x9f]));
          setTimeout(() => {
            process.stdout.end(Buffer.from([0x98, 0x80]));
            process.stderr.end(Buffer.from([0x98, 0x80]));
          }, 50);
        }, 100);`,
      ],
      stdinMode: "pipe-closed",
    });
    let stdout = "";
    let stderr = "";
    adapter.onStdout((chunk) => {
      stdout += chunk;
    });
    adapter.onStderr((chunk) => {
      stderr += chunk;
    });

    await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
    expect(stdout).toBe("😀");
    expect(stderr).toBe("😀");
  });

  it("flushes incomplete UTF-8 before exposing a root result with retained authority", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    const descendantScript = "setTimeout(() => {}, 1500)";
    const rootScript = `
      const { spawn } = require("node:child_process");
      const descendant = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {
        stdio: ["ignore", "ignore", "ignore", 3],
      });
      descendant.unref();
      process.stderr.write(descendant.pid + "\\n");
      process.stdout.write(Buffer.from([0x58, 0xe2, 0x82]), () => process.exit(0));
    `;
    let streamed = "";
    const run = await createProcessSupervisor().spawn({
      mode: "child",
      argv: [process.execPath, "-e", rootScript],
      stdinMode: "pipe-closed",
      sessionId: "service-incomplete-utf8-test",
      backendId: "service-incomplete-utf8-test",
      onStdout: (chunk) => {
        streamed += chunk;
      },
    });
    const startedAt = Date.now();
    const exit = await run.wait();
    const elapsed = Date.now() - startedAt;
    const descendantPid = Number.parseInt(exit.stderr.trim(), 10);
    activePids.add(descendantPid);

    expect(exit.stdout).toBe("X�");
    expect(streamed).toBe("X�");
    expect(elapsed).toBeLessThan(1_000);
    expect(isAlive(descendantPid)).toBe(true);
    await waitFor(() => !isAlive(descendantPid));
  });

  it("reports startup failure before secret-pipe failure without an unhandled rejection", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => {
      unhandled.push(error);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        createChildAdapter({
          argv: ["/definitely/not/a/real-command"],
          exactEnv: true,
          stdinMode: "pipe-closed",
          secretInput: {
            fd: 3,
            createData: () => Buffer.alloc(8 * 1024 * 1024, 120),
          },
        }),
      ).rejects.toThrow("ENOENT");
      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it.each(["direct", "service", "owned-worker"] as const)(
    "keeps reopenable secret input distinct from stdin and lifecycle channels (%s)",
    async (mode) => {
      if (mode === "service") {
        process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
      }
      const adapter = await createChildAdapter({
        argv: [
          process.execPath,
          "-e",
          `const fs = require("node:fs");
         const secret = fs.readFileSync(${JSON.stringify(process.platform === "darwin" ? "/dev/fd/3" : "/proc/self/fd/3")}, "utf8").trimEnd();
         const input = fs.readFileSync(0, "utf8");
         process.stdout.write(secret.length + ":" + input);`,
        ],
        ownedWorker: mode === "owned-worker" ? true : undefined,
        stdinMode: "pipe-open",
        secretInput: {
          fd: 3,
          createData: () => Buffer.from("synthetic-secret\n", "utf8"),
        },
      });
      let output = "";
      adapter.onStdout((chunk) => {
        output += chunk;
      });
      adapter.closeStartGate?.();
      adapter.stdin?.write("ordinary-input\n");
      adapter.stdin?.end();

      await expect(adapter.wait()).resolves.toEqual({ code: 0, signal: null });
      expect(output).toBe("16:ordinary-input\n");
    },
  );

  it("fails closed when the command drops its lineage descriptor early", async () => {
    process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
    const adapter = await createChildAdapter({
      argv: ["/bin/sh", "-c", `exec 3>&-; trap '' TERM; printf "%s\\n" "$$"; sleep 60`],
      stdinMode: "pipe-closed",
    });
    let output = "";
    adapter.onStdout((chunk) => {
      output += chunk;
    });
    await waitFor(() => /^\d+/u.test(output));
    const rootPid = Number.parseInt(output, 10);
    activePids.add(rootPid);

    await adapter.wait();
    await waitFor(() => !isAlive(rootPid));
  });

  it("defers an identity-loss rejection until the caller waits", async () => {
    const tempDir = tempDirs.make("openclaw-service-child-identity-loss-");
    const scriptPath = path.join(tempDir, "identity-loss.mts");
    const childModuleUrl = new URL("./child.ts", import.meta.url).href;
    await writeFile(
      scriptPath,
      `
        process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
        const { createChildAdapter } = await import(${JSON.stringify(childModuleUrl)});
        const adapter = await createChildAdapter({
          argv: ["/bin/sh", "-c", "sleep 0.05; kill -KILL $PPID; sleep 0.05"],
          stdinMode: "pipe-closed",
        });
        await new Promise((resolve) => setTimeout(resolve, 200));
        try {
          await adapter.wait();
          process.exit(2);
        } catch {
          process.exit(0);
        }
      `,
      "utf8",
    );
    const host = spawn(process.execPath, ["--import", "tsx", scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OPENCLAW_SERVICE_MARKER: "openclaw" },
    });
    let stderr = "";
    host.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      host.once("exit", resolve);
    });

    expect(exitCode, stderr).toBe(0);
  });

  it("fails closed when the service host exits", async () => {
    const tempDir = tempDirs.make("openclaw-service-child-host-");
    const scriptPath = path.join(tempDir, "host.mts");
    const childModuleUrl = new URL("./child.ts", import.meta.url).href;
    await writeFile(
      scriptPath,
      `
        process.env.OPENCLAW_SERVICE_MARKER = "openclaw";
        const { createChildAdapter } = await import(${JSON.stringify(childModuleUrl)});
        const adapter = await createChildAdapter({
          argv: ["/bin/sh", "-c", 'sleep 60 >/dev/null 2>&1 & child=$!; printf "%s %s\\\\n" "$$" "$child"; wait'],
          stdinMode: "pipe-closed",
        });
        let output = "";
        adapter.onStdout((chunk) => { output += chunk; });
        while (!/^\\d+ \\d+/u.test(output)) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        process.stdout.write("PROBE " + output.trim() + "\\n", () => process.exit(0));
      `,
      "utf8",
    );
    const host = spawn(process.execPath, ["--import", "tsx", scriptPath], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, OPENCLAW_SERVICE_MARKER: "openclaw" },
    });
    let stdout = "";
    let stderr = "";
    host.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    host.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const exitCode = await new Promise<number | null>((resolve) => {
      host.once("exit", resolve);
    });
    expect(exitCode, stderr).toBe(0);
    const [rootPid, descendantPid] = parsePidPair(stdout);
    activePids.add(rootPid);
    activePids.add(descendantPid);

    await waitFor(() => !isAlive(rootPid) && !isAlive(descendantPid));
  });
});
