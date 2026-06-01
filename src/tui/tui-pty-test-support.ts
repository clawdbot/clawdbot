import { appendFileSync } from "node:fs";
import * as nodePty from "@lydell/node-pty";
import type { PtyExitEvent, PtyHandle } from "@lydell/node-pty";

type NodePtyRuntimeModule = typeof nodePty & {
  default?: Partial<typeof nodePty>;
};

type KillablePtyHandle = PtyHandle & {
  kill?: (signal?: string) => void;
};

export type PtyRun = {
  output: () => string;
  write: (data: string, opts?: { delay?: boolean }) => Promise<void>;
  waitForOutput: (needle: string, timeoutMs?: number) => Promise<string>;
  waitForExit: (timeoutMs?: number) => Promise<PtyExitEvent>;
  dispose: () => void;
};

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
        reject(toLintErrorObject(error, "Non-Error rejection"));
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

export function sleep(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function resolveSpawnPty() {
  const runtime = nodePty as NodePtyRuntimeModule;
  if (typeof runtime.spawn === "function") {
    return runtime.spawn;
  }
  if (typeof runtime.default?.spawn === "function") {
    return runtime.default.spawn;
  }
  throw new TypeError("@lydell/node-pty spawn export is unavailable");
}

const spawnPty = resolveSpawnPty();

function readPositiveIntegerEnv(name: string): number | null {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function readPtyDimensionEnv(name: string, fallback: number): number {
  return readPositiveIntegerEnv(name) ?? fallback;
}

async function writePtyInput(
  pty: PtyHandle,
  data: string,
  opts: { delay?: boolean } = {},
): Promise<void> {
  const delayMs = readPositiveIntegerEnv("OPENCLAW_TUI_PTY_TYPE_DELAY_MS");
  if (!delayMs || opts.delay === false) {
    pty.write(data);
    return;
  }
  const chunkSize = readPositiveIntegerEnv("OPENCLAW_TUI_PTY_TYPE_CHUNK_SIZE") ?? 1;
  for (let idx = 0; idx < data.length; idx += chunkSize) {
    pty.write(data.slice(idx, idx + chunkSize));
    if (idx + chunkSize < data.length) {
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
  let exitEvent: PtyExitEvent | null = null;
  const pty = spawnPty(command, args, {
    name: "xterm-256color",
    cols: readPtyDimensionEnv("OPENCLAW_TUI_PTY_COLS", 100),
    rows: readPtyDimensionEnv("OPENCLAW_TUI_PTY_ROWS", 30),
    cwd: opts.cwd,
    env: {
      ...process.env,
      ...opts.env,
      TERM: "xterm-256color",
    } as Record<string, string>,
  }) as KillablePtyHandle;

  pty.onData((data) => {
    output += data;
    mirrorPtyOutput(data);
  });
  pty.onExit((event) => {
    exitEvent = event;
  });

  const run: PtyRun = {
    output: () => output,
    write: async (data, writeOpts) => await writePtyInput(pty, data, writeOpts),
    waitForOutput: async (needle, timeoutMs = opts.outputTimeoutMs) =>
      await waitFor({
        timeoutMs,
        read: () => {
          if (output.includes(needle)) {
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
      }),
    waitForExit: async (timeoutMs = opts.exitTimeoutMs) =>
      await waitFor({
        timeoutMs,
        read: () => exitEvent,
        onTimeout: () => new Error(`timed out waiting for PTY exit\n${output}`),
      }),
    dispose: () => {
      if (!exitEvent) {
        pty.kill?.("SIGTERM");
      }
    },
  };
  opts.activeRuns?.push(run);
  return run;
}

function toLintErrorObject(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) {
    return value;
  }
  if (typeof value === "string") {
    return new Error(value);
  }
  const error = new Error(fallbackMessage, { cause: value });
  if ((typeof value === "object" && value !== null) || typeof value === "function") {
    Object.assign(error, value);
  }
  return error;
}
