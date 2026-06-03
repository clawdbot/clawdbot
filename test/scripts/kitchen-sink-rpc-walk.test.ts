import { EventEmitter } from "node:events";
import fs, {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendBoundedOutput,
  assertCommandResourceCeiling,
  assertDiagnosticStabilityClean,
  assertResourceCeiling,
  cleanupKitchenSinkEnv,
  createGatewayReadyLogScanner,
  createRpcCliRunOptions,
  extractPluginCommandNames,
  fetchJson,
  findErrorLogFindings,
  findDistCallGatewayModuleFiles,
  hasChildExited,
  makeEnv,
  readPositiveInt,
  readBoundedResponseText,
  runCommand,
  sampleProcess,
  sampleWindowsProcessByPort,
  shouldPrintHelp,
  stopGateway,
  summarizeProcessSamples,
  tailFile,
  unwrapRpcPayload,
  usesBuiltOpenClawEntry,
  waitForGatewayReady,
} from "../../scripts/e2e/kitchen-sink-rpc-walk.mjs";

const posixIt = process.platform === "win32" ? it.skip : it;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("kitchen-sink RPC isolated state", () => {
  it("prints help without creating temp state or installing the plugin", async () => {
    const result = await runCommand(process.execPath, [
      "scripts/e2e/kitchen-sink-rpc-walk.mjs",
      "--help",
    ]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node scripts/e2e/kitchen-sink-rpc-walk.mjs");
    expect(result.stdout).toContain("OPENCLAW_KITCHEN_SINK_NPM_SPEC");
    expect(result.stdout).not.toContain("Kitchen Sink RPC walk using");
    expect(result.stdout).not.toContain("temp root preserved");
  });

  it("detects short and long help flags", () => {
    expect(shouldPrintHelp(["--help"])).toBe(true);
    expect(shouldPrintHelp(["-h"])).toBe(true);
    expect(shouldPrintHelp([])).toBe(false);
  });

  it("keeps loose numeric env values from corrupting runtime guardrails", () => {
    expect(readPositiveInt(undefined, 60_000)).toBe(60_000);
    expect(readPositiveInt("1000", 60_000)).toBe(1000);
    expect(readPositiveInt(" 1000 ", 60_000)).toBe(1000);
    expect(readPositiveInt("1e3", 60_000)).toBe(60_000);
    expect(readPositiveInt("1000ms", 60_000)).toBe(60_000);
    expect(readPositiveInt("0", 60_000)).toBe(60_000);
  });

  it("cleans up the generated temporary home tree", async () => {
    const { root, env } = makeEnv();

    expect(root).toContain("openclaw-kitchen-sink-rpc-");
    expect(env.HOME).toBe(path.join(root, "home"));
    expect(env.USERPROFILE).toBe(env.HOME);
    expect(env.OPENCLAW_HOME).toBe(env.HOME);
    expect(env.OPENCLAW_STATE_DIR).toBe(path.join(env.HOME, ".openclaw"));
    expect(env.OPENCLAW_CONFIG_PATH).toBe(path.join(env.OPENCLAW_STATE_DIR, "openclaw.json"));
    expect(existsSync(env.OPENCLAW_STATE_DIR)).toBe(true);

    await expect(cleanupKitchenSinkEnv(root)).resolves.toBe(true);

    expect(existsSync(root)).toBe(false);
  });

  it("can fail the walk when generated temp cleanup cannot remove the root", async () => {
    const rmSync = vi.spyOn(fs, "rmSync").mockImplementation(() => {
      throw new Error("device busy");
    });

    try {
      await expect(
        cleanupKitchenSinkEnv("/tmp/openclaw-kitchen-sink-rpc-stuck", {
          attempts: 3,
          delayMs: 1,
          throwOnFailure: true,
          warn: false,
        }),
      ).rejects.toThrow(
        "failed to remove Kitchen Sink RPC temp root: /tmp/openclaw-kitchen-sink-rpc-stuck",
      );
      expect(rmSync).toHaveBeenCalledTimes(3);
    } finally {
      rmSync.mockRestore();
    }
  });
});

describe("kitchen-sink RPC gateway teardown", () => {
  it("treats signaled gateway children as exited", () => {
    expect(hasChildExited({ exitCode: null, signalCode: "SIGTERM" })).toBe(true);
    expect(hasChildExited({ exitCode: 0, signalCode: null })).toBe(true);
    expect(hasChildExited({ exitCode: null, signalCode: null })).toBe(false);
  });

  it("releases gateway handles when the process ignores teardown signals", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      kill: ReturnType<typeof vi.fn>;
      signalCode: NodeJS.Signals | null;
      stderr: { destroy: ReturnType<typeof vi.fn> };
      stdin: { destroy: ReturnType<typeof vi.fn> };
      stdout: { destroy: ReturnType<typeof vi.fn> };
      unref: ReturnType<typeof vi.fn>;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true);
    child.stderr = { destroy: vi.fn() };
    child.stdin = { destroy: vi.fn() };
    child.stdout = { destroy: vi.fn() };
    child.unref = vi.fn();

    await stopGateway(child, { killGraceMs: 1, teardownGraceMs: 1 });

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(child.stdin.destroy).toHaveBeenCalledOnce();
    expect(child.stdout.destroy).toHaveBeenCalledOnce();
    expect(child.stderr.destroy).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("treats ESRCH during gateway teardown as already exited", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      kill: ReturnType<typeof vi.fn>;
      signalCode: NodeJS.Signals | null;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => {
      const error = Object.assign(new Error("process already exited"), { code: "ESRCH" });
      throw error;
    });

    await expect(
      stopGateway(child, { killGraceMs: 1, teardownGraceMs: 1 }),
    ).resolves.toBeUndefined();

    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("treats failed gateway kill signals as already exited", async () => {
    const child = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      kill: ReturnType<typeof vi.fn>;
      signalCode: NodeJS.Signals | null;
    };
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => false);

    await expect(
      stopGateway(child, { killGraceMs: 1, teardownGraceMs: 1 }),
    ).resolves.toBeUndefined();

    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("fails readiness waits before polling after signaled gateway exits", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-signal-ready-"));
    try {
      const logPath = path.join(root, "gateway.log");
      writeFileSync(logPath, "gateway died\n");
      const fetchImpl = vi.fn(() => {
        throw new Error("fetch should not run after process exit");
      });

      await expect(
        waitForGatewayReady({ exitCode: null, signalCode: "SIGTERM" }, 9, logPath, {
          fetchImpl,
          pollDelayMs: 1,
          timeoutMs: 1,
        }),
      ).rejects.toThrow("gateway exited before ready");
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps stalled readiness probes inside the caller deadline", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-stalled-ready-"));
    try {
      const logPath = path.join(root, "gateway.log");
      writeFileSync(logPath, "booting\n");
      let calls = 0;
      const startedAt = Date.now();

      await expect(
        waitForGatewayReady({ exitCode: null, signalCode: null }, 9, logPath, {
          fetchImpl: () => {
            calls += 1;
            return new Promise(() => {});
          },
          pollDelayMs: 1,
          timeoutMs: 25,
        }),
      ).rejects.toThrow("gateway did not become ready");

      expect(calls).toBe(1);
      expect(Date.now() - startedAt).toBeLessThan(500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("kitchen-sink RPC gateway readiness logs", () => {
  it("scans gateway readiness logs incrementally across appended chunks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-log-scan-"));
    try {
      const logPath = path.join(root, "gateway.log");
      writeFileSync(logPath, "booting\n".repeat(1000));
      const scanner = createGatewayReadyLogScanner(logPath, "[gateway] ready");

      expect(scanner()).toBe(false);

      writeFileSync(logPath, "[gateway] rea", { flag: "a" });
      expect(scanner()).toBe(false);

      writeFileSync(logPath, "dy\n", { flag: "a" });
      expect(scanner()).toBe(true);
      expect(scanner()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resets the readiness scanner after log rotation", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-log-rotate-"));
    try {
      const logPath = path.join(root, "gateway.log");
      writeFileSync(logPath, "older log contents without readiness\n");
      const scanner = createGatewayReadyLogScanner(logPath, "[gateway] ready");

      expect(scanner()).toBe(false);

      writeFileSync(logPath, "[gateway] ready\n");
      expect(scanner()).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tails large gateway logs without returning older content", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-log-tail-"));
    try {
      const logPath = path.join(root, "gateway.log");
      writeFileSync(logPath, `old fatal marker\n${"noise\n".repeat(2000)}recent ready\n`);

      const tail = tailFile(logPath, 128);

      expect(tail).toContain("recent ready");
      expect(tail).not.toContain("old fatal marker");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("honors short reads when a gateway log shrinks during tailing", () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);
    vi.spyOn(fs, "statSync").mockReturnValue({
      isFile: () => true,
      size: 64,
    } as fs.Stats);
    vi.spyOn(fs, "openSync").mockReturnValue(123 as never);
    vi.spyOn(fs, "closeSync").mockImplementation(() => undefined);
    vi.spyOn(fs, "readSync").mockImplementation((_fd, buffer) => {
      if (!Buffer.isBuffer(buffer)) {
        throw new Error("expected buffer read");
      }
      buffer.write("recent ready");
      return 12;
    });

    expect(tailFile("/tmp/truncated-kitchen-rpc.log", 64)).toBe("recent ready");
  });

  it("scans gateway error logs incrementally and keeps the latest findings", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-log-errors-"));
    try {
      const logPath = path.join(root, "gateway.log");
      writeFileSync(logPath, `${"ordinary line\n".repeat(2000)}0 errors\n[ERROR] late failure\n`);

      expect(findErrorLogFindings(logPath)).toEqual([
        {
          line: "[ERROR] late failure",
          lineNumber: 2002,
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds scanner memory for very long log lines", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-log-long-line-"));
    try {
      const logPath = path.join(root, "gateway.log");
      writeFileSync(logPath, `${"x".repeat(200_000)}[ERROR] giant line\n`);

      const findings = findErrorLogFindings(logPath);

      expect(findings).toHaveLength(1);
      expect(findings[0]?.lineNumber).toBe(1);
      expect(findings[0]?.line).toContain("[truncated]");
      expect(findings[0]?.line.length).toBeLessThan(20_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("kitchen-sink RPC command output capture", () => {
  it("keeps a bounded tail and tracks truncated output", () => {
    const first = appendBoundedOutput({ text: "", truncatedChars: 0 }, "abcdef", 5);
    expect(first).toEqual({ text: "bcdef", truncatedChars: 1 });

    const second = appendBoundedOutput(first, "ghij", 5);
    expect(second).toEqual({ text: "fghij", truncatedChars: 5 });
  });

  posixIt("kills timed command process groups", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-timeout-"));
    const scriptPath = path.join(root, "trap-term.mjs");
    const grandchildPidPath = path.join(root, "grandchild.pid");
    let grandchildPid = 0;

    writeFileSync(
      scriptPath,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

const grandchild = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
], { stdio: "ignore" });
fs.writeFileSync(process.argv[2], String(grandchild.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const runPromise = runCommand(process.execPath, [scriptPath, grandchildPidPath], {
      detached: undefined,
      timeoutKillGraceMs: 25,
      timeoutMs: 500,
    });

    try {
      await waitFor(() => existsSync(grandchildPidPath));
      grandchildPid = Number.parseInt(readText(grandchildPidPath), 10);
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(isProcessAlive(grandchildPid)).toBe(true);

      await expect(runPromise).rejects.toThrow("timed out after 500ms");
      await waitFor(() => !isProcessAlive(grandchildPid), 5_000);
    } finally {
      await runPromise.catch(() => {});
      if (grandchildPid && isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("records resource samples for command process trees", async () => {
    const samples: Array<{
      aggregateRssMiB?: number;
      elapsedMs?: number;
      label?: string;
      processId?: number;
      rssMiB?: number;
    }> = [];
    const seenPids: number[] = [];

    const result = await runCommand(process.execPath, ["-e", "setTimeout(() => {}, 50);"], {
      resourceLabel: "plugins install",
      resourceSampleIntervalMs: 1,
      resourceSamples: samples,
      sampleProcessImpl: async (pid: number) => {
        seenPids.push(pid);
        return {
          aggregateRssMiB: 640,
          cpuPercent: 12,
          processId: pid + 1,
          rssMiB: 512,
        };
      },
    });

    expect(result.stdout).toBe("");
    expect(seenPids.length).toBeGreaterThan(0);
    expect(samples[0]).toMatchObject({
      aggregateRssMiB: 640,
      label: "plugins install",
      processId: seenPids[0] + 1,
      rssMiB: 512,
    });
    expect(samples[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects command spawn failures as Error objects", async () => {
    await expect(runCommand("openclaw-definitely-missing-command", [])).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

describe("kitchen-sink RPC caller loading", () => {
  it("samples CLI-backed gateway RPC calls as command work", () => {
    const resourceSamples: unknown[] = [];

    expect(
      createRpcCliRunOptions("tools.invoke", {
        commandResourceOptions: {
          resourceSampleIntervalMs: 500,
          resourceSamples,
        },
      }),
    ).toMatchObject({
      resourceLabel: "gateway call tools.invoke",
      resourceSampleIntervalMs: 500,
      resourceSamples,
      timeoutMs: 90_000,
    });
  });

  it("uses built callGateway chunks for dist and packaged entries", () => {
    expect(usesBuiltOpenClawEntry({ command: "node", baseArgs: ["dist/index.js"] })).toBe(true);
    expect(
      usesBuiltOpenClawEntry({ command: "node", baseArgs: ["/app/openclaw.mjs"] }, "/repo", {
        OPENCLAW_ENTRY: "/app/openclaw.mjs",
      }),
    ).toBe(true);
  });

  it("does not deep-import gateway TypeScript for source pnpm runners", () => {
    expect(usesBuiltOpenClawEntry({ pnpm: true, baseArgs: ["openclaw"] })).toBe(false);
    expect(usesBuiltOpenClawEntry({ command: "node", baseArgs: ["scripts/dev.mjs"] })).toBe(false);
  });

  it("finds only built callGateway chunks", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-rpc-call-chunks-"));
    try {
      mkdirSync(path.join(root, "dist"));
      writeFileSync(path.join(root, "dist", "call-Abc123.js"), "");
      writeFileSync(path.join(root, "dist", "call.runtime-Def456.js"), "");
      writeFileSync(path.join(root, "dist", "index.js"), "");

      expect(findDistCallGatewayModuleFiles(root)).toEqual([
        "call-Abc123.js",
        "call.runtime-Def456.js",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("kitchen-sink RPC payload unwrapping", () => {
  it("preserves explicit nullish JSON-RPC result fields", () => {
    expect(unwrapRpcPayload({ jsonrpc: "2.0", result: null })).toBeNull();
    expect(unwrapRpcPayload({ jsonrpc: "2.0", result: undefined })).toBeUndefined();
  });

  it("prefers result before legacy payload and data envelopes", () => {
    expect(unwrapRpcPayload({ result: false, payload: { stale: true } })).toBe(false);
    expect(unwrapRpcPayload({ payload: null, data: { stale: true } })).toBeNull();
    expect(unwrapRpcPayload({ data: 0 })).toBe(0);
  });
});

describe("kitchen-sink RPC command catalog assertions", () => {
  it("keeps plugin commands and deduplicates aliases", () => {
    expect(
      extractPluginCommandNames({
        commands: [
          {
            source: "core",
            name: "/kitchen-sink",
          },
          {
            source: "plugin",
            name: "/kitchen",
            nativeName: "kitchen",
            textAliases: ["/kitchen-sink", "kitchen-sink"],
          },
        ],
      }),
    ).toEqual(["kitchen", "kitchen-sink"]);
  });
});

describe("kitchen-sink RPC diagnostics assertions", () => {
  it("fails when stability reports dropped or rejected payload diagnostics", () => {
    expect(() =>
      assertDiagnosticStabilityClean({
        dropped: 1,
        events: [{ type: "diagnostic.async_queue.dropped" }],
        summary: {
          payloadLarge: {
            rejected: 1,
            truncated: 1,
          },
        },
      }),
    ).toThrow("diagnostics.stability reported instability");
  });

  it("fails when async diagnostic drops only appear in the full summary", () => {
    expect(() =>
      assertDiagnosticStabilityClean({
        dropped: 0,
        events: [],
        summary: {
          byType: {
            "diagnostic.async_queue.dropped": 2,
          },
        },
      }),
    ).toThrow("async diagnostic drops=2");
  });

  it("allows chunked payload diagnostics that did not reject or truncate data", () => {
    expect(() =>
      assertDiagnosticStabilityClean({
        dropped: 0,
        events: [{ type: "payload.large", action: "chunked" }],
        summary: {
          payloadLarge: {
            rejected: 0,
            truncated: 0,
            chunked: 1,
          },
        },
      }),
    ).not.toThrow();
  });
});

describe("kitchen-sink RPC process sampling", () => {
  it("samples RSS on Windows instead of silently disabling the resource guard", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const sample = await sampleProcess(1234, {
      platform: "win32",
      runCommand: async (command: string, args: string[]) => {
        calls.push({ command, args });
        return { stdout: `${256 * 1024 * 1024} 1.5 5678 ${288 * 1024 * 1024}`, stderr: "" };
      },
    });

    expect(sample).toEqual({
      aggregateRssMiB: 288,
      cpuPercent: null,
      cpuSeconds: 1.5,
      processId: 5678,
      rssMiB: 256,
    });
    expect(calls[0]?.command).toBe("powershell.exe");
    expect(calls[0]?.args.join(" ")).toContain("$rootPid = 1234");
    expect(calls[0]?.args.join(" ")).toContain("ParentProcessId");
  });

  it("can locate a Windows gateway process by command line when the launcher is gone", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const sample = await sampleProcess(1234, {
      platform: "win32",
      runCommand: async (command: string, args: string[]) => {
        calls.push({ command, args });
        return { stdout: `${384 * 1024 * 1024} 2.25 6789 ${512 * 1024 * 1024}`, stderr: "" };
      },
      windowsCommandLineNeedles: ["gateway", "--port", "19080"],
    });

    expect(sample).toEqual({
      aggregateRssMiB: 512,
      cpuPercent: null,
      cpuSeconds: 2.25,
      processId: 6789,
      rssMiB: 384,
    });
    const command = calls[0]?.args.join(" ") ?? "";
    expect(command).toContain("CommandLine");
    expect(command).toContain("'gateway'");
    expect(command).toContain("'19080'");
    expect(command).toContain("ProcessId -eq $PID");
    expect(command).toContain("ParentProcessId");
    expect(command).toContain("Sort-Object WorkingSet64 -Descending");
  });

  it("falls back to the legacy powershell command name on Windows", async () => {
    const commands: string[] = [];
    const sample = await sampleProcess(1234, {
      platform: "win32",
      runCommand: async (command: string) => {
        commands.push(command);
        if (command === "powershell.exe") {
          throw new Error("missing powershell.exe");
        }
        return { stdout: `${96 * 1024 * 1024} 0 1234`, stderr: "" };
      },
    });

    expect(commands).toEqual(["powershell.exe", "powershell"]);
    expect(sample?.rssMiB).toBe(96);
    expect(sample?.aggregateRssMiB).toBe(96);
  });

  it("samples the Windows gateway process by listening port", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const sample = await sampleWindowsProcessByPort(19675, {
      runCommand: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (command === "netstat.exe") {
          return {
            stdout: [
              "  Proto  Local Address          Foreign Address        State           PID",
              "  TCP    127.0.0.1:19675        0.0.0.0:0              LISTENING       6789",
            ].join("\r\n"),
            stderr: "",
          };
        }
        if (command === "powershell.exe") {
          return { stdout: `${384 * 1024 * 1024} 2.25 6789 ${512 * 1024 * 1024}`, stderr: "" };
        }
        throw new Error(`unexpected command ${command}`);
      },
    });

    expect(sample).toEqual({
      aggregateRssMiB: 512,
      cpuPercent: null,
      cpuSeconds: 2.25,
      processId: 6789,
      rssMiB: 384,
    });
    expect(calls).toEqual([
      { command: "netstat.exe", args: ["-ano", "-p", "tcp"] },
      {
        command: "powershell.exe",
        args: expect.arrayContaining(["-Command", expect.stringContaining("$rootPid = 6789")]),
      },
    ]);
  });

  it("samples direct POSIX gateway RSS with descendants", async () => {
    const sample = await sampleProcess(4321, {
      platform: "linux",
      runCommand: async (command: string, args: string[]) => {
        expect(command).toBe("ps");
        expect(args).toEqual(["-ww", "-axo", "pid=,ppid=,rss=,pcpu=,command="]);
        return {
          stdout: [
            " 4321     1  262144  12.5 node dist/index.js gateway --port 19080",
            " 4322  4321  131072   1.5 node helper.js",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    expect(sample).toEqual({
      aggregateRssMiB: 384,
      cpuPercent: 12.5,
      processId: 4321,
      rssMiB: 256,
    });
  });

  it("samples the POSIX gateway child instead of the pnpm launcher", async () => {
    const sample = await sampleProcess(4321, {
      platform: "linux",
      posixCommandLineNeedles: ["gateway", "--port", "19080"],
      runCommand: async (command: string, args: string[]) => {
        expect(command).toBe("ps");
        expect(args).toEqual(["-ww", "-axo", "pid=,ppid=,rss=,pcpu=,command="]);
        return {
          stdout: [
            " 4321     1   16384   0.0 node /usr/local/bin/corepack pnpm openclaw gateway --port 19080",
            " 4322  4321  262144  12.5 node dist/index.js gateway --port 19080 --bind loopback",
            " 4323  4322   32768   1.5 node helper.js",
          ].join("\n"),
          stderr: "",
        };
      },
    });

    expect(sample).toEqual({
      aggregateRssMiB: 288,
      cpuPercent: 12.5,
      processId: 4322,
      rssMiB: 256,
    });
  });

  it("falls back to the POSIX gateway process title when the port arg is rewritten", async () => {
    const sample = await sampleProcess(4321, {
      platform: "darwin",
      posixCommandLineNeedles: ["gateway", "--port", "19080"],
      runCommand: async () => ({
        stdout: [
          " 4321     1 1048576   0.0 node /usr/local/bin/corepack pnpm openclaw gateway --port 19080",
          " 4322  4321  262144  12.5 openclaw-gateway",
          " 4323  4322   32768   1.5 node helper.js",
        ].join("\n"),
        stderr: "",
      }),
    });

    expect(sample).toEqual({
      aggregateRssMiB: 288,
      cpuPercent: 12.5,
      processId: 4322,
      rssMiB: 256,
    });
  });

  it("falls back to the largest POSIX child when the gateway command line is unavailable", async () => {
    const sample = await sampleProcess(4321, {
      platform: "linux",
      posixCommandLineNeedles: ["gateway", "--port", "19080"],
      runCommand: async () => ({
        stdout: [
          " 4321     1 1048576   0.0 node /usr/local/bin/corepack pnpm openclaw gateway --port 19080",
          " 4322  4321  262144  12.5 node",
          " 4323  4322   32768   1.5 node helper.js",
        ].join("\n"),
        stderr: "",
      }),
    });

    expect(sample).toEqual({
      aggregateRssMiB: 288,
      cpuPercent: 12.5,
      processId: 4322,
      rssMiB: 256,
    });
  });

  it("does not accept a POSIX launcher sample when the gateway child is missing", async () => {
    const sample = await sampleProcess(4321, {
      platform: "darwin",
      posixCommandLineNeedles: ["gateway", "--port", "19080"],
      runCommand: async () => ({
        stdout: " 4321     1   16384   0.0 node /usr/local/bin/corepack pnpm openclaw status\n",
        stderr: "",
      }),
    });

    expect(sample).toBeNull();
  });

  it("retries transient loopback fetch resets from Windows HTTP probes", async () => {
    const reset = new TypeError("fetch failed", {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(reset)
      .mockResolvedValueOnce(new Response('{"status":"live"}', { status: 200 }));

    await expect(
      fetchJson("http://127.0.0.1:19680/healthz", {
        attempts: 2,
        fetchImpl,
        retryDelayMs: 0,
      }),
    ).resolves.toEqual({ ok: true, status: 200, body: { status: "live" } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("bounds HTTP probe response bodies", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("x".repeat(1025), { status: 200 }));

    await expect(
      fetchJson("http://127.0.0.1:19680/healthz", {
        attempts: 1,
        fetchImpl,
        maxBodyBytes: 1024,
      }),
    ).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "fetch response body exceeded 1024 bytes",
    });
  });

  it("rejects oversized HTTP probe responses before reading declared large bodies", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          canceled = true;
        },
      }),
      {
        headers: {
          "content-length": "1025",
        },
      },
    );

    await expect(readBoundedResponseText(response, 1024)).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "fetch response body exceeded 1024 bytes",
    });
    expect(canceled).toBe(true);
  });

  it("bounds HTTP probe response bodies without a readable stream", async () => {
    const response = {
      headers: new Headers(),
      text: vi.fn(async () => "x".repeat(1025)),
    };

    await expect(readBoundedResponseText(response, 1024)).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "fetch response body exceeded 1024 bytes",
    });
    expect(response.text).toHaveBeenCalledTimes(1);
  });

  it("rejects declared large HTTP probe responses without a readable stream", async () => {
    const response = {
      headers: new Headers({
        "content-length": "1025",
      }),
      text: vi.fn(async () => "not read"),
    };

    await expect(readBoundedResponseText(response, 1024)).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "fetch response body exceeded 1024 bytes",
    });
    expect(response.text).not.toHaveBeenCalled();
  });

  it("reads bounded response streams", async () => {
    await expect(readBoundedResponseText(new Response('{"status":"live"}'), 1024)).resolves.toBe(
      '{"status":"live"}',
    );
  });

  it("times out stalled HTTP probe response bodies", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => new Promise(() => {}),
    });

    const result = fetchJson("http://127.0.0.1:19680/readyz", {
      attempts: 1,
      fetchImpl,
      timeoutMs: 100,
    });
    const rejection = expect(result).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "fetch http://127.0.0.1:19680/readyz timed out after 100ms",
    });

    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    expect(fetchImpl.mock.calls[0]?.[1]?.signal.aborted).toBe(true);
  });

  it("fails when the sampled RSS exceeds the configured ceiling", () => {
    expect(() => assertResourceCeiling({ rssMiB: 2049 })).toThrow(
      "gateway RSS exceeded 2048 MiB: 2049 MiB",
    );
  });

  it("fails when aggregate RSS exceeds the configured ceiling", () => {
    expect(() => assertResourceCeiling({ aggregateRssMiB: 2049, rssMiB: 1024 })).toThrow(
      "gateway aggregate RSS exceeded 2048 MiB: 2049 MiB",
    );
  });

  it("summarizes peak RSS across repeated process samples", () => {
    expect(
      summarizeProcessSamples([
        { aggregateRssMiB: 128, rssMiB: 128, cpuPercent: 2 },
        { aggregateRssMiB: 768, rssMiB: 512, cpuPercent: 25 },
        { aggregateRssMiB: 1024, rssMiB: 256, cpuPercent: 8 },
      ]),
    ).toEqual({
      aggregateRssMiB: 1024,
      rssMiB: 256,
      cpuPercent: 8,
      sampleCount: 3,
      peakCpuPercent: 25,
    });
  });

  it("fails when process sampling does not capture RSS", () => {
    expect(() => assertResourceCeiling(null)).toThrow("gateway RSS sample was not captured");
  });

  it("allows missing command samples but fails command RSS spikes", () => {
    expect(() => assertCommandResourceCeiling(null)).not.toThrow();
    expect(() =>
      assertCommandResourceCeiling({ aggregateRssMiB: 8193, rssMiB: 1024 }),
    ).toThrow("command aggregate RSS exceeded 8192 MiB: 8193 MiB");
  });
});

function readText(file: string) {
  return readFileSync(file, "utf8");
}

async function waitFor(condition: () => boolean, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await delay(25);
  }
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
