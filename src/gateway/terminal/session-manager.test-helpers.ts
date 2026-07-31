/** Shared fakes for terminal session-manager test files. */
import type { spawnTerminalPty } from "../../process/terminal-pty.js";
import type { TerminalSessionManager } from "./session-manager.js";

type TerminalOpenRequestInput = Parameters<TerminalSessionManager["open"]>[0];
type TerminalPtyHandle = Awaited<ReturnType<typeof spawnTerminalPty>>;

export type FakeTerminalPty = TerminalPtyHandle & {
  writes: string[];
  resizes: Array<[number, number]>;
  killed: boolean;
  paused: boolean;
  pauseCalls: number;
  resumeCalls: number;
  deliveredChunks: number;
  emitData: (chunk: string) => void;
  emitExit: (code: number, signal?: number) => void;
};

/** A controllable fake PTY that records writes and lets tests drive data/exit. */
export function makeFakePty(): FakeTerminalPty {
  let dataListener: ((chunk: string) => void) | undefined;
  let exitListener: ((event: { exitCode: number; signal?: number }) => void) | undefined;
  const handle: FakeTerminalPty = {
    pid: 4242,
    writes: [],
    resizes: [],
    killed: false,
    paused: false,
    pauseCalls: 0,
    resumeCalls: 0,
    deliveredChunks: 0,
    write: (data) => handle.writes.push(data),
    resize: (cols, rows) => handle.resizes.push([cols, rows]),
    pause: () => {
      handle.paused = true;
      handle.pauseCalls += 1;
    },
    resume: () => {
      handle.paused = false;
      handle.resumeCalls += 1;
    },
    onData: (listener) => {
      dataListener = listener;
    },
    onExit: (listener) => {
      exitListener = listener;
    },
    kill: () => {
      handle.killed = true;
    },
    emitData: (chunk) => {
      if (!handle.paused) {
        handle.deliveredChunks += 1;
        dataListener?.(chunk);
      }
    },
    emitExit: (code, signal) => exitListener?.({ exitCode: code, signal }),
  };
  return handle;
}

export function baseOpenRequest(
  overrides?: Partial<TerminalOpenRequestInput>,
): TerminalOpenRequestInput {
  return {
    owner: { kind: "conn", connId: "conn-1" },
    agentId: "main",
    cwd: "/work",
    shell: "/bin/zsh",
    args: ["-l"],
    cols: 80,
    rows: 24,
    env: { TERM: "xterm-256color" },
    ...overrides,
  };
}
