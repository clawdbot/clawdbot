import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { vi, type Mock } from "vitest";

export function createStubChild(pid = 1234) {
  const child = new EventEmitter() as ChildProcess;
  child.stdin = new PassThrough() as ChildProcess["stdin"];
  child.stdout = new PassThrough() as ChildProcess["stdout"];
  child.stderr = new PassThrough() as ChildProcess["stderr"];
  Object.defineProperty(child, "stdio", {
    value: [child.stdin, child.stdout, child.stderr],
    configurable: true,
  });
  Object.defineProperty(child, "pid", { value: pid, configurable: true });
  Object.defineProperty(child, "killed", { value: false, configurable: true, writable: true });
  Object.defineProperty(child, "exitCode", { value: null, configurable: true, writable: true });
  Object.defineProperty(child, "signalCode", { value: null, configurable: true, writable: true });
  Object.defineProperty(child, "channel", { value: {}, configurable: true });
  Object.defineProperty(child, "connected", { value: true, configurable: true, writable: true });
  const killMock = vi.fn(() => true);
  const sendMock = vi.fn((_message: unknown, ...args: unknown[]) => {
    const callback = args.findLast((value) => typeof value === "function") as
      | ((error: Error | null) => void)
      | undefined;
    callback?.(null);
    return true;
  });
  const disconnectMock = vi.fn(() => {
    Object.defineProperty(child, "connected", { value: false, configurable: true, writable: true });
    child.emit("disconnect");
  });
  child.kill = killMock as ChildProcess["kill"];
  child.send = sendMock as ChildProcess["send"];
  child.disconnect = disconnectMock as ChildProcess["disconnect"];
  const emitClose = (code: number | null, signal: NodeJS.Signals | null = null) => {
    child.emit("close", code, signal);
  };
  const emitExit = (code: number | null, signal: NodeJS.Signals | null = null) => {
    Object.defineProperty(child, "exitCode", { value: code, configurable: true, writable: true });
    Object.defineProperty(child, "signalCode", {
      value: signal,
      configurable: true,
      writable: true,
    });
    child.emit("exit", code, signal);
  };
  return { child, disconnectMock, killMock, sendMock, emitClose, emitExit };
}

type SpawnWithFallbackParams = {
  argv?: string[];
  options?: {
    detached?: boolean;
    env?: NodeJS.ProcessEnv | Record<string, string>;
    stdio?: string[];
    windowsHide?: boolean;
    windowsVerbatimArguments?: boolean;
  };
  fallbacks?: Array<{ options?: { detached?: boolean } }>;
};

export function firstSpawnWithFallbackParams(mock: Mock): SpawnWithFallbackParams {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error("expected spawnWithFallback call");
  }
  const [params] = call;
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    throw new Error("expected spawnWithFallback params to be an object");
  }
  return params;
}

export function firstMockArg(
  mock: { mock: { calls: readonly unknown[][] } },
  label: string,
): unknown {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call[0];
}

export async function createWindowsNpmShim(params: {
  binDir: string;
  command: string;
  packagePath: string[];
}) {
  const { binDir } = params;
  const entrypoint = path.join(binDir, "node_modules", ...params.packagePath);
  await mkdir(path.dirname(entrypoint), { recursive: true });
  await writeFile(entrypoint, "", "utf8");
  const relativeEntrypoint = path.relative(binDir, entrypoint).replaceAll(path.sep, "\\");
  const shimHead =
    "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n";
  const shimCommand = entrypoint.endsWith(".exe")
    ? `"%dp0%\\${relativeEntrypoint}" %*\r\n`
    : `IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\${relativeEntrypoint}" %*\r\n`;
  await writeFile(path.join(binDir, `${params.command}.cmd`), `${shimHead}${shimCommand}`, "utf8");
  return { binDir, entrypoint };
}
