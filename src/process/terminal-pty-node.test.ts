import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createDeferredCore } from "../shared/deferred.js";
import { killPidIfAlive, waitForPidToExit } from "../test-utils/process-tree.js";
import { spawnNodeTerminalPty } from "./terminal-pty-node.js";
import type { TerminalPtyEvent } from "./terminal-pty-protocol.js";
import type { TerminalPtyHandle } from "./terminal-pty.js";

const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.tmpdir(), TERM: "dumb" };
const handles: TerminalPtyHandle[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.kill();
  }
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe.runIf(process.platform !== "win32")("Node-owned terminal PTY", () => {
  it("preserves terminal input, resize ordering, and final output before exit", async () => {
    const handle = await spawnNodeTerminalPty({
      file: "/bin/sh",
      args: [
        "-c",
        'stty -echo; printf "READY\\n"; IFS= read -r input; stty size; printf "%s\\n%s\\n" "$input" "$TERM"; exit 7',
      ],
      cwd: os.tmpdir(),
      env,
      cols: 80,
      rows: 24,
    });
    handles.push(handle);
    let output = "";
    let inputSent = false;
    const done = createDeferredCore<{ exitCode: number; signal?: number }>();
    handle.onExit((event) => done.resolve(event));
    handle.onData((data) => {
      output += data;
      if (!inputSent && output.includes("READY\r\n")) {
        inputSent = true;
        handle.resize(101, 37);
        handle.write("hello 🦞\r");
      }
    });
    expect(await done.promise).toEqual({ exitCode: 7, signal: 0 });
    expect(output).toBe("READY\r\n37 101\r\nhello 🦞\r\nxterm-256color\r\n");
    expect(await waitForPidToExit(handle.pid, 2_000)).toBe(true);
  });

  it("retains bounded pipe output while paused and drains it before reporting exit", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-pty-output-"));
    tempDirs.push(directory);
    const payload = "x".repeat(2 * 1024 * 1024);
    const file = path.join(directory, "output.txt");
    fs.writeFileSync(file, payload);
    const handle = await spawnNodeTerminalPty({
      file: "/bin/cat",
      args: [file],
      cwd: directory,
      env,
      cols: 80,
      rows: 24,
    });
    handles.push(handle);
    handle.pause();
    let output = "";
    let exited = false;
    const done = createDeferredCore();
    handle.onData((data) => {
      expect(exited).toBe(false);
      output += data;
    });
    handle.onExit(() => {
      exited = true;
      done.resolve();
    });
    await delay(50);
    expect(output).toBe("");
    expect(exited).toBe(false);
    handle.resume();
    await done.promise;
    expect(output).toBe(payload);
  });

  it("reaps the PTY and its background process when the owning host disconnects", async () => {
    const worker = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.terminalPty);
    const child = spawn(process.execPath, resolveRuntimeWorkerArgv(worker), {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
    });
    const stdout = child.stdout;
    if (!stdout) {
      child.once("error", () => undefined);
      child.kill("SIGKILL");
      throw new Error("Terminal worker did not provide its required output pipe");
    }
    let shellPid: number | undefined;
    let backgroundPid: number | undefined;
    let output = "";
    const started = createDeferredCore();
    const exited = once(child, "exit");
    child.once("error", (error) => started.reject(error));
    child.once("exit", () => started.reject(new Error("Terminal worker exited before output")));
    stdout.setEncoding("utf8");
    stdout.on("data", (data: string) => {
      output += data;
      const match = output.match(/BACKGROUND:(\d+)\r?\n/u);
      if (match) {
        backgroundPid = Number(match[1]);
        started.resolve();
      }
    });
    child.on("message", (raw: unknown) => {
      const message = raw as TerminalPtyEvent;
      if (message.type === "boot") {
        child.send({
          type: "start",
          params: {
            file: "/bin/bash",
            args: ["-c", 'set -m; sleep 300 & printf "BACKGROUND:%s\\n" "$!"; wait'],
            cwd: os.tmpdir(),
            env,
            cols: 80,
            rows: 24,
          },
        });
      } else if (message.type === "ready") {
        shellPid = message.pid;
      } else if (message.type === "error") {
        started.reject(new Error(message.message));
      }
    });
    try {
      await started.promise;
      child.disconnect();
      await exited;
      expect(shellPid).toBeGreaterThan(0);
      expect(backgroundPid).toBeGreaterThan(0);
      expect(await waitForPidToExit(shellPid!, 2_000)).toBe(true);
      expect(await waitForPidToExit(backgroundPid!, 2_000)).toBe(true);
    } finally {
      child.kill("SIGKILL");
      killPidIfAlive(backgroundPid);
      killPidIfAlive(shellPid);
    }
  });
});
