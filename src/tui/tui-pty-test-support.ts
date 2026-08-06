// Provides PTY harness helpers for TUI end-to-end tests.
import { appendFileSync } from "node:fs";
import * as nodePty from "@lydell/node-pty";
import type { IPty } from "@lydell/node-pty";
import { AnsiSequenceStripper } from "../../packages/terminal-core/src/ansi-sequences.js";
import * as ansi from "../../packages/terminal-core/src/ansi.js";
import { toErrorObject } from "../infra/errors.js";
import { signalProcessTree } from "../process/kill-tree.js";

// Shared PTY harness utilities for fake-backend and local TUI smoke tests.
type PtyExitEvent = Parameters<Parameters<IPty["onExit"]>[0]>[0];

/** Handle returned by PTY tests for input, output waits, and cleanup. */
export type PtyRun = {
  cols: number;
  output: () => string;
  rows: number;
  visibleOutput: () => string;
  write: (data: string, opts?: { delay?: boolean }) => Promise<void>;
  waitForOutput: (needle: string, timeoutMs?: number) => Promise<string>;
  waitForExit: (timeoutMs?: number) => Promise<PtyExitEvent>;
  /** Ends behavior-complete PTY scenarios without exercising graceful TUI shutdown. */
  forceKill: () => Promise<void>;
  dispose: () => Promise<void>;
};

export type PtyTerminalDimensions = Pick<PtyRun, "cols" | "rows">;
type PtyTestCell = { authenticated: boolean; text: string };

const MAX_TEST_TERMINAL_DIMENSION = 1_000;

/** Minimal bounded terminal state used only to authenticate PTY test evidence. */
export class PtyTestScreen {
  readonly cells: PtyTestCell[][];
  readonly cols: number;
  readonly rows: number;
  col = 0;
  row = 0;
  private wrapPending = false;

  constructor(dimensions: PtyTerminalDimensions) {
    const { cols, rows } = dimensions;
    const valid = [cols, rows].every(
      (value) => Number.isSafeInteger(value) && value > 0 && value <= MAX_TEST_TERMINAL_DIMENSION,
    );
    if (!valid) {
      throw new Error(`unsupported TUI PTY dimensions: ${cols}x${rows}`);
    }
    this.cols = cols;
    this.rows = rows;
    this.cells = Array.from({ length: rows }, () => this.blankRow());
  }

  write(text: string, authenticated: boolean) {
    for (const part of text.split(/([\b\r\n\t])/u)) {
      if (part === "\r") {
        this.col = 0;
        this.wrapPending = false;
      } else if (part === "\n") {
        this.lineFeed(authenticated, false);
      } else if (part === "\t") {
        this.col = Math.min(this.cols - 1, Math.floor(this.col / 8 + 1) * 8);
        this.wrapPending = false;
      } else if (part === "\b") {
        this.col = Math.max(0, this.col - 1);
        this.wrapPending = false;
      } else {
        this.writeGraphemes(part, authenticated);
      }
    }
  }

  applyCsi(value: string, authenticated: boolean) {
    const final = value.at(-1) ?? "";
    const param = value.slice(2, -1);
    const count = Number(param || "1");
    if (final === "A") {
      this.row = Math.max(0, this.row - count);
    } else if (final === "B") {
      this.row = Math.min(this.rows - 1, this.row + count);
    } else if (final === "G") {
      this.col = Math.min(this.cols - 1, count - 1);
    } else if (value === "\x1b[H") {
      this.row = 0;
      this.col = 0;
    } else if (final === "J") {
      const mode = Number(param || "0");
      if (mode === 0) {
        this.clearFrom(this.row, this.col, authenticated);
      } else if (mode === 2) {
        this.clearFrom(0, 0, authenticated);
      }
    } else if (final === "K") {
      const mode = Number(param || "0");
      if (mode === 0) {
        this.clearRow(this.row, this.col, authenticated);
      } else if (mode === 2) {
        this.clearRow(this.row, 0, authenticated);
      }
    }
    if (/[ABGHK]$/u.test(value) || (final === "J" && param !== "3")) {
      this.wrapPending = false;
    }
  }

  private blankRow(authenticated = false): PtyTestCell[] {
    return Array.from({ length: this.cols }, () => ({ authenticated, text: " " }));
  }

  private rowCells(row = this.row) {
    const cells = this.cells[row];
    if (!cells) {
      throw new Error(`terminal row outside viewport: ${row}`);
    }
    return cells;
  }

  private clearCell(cells: PtyTestCell[], col: number, authenticated: boolean) {
    let lead = col;
    while (lead > 0 && cells[lead]?.text === "") {
      lead -= 1;
    }
    const width = Math.max(1, ansi.visibleWidth(cells[lead]?.text ?? ""));
    for (let index = lead; index < Math.min(cells.length, lead + width); index += 1) {
      cells[index] = { authenticated, text: " " };
    }
  }

  private clearRow(row: number, col: number, authenticated: boolean) {
    const cells = this.rowCells(row);
    let start = Math.min(col, this.cols - 1);
    while (start > 0 && cells[start]?.text === "") {
      start -= 1;
    }
    for (let index = start; index < this.cols; index += 1) {
      cells[index] = { authenticated, text: " " };
    }
  }

  private clearFrom(row: number, col: number, authenticated: boolean) {
    for (let index = row; index < this.rows; index += 1) {
      this.clearRow(index, index === row ? col : 0, authenticated);
    }
  }

  private lineFeed(authenticated: boolean, carriageReturn: boolean) {
    if (this.row === this.rows - 1) {
      this.cells.shift();
      this.cells.push(this.blankRow(authenticated));
    } else {
      this.row += 1;
    }
    if (carriageReturn) {
      this.col = 0;
    }
    this.wrapPending = false;
  }

  private writeGraphemes(text: string, authenticated: boolean) {
    for (const grapheme of ansi.splitGraphemes(text)) {
      if (ansi.sanitizeForLog(grapheme) !== grapheme) {
        throw new Error("unsupported terminal control in TUI PTY evidence");
      }
      if (/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(grapheme)) {
        continue;
      }
      const width = ansi.visibleWidth(grapheme);
      if (width === 0) {
        continue;
      }
      if (width > this.cols) {
        throw new Error("grapheme exceeds TUI PTY width");
      }
      if (this.wrapPending || this.col + width > this.cols) {
        this.lineFeed(authenticated, true);
      }
      const cells = this.rowCells();
      for (let col = this.col; col < this.col + width; col += 1) {
        this.clearCell(cells, col, authenticated);
      }
      cells[this.col] = { authenticated, text: grapheme };
      for (let col = this.col + 1; col < this.col + width; col += 1) {
        cells[col] = { authenticated, text: "" };
      }
      if (this.col + width === this.cols) {
        this.col = this.cols - 1;
        this.wrapPending = true;
      } else {
        this.col += width;
      }
    }
  }
}

const PTY_EXIT_SETTLE_MS = 25;

/** Polls until a reader returns a value or the timeout expires. */
export function waitFor<T>(params: {
  timeoutMs: number;
  read: () => T | null;
  onTimeout: () => Error;
}): Promise<T> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      let result: T | null;
      try {
        result = params.read();
      } catch (error) {
        reject(toErrorObject(error, "Non-Error rejection"));
        return;
      }
      if (result !== null) {
        resolve(result);
        return;
      }
      if (Date.now() - start >= params.timeoutMs) {
        reject(params.onTimeout());
        return;
      }
      setTimeout(tick, 25);
    };
    tick();
  });
}

/** Async sleep used to simulate slower PTY typing. */
export function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readPositiveIntegerEnv(name: string, env: NodeJS.ProcessEnv = process.env): number | null {
  const value = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readPtyDimensionEnv(name: string, fallback: number, env: NodeJS.ProcessEnv): number {
  return readPositiveIntegerEnv(name, env) ?? fallback;
}

async function writePtyInput(
  pty: IPty,
  data: string,
  env: NodeJS.ProcessEnv,
  opts: { delay?: boolean } = {},
): Promise<void> {
  const delayMs = readPositiveIntegerEnv("OPENCLAW_TUI_PTY_TYPE_DELAY_MS", env);
  if (!delayMs || opts.delay === false) {
    pty.write(data);
    return;
  }
  const chunkSize = readPositiveIntegerEnv("OPENCLAW_TUI_PTY_TYPE_CHUNK_SIZE", env) ?? 1;
  // Chunk by Unicode characters so stress typing never sends half of a surrogate pair.
  const characters = Array.from(data);
  for (let idx = 0; idx < characters.length; idx += chunkSize) {
    pty.write(characters.slice(idx, idx + chunkSize).join(""));
    if (idx + chunkSize < characters.length) {
      await sleep(delayMs);
    }
  }
}

function mirrorPtyOutput(data: string) {
  const mirrorPath = process.env.OPENCLAW_TUI_PTY_MIRROR_PATH;
  if (!mirrorPath) {
    return;
  }
  appendFileSync(mirrorPath, data, "utf8");
}

/** Starts a PTY process and exposes deterministic output/exit wait helpers. */
export function startPty(
  command: string,
  args: string[],
  opts: {
    activeRuns?: PtyRun[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    exitTimeoutMs: number;
    outputTimeoutMs: number;
  },
) {
  let output = "";
  let visibleOutput = "";
  let exitEvent: PtyExitEvent | null = null;
  const ansiStripper = new AnsiSequenceStripper();
  const mergedEnv = {
    ...process.env,
    ...opts.env,
    TERM: "xterm-256color",
  };
  const ptyEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(mergedEnv)) {
    if (value !== undefined) {
      ptyEnv[key] = value;
    }
  }
  const cols = readPtyDimensionEnv("OPENCLAW_TUI_PTY_COLS", 100, ptyEnv);
  const rows = readPtyDimensionEnv("OPENCLAW_TUI_PTY_ROWS", 30, ptyEnv);
  const pty = nodePty.spawn(command, args, {
    name: "xterm-256color",
    cols,
    rows,
    cwd: opts.cwd,
    env: ptyEnv,
  });

  const dataSubscription = pty.onData((data) => {
    output += data;
    // PTY line wrapping and ANSI chunks must not hide visible text from behavior checks.
    const visibleChunk = ansiStripper.write(data).replace(/\s+/gu, " ");
    visibleOutput +=
      visibleOutput.endsWith(" ") && visibleChunk.startsWith(" ")
        ? visibleChunk.slice(1)
        : visibleChunk;
    mirrorPtyOutput(data);
  });
  const exitSubscription = pty.onExit((event) => {
    exitEvent = event;
  });

  const waitForExit = async (timeoutMs = opts.exitTimeoutMs) =>
    await waitFor({
      timeoutMs,
      read: () => exitEvent,
      onTimeout: () => new Error(`timed out waiting for PTY exit\n${output}`),
    });

  const waitForVisibleOutput = async (needle: string, timeoutMs: number) => {
    const normalizedNeedle = needle.replace(/\s+/gu, " ");
    return await waitFor({
      timeoutMs,
      read: () => {
        const matchIndex = visibleOutput.indexOf(normalizedNeedle);
        if (matchIndex >= 0) {
          return output;
        }
        if (exitEvent) {
          throw new Error(
            `PTY exited before ${JSON.stringify(needle)}\nexit=${JSON.stringify(exitEvent)}\n${output}`,
          );
        }
        return null;
      },
      onTimeout: () => new Error(`timed out waiting for ${JSON.stringify(needle)}\n${output}`),
    });
  };

  let forceKillPromise: Promise<void> | undefined;
  let disposePromise: Promise<void> | undefined;
  let subscriptionsDisposed = false;

  const disposeSubscriptions = () => {
    if (subscriptionsDisposed) {
      return;
    }
    subscriptionsDisposed = true;
    dataSubscription.dispose();
    exitSubscription.dispose();
  };

  const forceKillPty = async () => {
    if (!exitEvent) {
      // The PTY owns a process group; killing only its shell can leave the TUI child alive.
      await new Promise<void>((resolve) => {
        signalProcessTree(pty.pid, "SIGKILL", { onComplete: resolve });
      });
      // Native PTY backends do not consistently emit onExit after a forced tree kill.
      await sleep(PTY_EXIT_SETTLE_MS);
      exitEvent ??= { exitCode: 137, signal: 9 };
    }
  };

  const run: PtyRun = {
    cols,
    output: () => output,
    rows,
    visibleOutput: () => visibleOutput,
    write: async (data, writeOpts) => await writePtyInput(pty, data, ptyEnv, writeOpts),
    waitForOutput: async (needle, timeoutMs = opts.outputTimeoutMs) =>
      await waitForVisibleOutput(needle, timeoutMs),
    waitForExit,
    forceKill: () => {
      forceKillPromise ??= (async () => {
        try {
          await forceKillPty();
        } finally {
          disposeSubscriptions();
        }
      })();
      return forceKillPromise;
    },
    dispose: () => {
      if (forceKillPromise) {
        return forceKillPromise;
      }
      disposePromise ??= (async () => {
        try {
          if (!exitEvent) {
            try {
              pty.kill("SIGTERM");
              await waitForExit();
            } catch {
              // Failure cleanup must not strand the PTY tree or replace the primary test error.
              await forceKillPty();
            }
          }
          // node-pty releases its native exit callback after onExit returns.
          // Give that release a turn before Vitest tears down the worker.
          await sleep(PTY_EXIT_SETTLE_MS);
        } finally {
          disposeSubscriptions();
        }
      })();
      return disposePromise;
    },
  };
  opts.activeRuns?.push(run);
  return run;
}
