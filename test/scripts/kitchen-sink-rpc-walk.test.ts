// Kitchen Sink Rpc Walk tests cover kitchen sink rpc walk script behavior.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendBoundedOutput,
  assertChannelAccountRunning,
  assertCommandResourceCeiling,
  assertCreatedKitchenSinkSession,
  assertDiagnosticStabilityClean,
  assertExpectedKitchenSinkToolEntries,
  assertGatewayHealthPayload,
  assertGatewayStatusPayload,
  assertKitchenSinkImageJobInvokeResult,
  assertKitchenSinkUiDescriptors,
  assertKitchenSinkSearchInvokeResult,
  assertKitchenSinkTextInvokeResult,
  assertOperatorRpcDenied,
  assertResourceCeiling,
  assertTtsProviderCoverage,
  cleanupKitchenSinkEnv,
  createGatewayReadyLogScanner,
  createRpcCliRunOptions,
  extractPluginCommandNames,
  extractTtsProviderIds,
  fetchJson,
  findErrorLogFindings,
  findDistCallGatewayModuleFiles,
  hasChildExited,
  MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS,
  listKitchenSinkToolInvokeNames,
  listKitchenSinkAuthorizationRpcProbeNames,
  listKitchenSinkReadOnlyRpcProbeNames,
  makeEnv,
  parseJsonOutput,
  parseGatewayCliRequestFailure,
  readPositiveInt,
  readPositiveTimerMs,
  readBoundedResponseText,
  resolveKitchenSinkRpcConfig,
  resolveKitchenSinkRpcPort,
  runCommand,
  sampleProcess,
  sampleWindowsProcessByPort,
  shouldPrintHelp,
  signalGateway,
  signalProcessGroup,
  stopGateway,
  summarizeProcessSamples,
  tailFile,
  unwrapRpcPayload,
  usesBuiltOpenClawEntry,
  validateCliArgs,
  waitForGatewayReady,
} from "../../scripts/e2e/kitchen-sink-rpc-walk.mjs";
import {
  resolveWindowsPowerShellPath,
  resolveWindowsSystem32Path,
  resolveWindowsTaskkillPath,
} from "../../scripts/lib/windows-taskkill.mjs";
import { formatGatewayClientRequestErrorJson } from "../../src/gateway/call.js";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const posixIt = process.platform === "win32" ? it.skip : it;

function expectedTaskkillPath(): string {
  return resolveWindowsTaskkillPath();
}

function expectedWindowsSystem32Path(executableName: string): string {
  return resolveWindowsSystem32Path(executableName);
}

function expectedPowerShellPath(): string {
  return resolveWindowsPowerShellPath();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function captureSyncError(action: () => void): Error {
  try {
    action();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected action to throw");
}

describe("kitchen-sink RPC isolated state", () => {
  it("prints help without creating temp state or installing the plugin", async () => {
    const result = await runCommand(process.execPath, [
      "scripts/e2e/kitchen-sink-rpc-walk.mjs",
      "--help",
    ]);

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node scripts/e2e/kitchen-sink-rpc-walk.mjs");
    expect(result.stdout).toContain("OPENCLAW_KITCHEN_SINK_NPM_SPEC");
    expect(result.stdout).toContain("OPENCLAW_KITCHEN_SINK_PERSONALITY");
    expect(result.stdout).toContain("OPENCLAW_KITCHEN_SINK_RPC_PORT");
    expect(result.stdout).toContain("OPENCLAW_KITCHEN_SINK_RPC_FETCH_MS");
    expect(result.stdout).toContain("OPENCLAW_KITCHEN_SINK_RPC_FETCH_BODY_BYTES");
    expect(result.stdout).toContain("OPENCLAW_KITCHEN_SINK_OUTPUT_CAPTURE_CHARS");
    expect(result.stdout).not.toContain("Kitchen Sink RPC walk using");
    expect(result.stdout).not.toContain("temp root preserved");
  });

  it("prints help before parsing malformed runtime guardrails", async () => {
    const result = await runCommand(
      process.execPath,
      ["scripts/e2e/kitchen-sink-rpc-walk.mjs", "--help"],
      {
        env: {
          ...process.env,
          OPENCLAW_KITCHEN_SINK_MAX_RSS_MIB: "1e3",
        },
      },
    );

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("Usage: node scripts/e2e/kitchen-sink-rpc-walk.mjs");
  });

  it("detects short and long help flags", () => {
    expect(shouldPrintHelp(["--help"])).toBe(true);
    expect(shouldPrintHelp(["-h"])).toBe(true);
    expect(shouldPrintHelp([])).toBe(false);
  });

  it("rejects unknown CLI args before creating temp state", async () => {
    expect(() => validateCliArgs(["--wat"])).toThrow("Unknown argument: --wat");

    const error = await runCommand(process.execPath, [
      "scripts/e2e/kitchen-sink-rpc-walk.mjs",
      "--wat",
    ]).then(
      () => undefined,
      (caught: unknown) => caught as Error & { stderr?: string; stdout?: string },
    );

    expect(error).toBeDefined();
    expect(error?.stdout).toBe("");
    expect(error?.stderr?.trim()).toBe("Unknown argument: --wat");
    expect(error?.stderr).not.toContain("temp root preserved");
  });

  it("rejects loose numeric env values before they bypass runtime guardrails", () => {
    expect(readPositiveInt(undefined, 60_000)).toBe(60_000);
    expect(readPositiveInt("", 60_000)).toBe(60_000);
    expect(readPositiveInt("1000", 60_000)).toBe(1000);
    expect(readPositiveInt(" 1000 ", 60_000)).toBe(1000);
    expect(() => readPositiveInt("1e3", 60_000, "OPENCLAW_KITCHEN_SINK_MAX_RSS_MIB")).toThrow(
      'OPENCLAW_KITCHEN_SINK_MAX_RSS_MIB must be a positive integer. Got: "1e3"',
    );
    expect(() => readPositiveInt("1000ms", 60_000, "OPENCLAW_KITCHEN_SINK_RPC_READY_MS")).toThrow(
      'OPENCLAW_KITCHEN_SINK_RPC_READY_MS must be a positive integer. Got: "1000ms"',
    );
    expect(() => readPositiveInt("0", 60_000, "OPENCLAW_KITCHEN_SINK_RPC_PORT")).toThrow(
      'OPENCLAW_KITCHEN_SINK_RPC_PORT must be a positive integer. Got: "0"',
    );
  });

  it("clamps timer env values before they reach Node timers", () => {
    const oversizedTimerMs = String(Number.MAX_SAFE_INTEGER);

    expect(readPositiveTimerMs(oversizedTimerMs, 60_000)).toBe(MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS);

    const config = resolveKitchenSinkRpcConfig({
      OPENCLAW_KITCHEN_SINK_RPC_CALL_MS: oversizedTimerMs,
      OPENCLAW_KITCHEN_SINK_RPC_COMMAND_MS: oversizedTimerMs,
      OPENCLAW_KITCHEN_SINK_RPC_FETCH_MS: oversizedTimerMs,
      OPENCLAW_KITCHEN_SINK_RPC_INSTALL_MS: oversizedTimerMs,
      OPENCLAW_KITCHEN_SINK_RPC_READY_MS: oversizedTimerMs,
    });

    expect(config.rpcTimeoutMs).toBe(MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS);
    expect(config.commandTimeoutMs).toBe(MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS);
    expect(config.fetchTimeoutMs).toBe(MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS);
    expect(config.installTimeoutMs).toBe(MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS);
    expect(config.readyTimeoutMs).toBe(MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS);
    expect(
      createRpcCliRunOptions("kitchen_sink_text", {
        env: {
          OPENCLAW_KITCHEN_SINK_RPC_CALL_MS: String(MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS),
        },
      }).timeoutMs,
    ).toBe(MAX_KITCHEN_SINK_TIMER_TIMEOUT_MS);
  });

  it("uses an explicit RPC port or asks the OS for an available fallback", async () => {
    await expect(
      resolveKitchenSinkRpcPort({ OPENCLAW_KITCHEN_SINK_RPC_PORT: "19080" }),
    ).resolves.toBe(19080);
    await expect(
      resolveKitchenSinkRpcPort({ OPENCLAW_KITCHEN_SINK_RPC_PORT: "65535" }),
    ).resolves.toBe(65535);
    await expect(
      resolveKitchenSinkRpcPort({ OPENCLAW_KITCHEN_SINK_RPC_PORT: "65536" }),
    ).rejects.toThrow(
      'OPENCLAW_KITCHEN_SINK_RPC_PORT must be a TCP port from 1 to 65535. Got: "65536"',
    );
    await expect(
      resolveKitchenSinkRpcPort({}, { findAvailablePort: async () => 45678 }),
    ).resolves.toBe(45678);
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
    const rmSyncSpy = vi.spyOn(fs, "rmSync").mockImplementation(() => {
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
      expect(rmSyncSpy).toHaveBeenCalledTimes(3);
    } finally {
      rmSyncSpy.mockRestore();
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

  it("signals Windows gateway process trees with taskkill", () => {
    const child = {
      kill: vi.fn(),
      pid: 12345,
    };
    const killProcess = vi.fn();
    const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

    expect(
      signalGateway(child, "SIGTERM", killProcess, {
        platform: "win32",
        runTaskkill,
      }),
    ).toBe(true);
    expect(runTaskkill).toHaveBeenNthCalledWith(
      1,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T"],
      {
        stdio: "ignore",
      },
    );

    expect(
      signalGateway(child, "SIGKILL", killProcess, {
        platform: "win32",
        runTaskkill,
      }),
    ).toBe(true);
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(killProcess).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("force-kills Windows gateway process trees when graceful taskkill fails", () => {
    const child = {
      kill: vi.fn(),
      pid: 12345,
    };
    const killProcess = vi.fn();
    const runTaskkill = vi
      .fn()
      .mockReturnValueOnce({ error: undefined, status: 1 })
      .mockReturnValueOnce({ error: undefined, status: 0 });

    expect(
      signalGateway(child, "SIGTERM", killProcess, {
        platform: "win32",
        runTaskkill,
      }),
    ).toBe(true);

    expect(runTaskkill).toHaveBeenNthCalledWith(
      1,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T"],
      {
        stdio: "ignore",
      },
    );
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(killProcess).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  posixIt("does not trust an exited wrapper while the gateway process group is alive", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: 0,
      kill: vi.fn(),
      pid: 12347,
      signalCode: null as NodeJS.Signals | null,
    });
    const killProcess = vi.fn(() => true);

    await stopGateway(child, { killGraceMs: 1, killProcess, teardownGraceMs: 1 });

    expect(killProcess).toHaveBeenNthCalledWith(1, -12347, 0);
    expect(killProcess).toHaveBeenNthCalledWith(2, -12347, "SIGTERM");
    expect(killProcess).toHaveBeenCalledWith(-12347, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
  });

  posixIt("rechecks process group liveness after the wrapper exits during teardown", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      kill: vi.fn(),
      pid: 12348,
      signalCode: null as NodeJS.Signals | null,
    });
    const killProcess = vi.fn((_pid: number, signal: number | NodeJS.Signals) => {
      if (signal === "SIGTERM") {
        setTimeout(() => {
          child.exitCode = 0;
          child.emit("exit", 0, null);
        }, 0);
      }
      return true;
    });

    await stopGateway(child, { killGraceMs: 1, killProcess, teardownGraceMs: 100 });

    expect(killProcess).toHaveBeenNthCalledWith(1, -12348, 0);
    expect(killProcess).toHaveBeenNthCalledWith(2, -12348, "SIGTERM");
    expect(killProcess).toHaveBeenCalledWith(-12348, "SIGKILL");
    expect(child.kill).not.toHaveBeenCalled();
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

  it("aborts stalled readiness probes when the gateway exits mid-probe", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-exit-during-ready-"));
    try {
      const logPath = path.join(root, "gateway.log");
      writeFileSync(logPath, "gateway died during readiness\n");
      const child = Object.assign(new EventEmitter(), {
        exitCode: null,
        signalCode: null as NodeJS.Signals | null,
      });
      const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              const reason = init.signal?.reason;
              reject(reason instanceof Error ? reason : new Error("fetch aborted"));
            },
            { once: true },
          );
        });
      });
      const startedAt = Date.now();
      setTimeout(() => {
        child.signalCode = "SIGTERM";
        child.emit("exit", null, "SIGTERM");
      }, 25);

      await expect(
        waitForGatewayReady(child, 9, logPath, {
          fetchImpl,
          pollDelayMs: 5_000,
          timeoutMs: 2_000,
        }),
      ).rejects.toThrow("gateway exited before ready");

      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(Date.now() - startedAt).toBeLessThan(500);
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

  it("requires /readyz body.ready before accepting gateway readiness", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-ready-body-"));
    try {
      const logPath = path.join(root, "gateway.log");
      writeFileSync(logPath, "[gateway] ready\n");
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(new Response('{"ready":false}', { status: 200 }))
        .mockResolvedValueOnce(new Response('{"ready":true}', { status: 200 }));

      await expect(
        waitForGatewayReady({ exitCode: null, signalCode: null }, 9, logPath, {
          fetchImpl,
          pollDelayMs: 1,
          timeoutMs: 100,
        }),
      ).resolves.toBeUndefined();

      expect(fetchImpl).toHaveBeenCalledTimes(2);
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

  it("does not allowlist dirty error lines that mention zero errors", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-log-zero-error-smuggle-"));
    try {
      const logPath = path.join(root, "gateway.log");
      writeFileSync(logPath, "[ERROR] 0 errors reported but fatal state remained\n");

      expect(findErrorLogFindings(logPath)).toEqual([
        {
          line: "[ERROR] 0 errors reported but fatal state remained",
          lineNumber: 1,
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

  it("honors the resolved command output capture limit", async () => {
    const result = await runCommand(
      process.execPath,
      ["-e", "process.stdout.write('abcdef'); process.stderr.write('UVWXYZ');"],
      {
        outputCaptureChars: 3,
      },
    );

    expect(result.stdout).toBe("def");
    expect(result.stderr).toBe("XYZ");
    expect(result.stdoutTruncatedChars).toBe(3);
    expect(result.stderrTruncatedChars).toBe(3);
  });

  it("clamps oversized command timeout env values before scheduling timers", async () => {
    const previousTimeout = process.env.OPENCLAW_KITCHEN_SINK_RPC_COMMAND_MS;
    process.env.OPENCLAW_KITCHEN_SINK_RPC_COMMAND_MS = String(Number.MAX_SAFE_INTEGER);
    try {
      await expect(
        runCommand(process.execPath, [
          "--input-type=module",
          "--eval",
          "setTimeout(() => process.exit(0), 25);",
        ]),
      ).resolves.toMatchObject({ stdout: "", stderr: "" });
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.OPENCLAW_KITCHEN_SINK_RPC_COMMAND_MS;
      } else {
        process.env.OPENCLAW_KITCHEN_SINK_RPC_COMMAND_MS = previousTimeout;
      }
    }
  });

  posixIt("kills timed command process groups", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-timeout-"));
    const scriptPath = path.join(root, "trap-term.mjs");
    const grandchildPidPath = path.join(root, "grandchild.pid");
    const grandchildReadyPath = path.join(root, "grandchild.ready");
    let grandchildPid = 0;
    const grandchildScript = [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "fs.writeFileSync(process.env.GRANDCHILD_READY_PATH, 'ready');",
      "setInterval(() => {}, 1000);",
    ].join(" ");

    writeFileSync(
      scriptPath,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

const grandchild = spawn(process.execPath, [
  "-e",
  ${JSON.stringify(grandchildScript)},
], { env: { ...process.env, GRANDCHILD_READY_PATH: process.argv[3] }, stdio: "ignore" });
fs.writeFileSync(process.argv[2], String(grandchild.pid));
process.on("SIGTERM", () => {});
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const runPromise = runCommand(
      process.execPath,
      [scriptPath, grandchildPidPath, grandchildReadyPath],
      {
        detached: undefined,
        timeoutKillGraceMs: 25,
        timeoutMs: 500,
      },
    );
    const runErrorPromise = runPromise.then(
      () => {
        throw new Error("expected timed command to reject");
      },
      (error: unknown) => error,
    );

    try {
      await waitFor(() => existsSync(grandchildPidPath));
      await waitFor(() => existsSync(grandchildReadyPath));
      grandchildPid = Number.parseInt(readText(grandchildPidPath), 10);
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(isProcessAlive(grandchildPid)).toBe(true);

      const runError = await runErrorPromise;
      expect(runError).toBeInstanceOf(Error);
      expect((runError as Error).message).toContain("timed out after 500ms");
      await waitFor(() => !isProcessAlive(grandchildPid), 5_000);
    } finally {
      await runPromise.catch(() => {});
      if (grandchildPid && isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("signals Windows command process trees with taskkill", () => {
    const child = {
      kill: vi.fn(),
      pid: 12345,
    };
    const runTaskkill = vi.fn(() => ({ error: undefined, status: 0 }));

    signalProcessGroup(child, "SIGTERM", {
      platform: "win32",
      runTaskkill,
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      1,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T"],
      {
        stdio: "ignore",
      },
    );

    signalProcessGroup(child, "SIGKILL", {
      platform: "win32",
      runTaskkill,
    });
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("force-kills Windows command process trees when graceful taskkill fails", () => {
    const child = {
      kill: vi.fn(),
      pid: 12345,
    };
    const runTaskkill = vi
      .fn()
      .mockReturnValueOnce({ error: undefined, status: 1 })
      .mockReturnValueOnce({ error: undefined, status: 0 });

    signalProcessGroup(child, "SIGTERM", {
      platform: "win32",
      runTaskkill,
    });

    expect(runTaskkill).toHaveBeenNthCalledWith(
      1,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T"],
      {
        stdio: "ignore",
      },
    );
    expect(runTaskkill).toHaveBeenNthCalledWith(
      2,
      expectedTaskkillPath(),
      ["/PID", "12345", "/T", "/F"],
      {
        stdio: "ignore",
      },
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  posixIt("rejects timed commands that exit cleanly after SIGTERM", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-kitchen-rpc-timeout-zero-"));
    const scriptPath = path.join(root, "term-zero.mjs");
    writeFileSync(
      scriptPath,
      `
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    try {
      await expect(
        runCommand(process.execPath, [scriptPath], {
          timeoutKillGraceMs: 1000,
          timeoutMs: 100,
        }),
      ).rejects.toThrow("timed out after 100ms");
    } finally {
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
      processId: expectDefined(seenPids[0], "sampled kitchen sink process id") + 1,
      rssMiB: 512,
    });
    expect(samples[0]?.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects required command resource proof when sampling captures nothing", async () => {
    const samples: unknown[] = [];

    await expect(
      runCommand(process.execPath, ["-e", "setTimeout(() => {}, 50);"], {
        requireResourceSample: true,
        resourceLabel: "plugins install",
        resourceSampleIntervalMs: 1,
        resourceSamples: samples,
        sampleProcessImpl: async () => null,
      }),
    ).rejects.toThrow("plugins install RSS sample was not captured");

    expect(samples).toEqual([]);
  });

  it("includes sampler errors in required command resource proof failures", async () => {
    await expect(
      runCommand(process.execPath, ["-e", "setTimeout(() => {}, 50);"], {
        requireResourceSample: true,
        resourceLabel: "plugins install",
        resourceSampleIntervalMs: 1,
        resourceSamples: [],
        sampleProcessImpl: async () => {
          throw new Error("ps failed");
        },
      }),
    ).rejects.toThrow("plugins install RSS sample was not captured: ps failed");
  });

  it("rejects command spawn failures as Error objects", async () => {
    await expect(runCommand("openclaw-definitely-missing-command", [])).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("preserves failed command output for structured consumers", async () => {
    await expect(
      runCommand(process.execPath, [
        "-e",
        'process.stdout.write("request failure"); process.stderr.write("diagnostic"); process.exit(7)',
      ]),
    ).rejects.toMatchObject({
      status: 7,
      signal: null,
      stdout: "request failure",
      stderr: "diagnostic",
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

  posixIt("kills descendants when timed commands exit cleanly after SIGTERM", async () => {
    const tempDirs: string[] = [];
    const root = makeTempDir(tempDirs, "openclaw-kitchen-rpc-timeout-clean-parent-");
    const scriptPath = path.join(root, "term-zero-grandchild.mjs");
    const grandchildPidPath = path.join(root, "grandchild.pid");
    const grandchildReadyPath = path.join(root, "grandchild.ready");
    let grandchildPid = 0;
    const grandchildScript = [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "fs.writeFileSync(process.env.GRANDCHILD_READY_PATH, 'ready');",
      "setInterval(() => {}, 1000);",
    ].join(" ");

    writeFileSync(
      scriptPath,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

const grandchild = spawn(process.execPath, [
  "-e",
  ${JSON.stringify(grandchildScript)},
], { env: { ...process.env, GRANDCHILD_READY_PATH: process.argv[3] }, stdio: "ignore" });
fs.writeFileSync(process.argv[2], String(grandchild.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );

    const runPromise = runCommand(
      process.execPath,
      [scriptPath, grandchildPidPath, grandchildReadyPath],
      {
        timeoutKillGraceMs: 100,
        timeoutMs: 100,
      },
    );
    const runErrorPromise = runPromise.then(
      () => {
        throw new Error("expected timed command to reject");
      },
      (error: unknown) => error,
    );

    try {
      await waitFor(() => existsSync(grandchildPidPath));
      await waitFor(() => existsSync(grandchildReadyPath));
      grandchildPid = Number.parseInt(readText(grandchildPidPath), 10);
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(isProcessAlive(grandchildPid)).toBe(true);

      const runError = await runErrorPromise;
      expect(runError).toBeInstanceOf(Error);
      expect((runError as Error).message).toContain("timed out after 100ms");
      await waitFor(() => !isProcessAlive(grandchildPid), 5_000);
    } finally {
      await runPromise.catch(() => {});
      if (grandchildPid && isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
      cleanupTempDirs(tempDirs);
    }
  });

  posixIt("cleans active command process groups before parent signal exit", async () => {
    const tempDirs: string[] = [];
    const root = makeTempDir(tempDirs, "openclaw-kitchen-rpc-parent-signal-");
    const runnerPath = path.join(root, "runner.mjs");
    const scriptPath = path.join(root, "term-zero-grandchild.mjs");
    const grandchildPidPath = path.join(root, "grandchild.pid");
    const readyPath = path.join(root, "ready");
    let grandchildPid = 0;
    let runner: ReturnType<typeof spawn> | undefined;
    const grandchildScript = [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      "process.on('SIGHUP', () => {});",
      `fs.writeFileSync(${JSON.stringify(readyPath)}, 'ready');`,
      "setInterval(() => {}, 1000);",
    ].join("\n");

    writeFileSync(
      scriptPath,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";

const grandchild = spawn(process.execPath, ["-e", ${JSON.stringify(grandchildScript)}], {
  stdio: "ignore",
});
fs.writeFileSync(${JSON.stringify(grandchildPidPath)}, String(grandchild.pid));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`,
      "utf8",
    );
    writeFileSync(
      runnerPath,
      `
import { runCommand } from ${JSON.stringify(
        new URL("../../scripts/e2e/kitchen-sink-rpc-walk.mjs", import.meta.url).href,
      )};

await runCommand(process.execPath, [${JSON.stringify(scriptPath)}], {
  timeoutKillGraceMs: 100,
  timeoutMs: 30_000,
});
`,
      "utf8",
    );

    try {
      runner = spawn(process.execPath, [runnerPath], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCLAW_TEST_KITCHEN_SINK_PARENT_SIGNAL_KILL_GRACE_MS: "100",
        },
        stdio: ["ignore", "ignore", "pipe"],
      });
      await waitFor(() => existsSync(readyPath) && existsSync(grandchildPidPath));
      grandchildPid = Number.parseInt(readText(grandchildPidPath), 10);
      expect(Number.isInteger(grandchildPid)).toBe(true);
      expect(isProcessAlive(grandchildPid)).toBe(true);

      runner.kill("SIGTERM");

      await expect(waitForChildClose(runner, 5_000)).resolves.toEqual({
        code: null,
        signal: "SIGTERM",
      });
      await waitFor(() => !isProcessAlive(grandchildPid), 5_000);
    } finally {
      if (grandchildPid && isProcessAlive(grandchildPid)) {
        process.kill(grandchildPid, "SIGKILL");
      }
      if (runner?.pid && isProcessAlive(runner.pid)) {
        runner.kill("SIGKILL");
      }
      cleanupTempDirs(tempDirs);
    }
  });
});

describe("kitchen-sink RPC payload unwrapping", () => {
  it("parses the final JSON record without accepting inline diagnostic objects", () => {
    const parsed = parseJsonOutput(
      [
        'debug: ignored inline diagnostic {"ok":false,"result":{"stale":true}}',
        JSON.stringify({ ok: true, result: { current: true } }, null, 2),
        'warning: ignored trailing diagnostic {"ok":false,"result":{"stale":true}}',
      ].join("\n"),
    );

    expect(parsed).toEqual({ ok: true, result: { current: true } });
  });

  it("preserves explicit nullish JSON-RPC result fields", () => {
    expect(unwrapRpcPayload({ jsonrpc: "2.0", result: null })).toBeNull();
    expect(unwrapRpcPayload({ jsonrpc: "2.0", result: undefined })).toBeUndefined();
  });

  it("prefers result before legacy payload and data envelopes", () => {
    expect(unwrapRpcPayload({ result: false, payload: { stale: true } })).toBe(false);
    expect(unwrapRpcPayload({ payload: null, data: { stale: true } })).toBeNull();
    expect(unwrapRpcPayload({ data: 0 })).toBe(0);
  });

  it("rejects error envelopes without success payload fields", () => {
    const error = captureSyncError(() =>
      unwrapRpcPayload({ error: { message: "session store unavailable" } }),
    );

    expect(error.message).toContain("gateway RPC returned error envelope");
    expect(error.message).toContain("session store unavailable");
    expect(unwrapRpcPayload({ error: { message: "ignored" }, payload: { ok: true } })).toEqual({
      ok: true,
    });
  });

  it("preserves gateway request error metadata from built RPC calls", () => {
    const error = captureSyncError(() =>
      unwrapRpcPayload({
        ok: false,
        error: {
          type: "gateway_request_error",
          code: "INVALID_REQUEST",
          message: "unauthorized role: operator",
          details: { method: "skills.bins" },
          retryable: false,
          retryAfterMs: 250,
        },
      }),
    );

    expect(error).toMatchObject({
      name: "GatewayClientRequestError",
      message: "unauthorized role: operator",
      gatewayCode: "INVALID_REQUEST",
      details: { method: "skills.bins" },
      retryable: false,
      retryAfterMs: 250,
    });
  });

  it("bounds failed RPC payload diagnostics", () => {
    const error = captureSyncError(() =>
      unwrapRpcPayload({
        ok: false,
        error: {
          message: `rpc failed ${"x".repeat(4096)} DO_NOT_DUMP_RPC_MIDDLE ${"y".repeat(4096)} end`,
        },
      }),
    );

    expect(error.message).toContain("gateway RPC failed");
    expect(error.message).toContain("truncated");
    expect(error.message).not.toContain("DO_NOT_DUMP_RPC_MIDDLE");
    expect(error.message.length).toBeLessThan(1200);
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

  it("requires every expected Kitchen Sink plugin tool", () => {
    expect(() =>
      assertExpectedKitchenSinkToolEntries(
        [{ id: "kitchen_sink_text", source: "plugin", pluginId: "openclaw-kitchen-sink-fixture" }],
        "tools.catalog plugin tools",
        { requirePluginProvenance: true },
      ),
    ).toThrow("tools.catalog plugin tools missing kitchen_sink_search, kitchen_sink_image_job");
  });

  it("requires plugin provenance for expected catalog tools", () => {
    expect(() =>
      assertExpectedKitchenSinkToolEntries(
        [
          { id: "kitchen_sink_text", source: "plugin", pluginId: "openclaw-kitchen-sink-fixture" },
          { id: "kitchen_sink_search", source: "core", pluginId: "openclaw-kitchen-sink-fixture" },
          { id: "kitchen_sink_image_job", source: "plugin", pluginId: "other-plugin" },
        ],
        "tools.catalog plugin tools",
        { requirePluginProvenance: true },
      ),
    ).toThrow("tools.catalog plugin tools plugin provenance mismatch");
  });

  it("accepts complete expected tool coverage", () => {
    expect(
      assertExpectedKitchenSinkToolEntries(
        [
          { id: "kitchen_sink_text", source: "plugin", pluginId: "openclaw-kitchen-sink-fixture" },
          {
            id: "kitchen_sink_search",
            source: "plugin",
            pluginId: "openclaw-kitchen-sink-fixture",
          },
          {
            id: "kitchen_sink_image_job",
            source: "plugin",
            pluginId: "openclaw-kitchen-sink-fixture",
          },
        ],
        "tools.catalog plugin tools",
        { requirePluginProvenance: true },
      ),
    ).toEqual(["kitchen_sink_text", "kitchen_sink_search", "kitchen_sink_image_job"]);
  });

  it("invokes every advertised Kitchen Sink tool during the RPC walk", () => {
    expect(listKitchenSinkToolInvokeNames().toSorted()).toEqual([
      "kitchen_sink_image_job",
      "kitchen_sink_search",
      "kitchen_sink_text",
    ]);
  });

  it("walks broad read-only gateway RPC surfaces", () => {
    expect(listKitchenSinkReadOnlyRpcProbeNames()).toEqual(
      expect.arrayContaining([
        "gateway.identity.get",
        "config.schema.lookup",
        "models.list",
        "skills.status",
        "agents.list",
        "sessions.list",
        "cron.list",
        "tasks.list",
        "usage.status",
        "voicewake.routing.get",
        "talk.catalog",
        "update.status",
        "node.list",
        "device.pair.list",
        "exec.approvals.get",
        "environments.status",
      ]),
    );
  });

  it("proves node-only RPC authorization boundaries", async () => {
    expect(listKitchenSinkAuthorizationRpcProbeNames()).toEqual(["skills.bins"]);
    await expect(
      assertOperatorRpcDenied({ method: "skills.bins", params: {} }, async () => {
        throw Object.assign(new Error("unauthorized role: operator"), {
          gatewayCode: "INVALID_REQUEST",
        });
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertOperatorRpcDenied({ method: "skills.bins", params: {} }, async () =>
        unwrapRpcPayload({
          ok: false,
          error: {
            type: "gateway_request_error",
            code: "INVALID_REQUEST",
            message: "unauthorized role: operator",
            retryable: false,
          },
        }),
      ),
    ).resolves.toBeUndefined();
    await expect(
      assertOperatorRpcDenied({ method: "skills.bins", params: {} }, async () => {
        throw new Error(
          "openclaw gateway call skills.bins failed with 1\nGateway call failed: unauthorized role: operator",
        );
      }),
    ).rejects.toThrow("Gateway call failed: unauthorized role: operator");
    await expect(
      assertOperatorRpcDenied({ method: "skills.bins", params: {} }, async () => ({})),
    ).rejects.toThrow("skills.bins unexpectedly allowed operator access");
  });

  it("reconstructs typed request failures from gateway CLI JSON", async () => {
    const payload = formatGatewayClientRequestErrorJson(
      Object.assign(new Error("unauthorized role: operator"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
        details: { method: "skills.bins" },
        retryable: false,
        retryAfterMs: 250,
      }),
    );

    expect(
      parseGatewayCliRequestFailure({
        stdout: JSON.stringify(payload),
      }),
    ).toMatchObject({
      name: "GatewayClientRequestError",
      message: "unauthorized role: operator",
      gatewayCode: "INVALID_REQUEST",
      details: { method: "skills.bins" },
      retryable: false,
      retryAfterMs: 250,
    });
    expect(parseGatewayCliRequestFailure(new Error("plain failure"))).toBeNull();
    for (const invalidFields of [{ retryable: "no" }, { retryable: false, retryAfterMs: -1 }]) {
      expect(
        parseGatewayCliRequestFailure({
          stdout: JSON.stringify({
            ok: false,
            error: {
              type: "gateway_request_error",
              code: "INVALID_REQUEST",
              message: "unauthorized role: operator",
              ...invalidFields,
            },
          }),
        }),
      ).toBeNull();
    }
  });

  it("requires provenance for effective Kitchen Sink plugin tools too", () => {
    expect(() =>
      assertExpectedKitchenSinkToolEntries(
        [
          { id: "kitchen_sink_text", source: "plugin", pluginId: "openclaw-kitchen-sink-fixture" },
          {
            id: "kitchen_sink_search",
            source: "plugin",
            pluginId: "openclaw-kitchen-sink-fixture",
          },
          {
            id: "kitchen_sink_image_job",
            source: "core",
            pluginId: "openclaw-kitchen-sink-fixture",
          },
        ],
        "tools.effective plugin tools",
        { requirePluginProvenance: true },
      ),
    ).toThrow("tools.effective plugin tools plugin provenance mismatch");
  });

  it("requires the exact Kitchen Sink channel account", () => {
    expect(() =>
      assertChannelAccountRunning({
        channelAccounts: {
          "kitchen-sink-channel": [{ accountId: "other", configured: true, running: true }],
        },
      }),
    ).toThrow("Kitchen Sink channel account local was not reported");
  });

  it("checks TTS providers on the exact response surfaces", () => {
    expect(extractTtsProviderIds({ providers: [{ id: "nested-miss" }] }, "providers")).toEqual([
      "nested-miss",
    ]);
    expect(
      extractTtsProviderIds(
        {
          metadata: { id: "kitchen-sink-speech" },
          providers: [{ id: "other", configured: true }],
        },
        "providers",
      ),
    ).toEqual(["other"]);

    expect(() =>
      assertTtsProviderCoverage(
        {
          providers: [{ id: "kitchen-sink-speech", configured: true }],
        },
        "providers",
      ),
    ).not.toThrow();
    expect(() =>
      assertTtsProviderCoverage(
        {
          providerStates: [{ id: "kitchen-sink-speech-provider", configured: true }],
        },
        "status",
      ),
    ).not.toThrow();
    expect(() =>
      assertTtsProviderCoverage(
        {
          metadata: { id: "kitchen-sink-speech" },
          providers: [{ id: "other", configured: true }],
        },
        "providers",
      ),
    ).toThrow("tts.providers missing one of");
    expect(() =>
      assertTtsProviderCoverage(
        {
          providerStates: [{ id: "kitchen-sink-speech", configured: false }],
        },
        "status",
      ),
    ).toThrow("did not report a configured Kitchen Sink speech provider");
  });

  it("checks search, text, and image job tool invocation fixtures separately", () => {
    const pngBytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
      "base64",
    );
    const pngSha256 = createHash("sha256").update(pngBytes).digest("hex");
    expect(() =>
      assertKitchenSinkSearchInvokeResult({
        ok: true,
        source: "plugin",
        output: { results: [{ title: "Kitchen Sink image fixture" }] },
      }),
    ).not.toThrow();
    expect(() =>
      assertKitchenSinkTextInvokeResult({
        ok: true,
        source: "plugin",
        output: {
          route: "tool:kitchen_sink_text",
          text: "Kitchen Sink text provider produced a deterministic reply.",
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertKitchenSinkImageJobInvokeResult({
        ok: true,
        source: "plugin",
        output: {
          ok: true,
          route: "tool:kitchen_sink_image_job",
          job: { status: "completed", route: "tool:kitchen_sink_image_job" },
          mediaUrl: `data:image/png;base64,${pngBytes.toString("base64")}`,
          image: {
            mimeType: "image/png",
            metadata: {
              assetName: "kitchen_sink_office.png",
              height: 1024,
              sha256: pngSha256,
              width: 1024,
            },
          },
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertKitchenSinkTextInvokeResult({
        ok: true,
        source: "plugin",
        output: { route: "tool:kitchen_sink_search" },
      }),
    ).toThrow("Kitchen Sink text tool output missed expected fixture");
  });

  it("rejects tool invocation canaries outside the structured result fields", () => {
    expect(() =>
      assertKitchenSinkSearchInvokeResult({
        ok: true,
        source: "plugin",
        output: { note: "prompt mentioned Kitchen Sink image fixture" },
      }),
    ).toThrow("Kitchen Sink search tool output missed expected fixture");

    expect(() =>
      assertKitchenSinkTextInvokeResult({
        ok: true,
        source: "plugin",
        output: { text: "Kitchen Sink prompt echoed tool:kitchen_sink_text" },
      }),
    ).toThrow("Kitchen Sink text tool output missed expected fixture");

    expect(() =>
      assertKitchenSinkImageJobInvokeResult({
        ok: true,
        source: "plugin",
        output: {
          ok: true,
          route: "tool:kitchen_sink_image_job",
          job: { status: "completed", route: "tool:kitchen_sink_image_job" },
          mediaUrl: "data:image/png;base64,fixture",
          image: {
            mimeType: "image/png",
            metadata: {
              assetName: "kitchen_sink_office.png",
              height: 1024,
              sha256: "not-a-real-hash",
              width: 1024,
            },
          },
        },
      }),
    ).toThrow("Kitchen Sink image job tool output missed expected fixture");
  });

  it("bounds failed tool invocation diagnostics", () => {
    const error = captureSyncError(() =>
      assertKitchenSinkSearchInvokeResult({
        ok: false,
        source: "plugin",
        output: {
          text: `prefix ${"x".repeat(4096)} DO_NOT_DUMP_TOOL_MIDDLE ${"y".repeat(4096)} suffix`,
        },
      }),
    );

    expect(error.message).toContain("Kitchen Sink search tool invoke failed");
    expect(error.message).toContain("truncated");
    expect(error.message).not.toContain("DO_NOT_DUMP_TOOL_MIDDLE");
    expect(error.message.length).toBeLessThan(1400);
  });

  it("requires sessions.create to return the requested Kitchen Sink session", () => {
    expect(() =>
      assertCreatedKitchenSinkSession({
        ok: true,
        key: "agent:main:kitchen-sink-rpc",
        sessionId: "session-1",
      }),
    ).not.toThrow();

    expect(() =>
      assertCreatedKitchenSinkSession({
        ok: true,
        key: "agent:main:stale-session",
        sessionId: "session-1",
      }),
    ).toThrow("sessions.create did not return the requested Kitchen Sink session");
    expect(() =>
      assertCreatedKitchenSinkSession({
        ok: true,
        key: "agent:main:kitchen-sink-rpc",
      }),
    ).toThrow("sessions.create did not return the requested Kitchen Sink session");
  });

  it("requires Kitchen Sink UI descriptor coverage", () => {
    expect(() =>
      assertKitchenSinkUiDescriptors({
        ok: true,
        descriptors: [{ pluginId: "openclaw-kitchen-sink-fixture", id: "kitchen-sink-panel" }],
      }),
    ).not.toThrow();

    expect(() => assertKitchenSinkUiDescriptors({})).toThrow(
      "plugins.uiDescriptors returned invalid payload",
    );
    expect(() => assertKitchenSinkUiDescriptors({ ok: true, descriptors: [] })).toThrow(
      "plugins.uiDescriptors did not report Kitchen Sink descriptor",
    );
  });

  it("allows conformance mode to skip generated Kitchen Sink UI descriptors", () => {
    expect(() =>
      assertKitchenSinkUiDescriptors(
        {
          ok: true,
          descriptors: [],
        },
        { expectDescriptor: false },
      ),
    ).not.toThrow();

    expect(() => assertKitchenSinkUiDescriptors({}, { expectDescriptor: false })).toThrow(
      "plugins.uiDescriptors returned invalid payload",
    );
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

describe("kitchen-sink RPC health/status assertions", () => {
  it("rejects empty health and status RPC payloads", () => {
    expect(() => assertGatewayHealthPayload({})).toThrow("health payload missing");
    expect(() => assertGatewayStatusPayload({})).toThrow("status payload missing");
  });

  it("accepts minimally valid gateway health and status RPC payloads", () => {
    expect(() =>
      assertGatewayHealthPayload({
        ok: true,
        ts: Date.now(),
        durationMs: 12,
        channels: {},
        channelOrder: [],
        channelLabels: {},
        heartbeatSeconds: 30,
        defaultAgentId: "main",
        agents: [],
        sessions: {
          path: "/tmp/openclaw-sessions.sqlite",
          count: 0,
          recent: [],
        },
      }),
    ).not.toThrow();

    expect(() =>
      assertGatewayStatusPayload({
        heartbeat: {
          defaultAgentId: "main",
          agents: [],
        },
        channelSummary: [],
        queuedSystemEvents: [],
        tasks: {},
        taskAudit: {},
        sessions: {
          paths: [],
          count: 0,
          defaults: {
            model: null,
            contextTokens: null,
          },
          recent: [],
          byAgent: [],
        },
      }),
    ).not.toThrow();
  });

  it("bounds failed health and status payload diagnostics", () => {
    const oversizedValue = `start ${"x".repeat(4096)} DO_NOT_DUMP_STATUS_MIDDLE ${"y".repeat(
      4096,
    )} end`;

    const healthError = captureSyncError(() =>
      assertGatewayHealthPayload({
        ok: false,
        oversizedValue,
      }),
    );
    const statusError = captureSyncError(() =>
      assertGatewayStatusPayload({
        heartbeat: {},
        oversizedValue,
      }),
    );

    expect(healthError.message).toContain("health payload missing");
    expect(statusError.message).toContain("status payload missing");
    expect(`${healthError.message}\n${statusError.message}`).toContain("truncated");
    expect(`${healthError.message}\n${statusError.message}`).not.toContain(
      "DO_NOT_DUMP_STATUS_MIDDLE",
    );
    expect(healthError.message.length).toBeLessThan(1600);
    expect(statusError.message.length).toBeLessThan(1600);
  });
});

describe("kitchen-sink RPC process sampling", () => {
  it("rejects unsafe Windows System32 executable names", () => {
    expect(() => resolveWindowsSystem32Path("..\\netstat.exe")).toThrow(
      /Invalid Windows System32 executable name/u,
    );
    expect(() => resolveWindowsSystem32Path("netstat")).toThrow(
      /Invalid Windows System32 executable name/u,
    );
  });

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
    expect(calls[0]?.command).toBe(expectedPowerShellPath());
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

  it("does not fall back to a PATH-resolved powershell command on Windows", async () => {
    const commands: string[] = [];
    const sample = await sampleProcess(1234, {
      platform: "win32",
      runCommand: async (command: string) => {
        commands.push(command);
        throw new Error("trusted powershell unavailable");
      },
    });

    expect(commands).toEqual([expectedPowerShellPath()]);
    expect(sample).toBeNull();
  });

  it("does not truncate malformed Windows PowerShell CPU or id samples", async () => {
    const sample = await sampleProcess(1234, {
      platform: "win32",
      runCommand: async () => ({
        stdout: `${256 * 1024 * 1024} 2.25oops 6789x ${512 * 1024 * 1024}oops`,
        stderr: "",
      }),
    });

    expect(sample).toEqual({
      aggregateRssMiB: 256,
      cpuPercent: null,
      cpuSeconds: null,
      processId: 1234,
      rssMiB: 256,
    });
  });

  it("rejects malformed Windows PowerShell RSS samples", async () => {
    const sample = await sampleProcess(1234, {
      platform: "win32",
      runCommand: async () => ({
        stdout: `${256 * 1024 * 1024}oops 2.25 6789 ${512 * 1024 * 1024}`,
        stderr: "",
      }),
    });

    expect(sample).toBeNull();
  });

  posixIt("rejects malformed POSIX process rows before sampling RSS", async () => {
    const badRows = [
      "  5678  1234  9007199254740993  0.2 child",
      "  5678x  1234  2048  0.2 child",
      "  5678  1234x  2048  0.2 child",
    ];

    for (const badRow of badRows) {
      const sample = await sampleProcess(1234, {
        platform: "linux",
        runCommand: async () => ({
          stdout: [
            "  PID  PPID   RSS %CPU COMMAND",
            "  1234     1  2048  0.1 openclaw-gateway",
            badRow,
          ].join("\n"),
          stderr: "",
        }),
      });

      expect(sample).toBeNull();
    }
  });

  posixIt("ignores malformed POSIX process rows outside the sampled tree", async () => {
    const sample = await sampleProcess(1234, {
      platform: "linux",
      runCommand: async () => ({
        stdout: [
          "  PID  PPID   RSS %CPU COMMAND",
          "  1234     1  2048  0.1 openclaw-gateway",
          "  5678  1234  4096  0.2 child",
          "  9999  9998  9007199254740993  0.2 unrelated",
        ].join("\n"),
        stderr: "",
      }),
    });

    expect(sample).toMatchObject({
      aggregateRssMiB: 6,
      processId: 1234,
      rssMiB: 2,
    });
  });

  it("samples the Windows gateway process by listening port", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const sample = await sampleWindowsProcessByPort(19675, {
      runCommand: async (command: string, args: string[]) => {
        calls.push({ command, args });
        if (command === expectedWindowsSystem32Path("netstat.exe")) {
          return {
            stdout: [
              "  Proto  Local Address          Foreign Address        State           PID",
              "  TCP    127.0.0.1:196750       0.0.0.0:0              LISTENING       1111",
              "  TCP    127.0.0.1:1967         0.0.0.0:0              LISTENING       2222",
              "  TCP    127.0.0.1:19675        0.0.0.0:0              LISTENING       6789",
            ].join("\r\n"),
            stderr: "",
          };
        }
        if (command === expectedPowerShellPath()) {
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
      { command: expectedWindowsSystem32Path("netstat.exe"), args: ["-ano", "-p", "tcp"] },
      {
        command: expectedPowerShellPath(),
        args: expect.arrayContaining(["-Command", expect.stringContaining("$rootPid = 6789")]),
      },
    ]);
  });

  it("falls back to strict tasklist RSS when Windows PowerShell sampling fails", async () => {
    const calls: string[] = [];
    const sample = await sampleWindowsProcessByPort(19675, {
      runCommand: async (command: string) => {
        calls.push(command);
        if (command === expectedWindowsSystem32Path("netstat.exe")) {
          return {
            stdout: [
              "  Proto  Local Address          Foreign Address        State           PID",
              "  TCP    127.0.0.1:19675        0.0.0.0:0              LISTENING       6789",
            ].join("\r\n"),
            stderr: "",
          };
        }
        if (command === expectedPowerShellPath()) {
          throw new Error("powershell unavailable");
        }
        if (command === expectedWindowsSystem32Path("tasklist.exe")) {
          return {
            stdout: '"node.exe","6789","Console","1","262,144 K"',
            stderr: "",
          };
        }
        throw new Error(`unexpected command ${command}`);
      },
    });

    expect(sample).toEqual({
      cpuPercent: null,
      cpuSeconds: null,
      processId: 6789,
      rssMiB: 256,
    });
    expect(calls).toEqual([
      expectedWindowsSystem32Path("netstat.exe"),
      expectedPowerShellPath(),
      expectedWindowsSystem32Path("tasklist.exe"),
    ]);
  });

  it("falls back to the known Windows pid when tasklist reports malformed pid text", async () => {
    const sample = await sampleWindowsProcessByPort(19675, {
      runCommand: async (command: string) => {
        if (command === expectedWindowsSystem32Path("netstat.exe")) {
          return {
            stdout: [
              "  Proto  Local Address          Foreign Address        State           PID",
              "  TCP    127.0.0.1:19675        0.0.0.0:0              LISTENING       6789",
            ].join("\r\n"),
            stderr: "",
          };
        }
        if (command === expectedPowerShellPath()) {
          throw new Error("powershell unavailable");
        }
        if (command === expectedWindowsSystem32Path("tasklist.exe")) {
          return {
            stdout: '"node.exe","9999x","Console","1","262,144 K"',
            stderr: "",
          };
        }
        throw new Error(`unexpected command ${command}`);
      },
    });

    expect(sample).toEqual({
      cpuPercent: null,
      cpuSeconds: null,
      processId: 6789,
      rssMiB: 256,
    });
  });

  it("rejects malformed tasklist RSS instead of stripping digits", async () => {
    const sample = await sampleWindowsProcessByPort(19675, {
      runCommand: async (command: string) => {
        if (command === expectedWindowsSystem32Path("netstat.exe")) {
          return {
            stdout: [
              "  Proto  Local Address          Foreign Address        State           PID",
              "  TCP    127.0.0.1:19675        0.0.0.0:0              LISTENING       6789",
            ].join("\r\n"),
            stderr: "",
          };
        }
        if (command === expectedPowerShellPath()) {
          throw new Error("powershell unavailable");
        }
        if (command === expectedWindowsSystem32Path("tasklist.exe")) {
          return {
            stdout: '"node.exe","6789","Console","1","262x144 K"',
            stderr: "",
          };
        }
        throw new Error(`unexpected command ${command}`);
      },
    });

    expect(sample).toBeNull();
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

  it("does not truncate malformed POSIX CPU samples", async () => {
    const sample = await sampleProcess(4321, {
      platform: "linux",
      runCommand: async () => ({
        stdout: " 4321     1  262144  12.5.6 node dist/index.js gateway --port 19080",
        stderr: "",
      }),
    });

    expect(sample).toEqual({
      aggregateRssMiB: 256,
      cpuPercent: null,
      processId: 4321,
      rssMiB: 256,
    });
  });

  it("does not loop forever on self-parenting POSIX process rows", async () => {
    const sample = await sampleProcess(4321, {
      platform: "linux",
      runCommand: async () => ({
        stdout: " 4321  4321  262144  12.5 node dist/index.js gateway --port 19080",
        stderr: "",
      }),
    });

    expect(sample).toEqual({
      aggregateRssMiB: 256,
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

  it("samples the POSIX gateway root when command-line needles match", async () => {
    const sample = await sampleProcess(4321, {
      platform: "darwin",
      posixCommandLineNeedles: ["gateway", "--port", "19080"],
      runCommand: async () => ({
        stdout:
          " 4321     1  262144  12.5 node dist/index.js gateway --port 19080 --bind loopback\n",
        stderr: "",
      }),
    });

    expect(sample).toEqual({
      aggregateRssMiB: 256,
      cpuPercent: 12.5,
      processId: 4321,
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

  it("aborts HTTP probe retry backoff when the external signal fires", async () => {
    const controller = new AbortController();
    const reset = new TypeError("fetch failed", {
      cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
    });
    const fetchImpl = vi.fn().mockRejectedValue(reset);
    const startedAt = Date.now();

    setTimeout(() => {
      controller.abort(new Error("gateway exited before ready"));
    }, 25);

    await expect(
      fetchJson("http://127.0.0.1:19680/healthz", {
        attempts: 2,
        fetchImpl,
        retryDelayMs: 5_000,
        signal: controller.signal,
      }),
    ).rejects.toThrow("gateway exited before ready");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(Date.now() - startedAt).toBeLessThan(500);
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

  it("clamps oversized HTTP probe timeouts before scheduling timers", async () => {
    const fetchImpl = vi.fn(async () => {
      await delay(25);
      return new Response('{"status":"live"}', { status: 200 });
    });

    await expect(
      fetchJson("http://127.0.0.1:19680/healthz", {
        attempts: 1,
        fetchImpl,
        timeoutMs: Number.MAX_SAFE_INTEGER,
      }),
    ).resolves.toEqual({ ok: true, status: 200, body: { status: "live" } });
    expect(fetchImpl).toHaveBeenCalledOnce();
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

  it("rejects unsafe decimal HTTP content lengths before reading", async () => {
    const response = {
      headers: new Headers({
        "content-length": "9007199254740992",
      }),
      text: vi.fn(async () => "not read"),
    };

    await expect(readBoundedResponseText(response, 1024)).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "fetch response body exceeded 1024 bytes",
    });
    expect(response.text).not.toHaveBeenCalled();
  });

  it("streams HTTP probe responses with non-decimal content-length values", async () => {
    let readStarted = false;
    let canceled = false;
    const response = {
      headers: new Headers({
        "content-length": "1e3",
      }),
      body: {
        getReader() {
          return {
            async read() {
              readStarted = true;
              return { done: false, value: new Uint8Array(1025) };
            },
            async cancel() {
              canceled = true;
            },
          };
        },
      },
      text: vi.fn(async () => "not read"),
    };

    await expect(readBoundedResponseText(response, 1024)).rejects.toMatchObject({
      code: "ETOOBIG",
      message: "fetch response body exceeded 1024 bytes",
    });
    expect(readStarted).toBe(true);
    expect(canceled).toBe(true);
    expect(response.text).not.toHaveBeenCalled();
  });

  it("reads bounded response streams", async () => {
    await expect(readBoundedResponseText(new Response('{"status":"live"}'), 1024)).resolves.toBe(
      '{"status":"live"}',
    );
  });

  it("releases HTTP probe response stream readers after bounded reads", async () => {
    const releaseLock = vi.fn();
    const response = {
      headers: new Headers(),
      body: {
        getReader() {
          return {
            read: vi
              .fn()
              .mockResolvedValueOnce({ done: false, value: new TextEncoder().encode("ok") })
              .mockResolvedValueOnce({ done: true }),
            releaseLock,
          };
        },
      },
      text: vi.fn(async () => "not read"),
    };

    await expect(readBoundedResponseText(response, 1024)).resolves.toBe("ok");

    expect(releaseLock).toHaveBeenCalledOnce();
    expect(response.text).not.toHaveBeenCalled();
  });

  it("cancels stalled HTTP probe response streams when the timeout wins", async () => {
    let canceled = false;
    const timeoutError = Object.assign(new Error("fetch probe timed out"), {
      code: "ETIMEDOUT",
    });
    const response = new Response(
      new ReadableStream({
        pull() {
          return new Promise(() => {});
        },
        cancel() {
          canceled = true;
        },
      }),
      { headers: new Headers() },
    );

    await expect(
      readBoundedResponseText(response, 1024, Promise.reject(timeoutError)),
    ).rejects.toMatchObject({
      code: "ETIMEDOUT",
      message: "fetch probe timed out",
    });
    expect(canceled).toBe(true);
  });

  it("cancels stalled HTTP probe response streams when the external signal fires", async () => {
    let readStarted = false;
    let canceled = false;
    const controller = new AbortController();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          pull() {
            readStarted = true;
            return new Promise(() => {});
          },
          cancel() {
            canceled = true;
          },
        }),
        { status: 200 },
      ),
    );

    const result = fetchJson("http://127.0.0.1:19680/readyz", {
      attempts: 1,
      fetchImpl,
      signal: controller.signal,
      timeoutMs: 30_000,
    });
    const rejection = expect(result).rejects.toThrow("gateway exited before ready");

    await waitFor(() => readStarted);
    controller.abort(new Error("gateway exited before ready"));

    await rejection;
    await waitFor(() => canceled);
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

  it("fails zero-valued process RSS samples", () => {
    expect(() => assertResourceCeiling({ rssMiB: 0 })).toThrow(
      "gateway RSS sample was invalid: 0 MiB",
    );
    expect(() => assertCommandResourceCeiling({ aggregateRssMiB: 0, rssMiB: 128 })).toThrow(
      "command aggregate RSS sample was invalid: 0 MiB",
    );
  });

  it("fails missing command samples and command RSS spikes", () => {
    expect(() => assertCommandResourceCeiling(null)).toThrow("command RSS sample was not captured");
    expect(() => assertCommandResourceCeiling({ aggregateRssMiB: 8193, rssMiB: 1024 })).toThrow(
      "command aggregate RSS exceeded 8192 MiB: 8193 MiB",
    );
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

async function waitForChildClose(child: ReturnType<typeof spawn>, timeoutMs = 3_000) {
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("child did not close before timeout"));
      }, timeoutMs);
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        resolve({ code, signal });
      });
    },
  );
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
