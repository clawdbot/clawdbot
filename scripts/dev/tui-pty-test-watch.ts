import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

type Options = {
  altScreen: boolean;
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

type KillableChild = {
  pid?: number;
  kill(signal: NodeJS.Signals): boolean;
};

type ChildStopper = {
  cancel: () => void;
  stop: () => void;
};

type SignalChild = (child: KillableChild, signal: NodeJS.Signals) => void;

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  (timer as { unref?: () => void }).unref?.();
}

function readOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) {
    return undefined;
  }
  return args[idx + 1]?.trim() || undefined;
}

function readMode(args: string[]): Options["mode"] {
  const mode = readOption(args, "--mode") ?? "fake";
  if (mode === "fake" || mode === "local" || mode === "all") {
    return mode;
  }
  throw new Error(`--mode must be fake, local, or all; got ${JSON.stringify(mode)}`);
}

function parseOptions(args = process.argv.slice(2)): Options {
  const separator = args.indexOf("--");
  const ownArgs = separator >= 0 ? args.slice(0, separator) : args;
  const vitestArgs = separator >= 0 ? args.slice(separator + 1) : [];
  const mirrorPath =
    readOption(ownArgs, "--mirror-path") !== undefined
      ? path.resolve(readOption(ownArgs, "--mirror-path") ?? "")
      : DEFAULT_MIRROR_PATH;
  return {
    altScreen: !ownArgs.includes("--no-alt-screen"),
    mirrorPath,
    mode: readMode(ownArgs),
    vitestArgs,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

function signalChildProcessTree(child: KillableChild, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Non-detached fallback or already-exited group; direct child signaling is
      // still useful on platforms without process groups.
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

async function readNewMirrorData(mirrorPath: string, offset: number) {
  const data = await readFile(mirrorPath);
  const nextOffset = data.byteLength;
  if (nextOffset < offset) {
    return { chunk: data, offset: nextOffset };
  }
  if (nextOffset === offset) {
    return { chunk: Buffer.alloc(0), offset };
  }
  return { chunk: data.subarray(offset), offset: nextOffset };
}

async function main(): Promise<void> {
  const options = parseOptions();
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

  let childStdout = "";
  let childStderr = "";
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
    childStdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    childStderr += chunk.toString("utf8");
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

    const result = await readNewMirrorData(options.mirrorPath, mirrorOffset);
    if (result.chunk.byteLength > 0) {
      writeMirrorChunk(result.chunk);
    }
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

  if (childStdout) {
    process.stdout.write(childStdout);
  }
  if (childStderr) {
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
    process.stderr.write(
      `${error instanceof Error ? error.stack || error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}

export const testing = {
  createChildStopper,
  signalChildProcessTree,
};
