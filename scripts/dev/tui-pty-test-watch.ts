// Tui Pty Test Watch script supports OpenClaw repository automation.
import { spawn, spawnSync } from "node:child_process";
import { mkdir, open, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sleep as delay } from "../lib/sleep.mjs";
import { resolveWindowsTaskkillPath } from "../lib/windows-taskkill.mjs";

type Options = {
  altScreen: boolean;
  help: boolean;
  mirrorPath: string;
  mode: "fake" | "local" | "all";
  vitestArgs: string[];
};

const DEFAULT_MIRROR_PATH = path.join(process.cwd(), ".artifacts", "tui-pty-mirror", "latest.ansi");
const require = createRequire(import.meta.url);
const MODE_TEST_FILES = {
  fake: ["src/tui/tui-pty-harness.e2e.test.ts"],
  local: ["src/tui/tui-pty-local.e2e.test.ts"],
  all: ["src/tui/tui-pty-harness.e2e.test.ts", "src/tui/tui-pty-local.e2e.test.ts"],
} as const;
const MIRROR_TERMINAL_QUERIES = ["\x1b[?u", "\x1b[16t"];
const DEFAULT_PTY_COLS = 100;
const DEFAULT_PTY_ROWS = 30;
const CHILD_SIGTERM_GRACE_MS = 500;
const CHILD_SIGKILL_GRACE_MS = 5_000;
const MIRROR_READ_CHUNK_BYTES = 1024 * 1024;
const CHILD_OUTPUT_TAIL_BYTES = 128 * 1024;
const BOOLEAN_OPTIONS = new Set(["--help", "-h", "--no-alt-screen"]);
const VALUE_OPTIONS = new Set(["--mode", "--mirror-path"]);

class CliArgumentError extends Error {
  override name = "CliArgumentError";
}

type KillableChild = {
  pid?: number;
  kill(signal: NodeJS.Signals): boolean;
};

type ChildStopper = {
  cancel: () => void;
  stop: () => void;
};

type SignalChild = (child: KillableChild, signal: NodeJS.Signals) => void;

type RunTaskkill = (
  command: string,
  args: string[],
  options: { stdio: "ignore" },
) => { error?: unknown; status?: number | null } | undefined;

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}

function readOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) {
    return undefined;
  }
  const value = args[idx + 1];
  if (!value || value.startsWith("-")) {
    throw new CliArgumentError(`${name} requires a value`);
  }
  return value.trim();
}

function readMode(args: string[]): Options["mode"] {
  const mode = readOption(args, "--mode") ?? "fake";
  if (mode === "fake" || mode === "local" || mode === "all") {
    return mode;
  }
  throw new CliArgumentError(`--mode must be fake, local, or all; got ${JSON.stringify(mode)}`);
}

function usage(): string {
  return [
    "Usage: node --import tsx scripts/dev/tui-pty-test-watch.ts [options] [-- vitest args...]",
    "",
    "Options:",
    "  --mode <fake|local|all>   Select TUI PTY test group (default: fake)",
    "  --mirror-path <path>       Write/read mirrored ANSI output at this path",
    "  --no-alt-screen            Print without switching to the terminal alt screen",
    "  -h, --help                 Show this help",
  ].join("\n");
}

function validateOwnArgs(args: string[]): void {
  for (let idx = 0; idx < args.length; idx += 1) {
    const arg = args[idx] ?? "";
    if (BOOLEAN_OPTIONS.has(arg)) {
      continue;
    }
    if (VALUE_OPTIONS.has(arg)) {
      idx += 1;
      continue;
    }
    throw new CliArgumentError(`Unknown argument: ${arg}`);
  }
}

function parseOptions(args = process.argv.slice(2)): Options {
  const separator = args.indexOf("--");
  const ownArgs = separator >= 0 ? args.slice(0, separator) : args;
  const vitestArgs = separator >= 0 ? args.slice(separator + 1) : [];
  validateOwnArgs(ownArgs);
  const mirrorPathOption = readOption(ownArgs, "--mirror-path");
  return {
    altScreen: !ownArgs.includes("--no-alt-screen"),
    help: ownArgs.includes("--help") || ownArgs.includes("-h"),
    mirrorPath:
      mirrorPathOption !== undefined ? path.resolve(mirrorPathOption) : DEFAULT_MIRROR_PATH,
    mode: readMode(ownArgs),
    vitestArgs,
  };
}

function shouldUseAltScreen(options: Options) {
  return options.altScreen && process.stdout.isTTY;
}

function resolveVitestCliEntry(): string {
  const vitestPackageJson = require.resolve("vitest/package.json");
  return path.join(path.dirname(vitestPackageJson), "vitest.mjs");
}

function currentTerminalDimension(value: number | undefined, fallback: number): string {
  return String(value && value > 0 ? value : fallback);
}

function signalWindowsProcessTree(
  pid: number,
  signal: NodeJS.Signals,
  runTaskkill: RunTaskkill = spawnSync,
): boolean {
  const args = ["/PID", String(pid), "/T"];
  if (signal === "SIGKILL") {
    args.push("/F");
  }
  const result = runTaskkill(resolveWindowsTaskkillPath(), args, { stdio: "ignore" });
  return !result?.error && result?.status === 0;
}

function signalWindowsProcessTreeOrForce(
  pid: number,
  signal: NodeJS.Signals,
  runTaskkill: RunTaskkill = spawnSync,
): boolean {
  if (signalWindowsProcessTree(pid, signal, runTaskkill)) {
    return true;
  }
  return signal !== "SIGKILL" && signalWindowsProcessTree(pid, "SIGKILL", runTaskkill);
}

function signalChildProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals,
  {
    platform = process.platform,
    runTaskkill = spawnSync,
    useProcessGroup = platform !== "win32",
  }: {
    platform?: NodeJS.Platform;
    runTaskkill?: RunTaskkill;
    useProcessGroup?: boolean;
  } = {},
): void {
  if (useProcessGroup && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Non-detached fallback or already-exited group; direct child signaling is
      // still useful on platforms without process groups.
    }
  }
  if (platform === "win32" && typeof child.pid === "number") {
    if (signalWindowsProcessTreeOrForce(child.pid, signal, runTaskkill)) {
      return;
    }
  }
  child.kill(signal);
}

function createChildStopper(
  child: KillableChild,
  options: {
    signalChild?: SignalChild;
    sigtermGraceMs?: number;
    sigkillGraceMs?: number;
  } = {},
): ChildStopper {
  const signalChild = options.signalChild ?? signalChildProcessTree;
  const sigtermGraceMs = options.sigtermGraceMs ?? CHILD_SIGTERM_GRACE_MS;
  const sigkillGraceMs = options.sigkillGraceMs ?? CHILD_SIGKILL_GRACE_MS;
  let stopping = false;
  let termTimer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    if (termTimer) {
      clearTimeout(termTimer);
      termTimer = undefined;
    }
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = undefined;
    }
  };

  const stop = () => {
    if (stopping) {
      return;
    }
    stopping = true;
    signalChild(child, "SIGINT");
    termTimer = setTimeout(() => {
      signalChild(child, "SIGTERM");
      killTimer = setTimeout(() => {
        signalChild(child, "SIGKILL");
      }, sigkillGraceMs);
      unrefTimer(killTimer);
    }, sigtermGraceMs);
    unrefTimer(termTimer);
  };

  return { cancel, stop };
}

async function createMirrorFile(mirrorPath: string): Promise<void> {
  await mkdir(path.dirname(mirrorPath), { recursive: true });
  await writeFile(mirrorPath, "", "utf8");
}

async function readNewMirrorData(
  mirrorPath: string,
  offset: number,
  maxChunkBytes = MIRROR_READ_CHUNK_BYTES,
) {
  const file = await open(mirrorPath, "r");
  try {
    const stats = await file.stat();
    const readOffset = stats.size < offset ? 0 : offset;
    const availableBytes = stats.size - readOffset;
    if (availableBytes <= 0) {
      return { chunk: Buffer.alloc(0), offset: readOffset };
    }
    const bytesToRead = Math.min(availableBytes, maxChunkBytes);
    const buffer = Buffer.alloc(bytesToRead);
    const { bytesRead } = await file.read(buffer, 0, bytesToRead, readOffset);
    return { chunk: buffer.subarray(0, bytesRead), offset: readOffset + bytesRead };
  } finally {
    await file.close();
  }
}

function appendBufferTail(current: Buffer, chunk: Buffer, maxBytes = CHILD_OUTPUT_TAIL_BYTES) {
  if (chunk.byteLength >= maxBytes) {
    return chunk.subarray(chunk.byteLength - maxBytes);
  }
  if (current.byteLength + chunk.byteLength <= maxBytes) {
    return current.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([current, chunk]);
  }
  const keepBytes = maxBytes - chunk.byteLength;
  return Buffer.concat([current.subarray(current.byteLength - keepBytes), chunk]);
}

async function drainNewMirrorData(
  mirrorPath: string,
  offset: number,
  onChunk: (chunk: Buffer) => void,
  maxChunkBytes = MIRROR_READ_CHUNK_BYTES,
) {
  let nextOffset = offset;
  for (;;) {
    const result = await readNewMirrorData(mirrorPath, nextOffset, maxChunkBytes);
    nextOffset = result.offset;
    if (result.chunk.byteLength === 0) {
      return nextOffset;
    }
    onChunk(result.chunk);
  }
}

async function main(): Promise<void> {
  const options = parseOptions();
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const useAltScreen = shouldUseAltScreen(options);
  await createMirrorFile(options.mirrorPath);

  const child = spawn(
    process.execPath,
    [
      "--no-maglev",
      resolveVitestCliEntry(),
      "run",
      "--config",
      "test/vitest/vitest.tui-pty.config.ts",
      ...MODE_TEST_FILES[options.mode],
      "--reporter=dot",
      ...options.vitestArgs,
    ],
    {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        OPENCLAW_TUI_PTY_MIRROR_PATH: options.mirrorPath,
        OPENCLAW_TUI_PTY_INCLUDE_LOCAL: options.mode === "fake" ? "0" : "1",
        OPENCLAW_TUI_PTY_COLS: currentTerminalDimension(process.stdout.columns, DEFAULT_PTY_COLS),
        OPENCLAW_TUI_PTY_ROWS: currentTerminalDimension(process.stdout.rows, DEFAULT_PTY_ROWS),
        OPENCLAW_TUI_PTY_TYPE_CHUNK_SIZE: process.env.OPENCLAW_TUI_PTY_TYPE_CHUNK_SIZE ?? "4",
        OPENCLAW_TUI_PTY_TYPE_DELAY_MS: process.env.OPENCLAW_TUI_PTY_TYPE_DELAY_MS ?? "25",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let childStdout: Buffer = Buffer.alloc(0);
  let childStderr: Buffer = Buffer.alloc(0);
  let restored = false;
  let mirrorOffset = 0;
  let mirrorFilterPending = "";
  let sawMirrorOutput = false;
  const startedAt = Date.now();

  const filterMirrorTerminalQueries = (chunk: Buffer) => {
    const input = mirrorFilterPending + chunk.toString("utf8");
    let output = "";
    mirrorFilterPending = "";
    for (let idx = 0; idx < input.length; idx += 1) {
      const rest = input.slice(idx);
      const fullMatch = MIRROR_TERMINAL_QUERIES.find((query) => rest.startsWith(query));
      if (fullMatch) {
        idx += fullMatch.length - 1;
        continue;
      }
      const partialMatch = MIRROR_TERMINAL_QUERIES.find((query) => query.startsWith(rest));
      if (partialMatch) {
        mirrorFilterPending = rest;
        break;
      }
      output += input[idx];
    }
    return output;
  };

  const writeMirrorChunk = (chunk: Buffer) => {
    const filteredChunk = filterMirrorTerminalQueries(chunk);
    if (filteredChunk.length === 0) {
      return;
    }
    if (!sawMirrorOutput && useAltScreen) {
      process.stdout.write("\x1b[2J\x1b[H");
    }
    sawMirrorOutput = true;
    process.stdout.write(filteredChunk);
  };

  const restoreScreen = () => {
    if (restored) {
      return;
    }
    restored = true;
    if (useAltScreen) {
      process.stdout.write("\x1b[?1049l");
    }
  };

  const childStopper = createChildStopper(child);
  const stopChild = childStopper.stop;

  const ignoredInput = (chunk: Buffer) => {
    if (chunk.includes(0x03)) {
      stopChild();
    }
  };
  const hadRawMode = process.stdin.isTTY && process.stdin.isRaw;
  if (useAltScreen && process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", ignoredInput);
  }

  const restoreInput = () => {
    if (!process.stdin.isTTY) {
      return;
    }
    process.stdin.off("data", ignoredInput);
    process.stdin.setRawMode(hadRawMode);
    if (!hadRawMode) {
      process.stdin.pause();
    }
  };

  const drainParentInput = async () => {
    if (!useAltScreen || !process.stdin.isTTY) {
      return;
    }
    await delay(100);
  };

  const renderWaitingStatus = () => {
    if (!useAltScreen || sawMirrorOutput) {
      return;
    }
    const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
    process.stdout.write(
      [
        "\x1b[2J\x1b[H",
        "openclaw TUI PTY tests",
        "",
        `Mode: ${options.mode}`,
        `Waiting for the first TUI frame... ${elapsedSeconds}s`,
        `Mirror: ${options.mirrorPath}`,
        "",
        "Vitest output is buffered and will print after the mirrored TUI run exits.",
      ].join("\n"),
    );
  };

  if (useAltScreen) {
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    renderWaitingStatus();
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    childStdout = appendBufferTail(childStdout, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    childStderr = appendBufferTail(childStderr, chunk);
  });

  type ChildExit = { code: number | null; signal: NodeJS.Signals | null };
  let childExit: ChildExit | null = null;
  const childFinished = new Promise<ChildExit>((resolve) => {
    child.once("exit", (code, signal) => {
      childExit = { code, signal };
      childStopper.cancel();
      resolve(childExit);
    });
  });

  const parentSignals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const signal of parentSignals) {
    process.once(signal, stopChild);
  }

  try {
    for (;;) {
      if (childExit) {
        break;
      }
      const result = await readNewMirrorData(options.mirrorPath, mirrorOffset);
      mirrorOffset = result.offset;
      if (result.chunk.byteLength > 0) {
        writeMirrorChunk(result.chunk);
      } else {
        renderWaitingStatus();
      }
      await delay(sawMirrorOutput ? 25 : 250);
    }

    mirrorOffset = await drainNewMirrorData(options.mirrorPath, mirrorOffset, writeMirrorChunk);
  } finally {
    if (!childExit) {
      stopChild();
    }
    for (const signal of parentSignals) {
      process.off(signal, stopChild);
    }
    await drainParentInput();
    restoreInput();
    if (useAltScreen) {
      process.stdout.write("\x1b[?2026l\x1b[?2004l\x1b[>4;0m\x1b[?25h");
    }
    restoreScreen();
  }

  if (!childExit) {
    childExit = await childFinished;
  }

  if (childStdout.byteLength > 0) {
    process.stdout.write(childStdout);
  }
  if (childStderr.byteLength > 0) {
    process.stderr.write(childStderr);
  }

  if (childExit.signal) {
    throw new Error(`TUI PTY tests exited with signal ${childExit.signal}`);
  }
  if (childExit.code !== 0) {
    process.exitCode = childExit.code ?? 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    if (error instanceof CliArgumentError) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(
      `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}

export const testing = {
  appendBufferTail,
  createChildStopper,
  drainNewMirrorData,
  parseOptions,
  readNewMirrorData,
  signalChildProcessTree,
  usage,
};
