// Re-exports terminal runtime helpers used by CLI command implementations.
import { clearActiveProgressLine } from "../packages/terminal-core/src/progress-line.js";
import { restoreTerminalState } from "../packages/terminal-core/src/restore.js";

export type RuntimeExitOptions = {
  /** Route ANSI terminal-reset bytes away from structured stdout when needed. */
  resetStream?: NodeJS.WriteStream;
};

export type RuntimeEnv = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  /**
   * Exit the process after restoring terminal state.
   * Pass `resetStream` to route the ANSI reset sequence to a specific
   * stream (e.g. stderr) when structured output on stdout must stay clean.
   */
  exit: (code: number, opts?: RuntimeExitOptions) => void;
};

export type OutputRuntimeEnv = RuntimeEnv & {
  writeStdout: (value: string) => void;
  writeJson: (value: unknown, space?: number) => void;
};

function shouldEmitRuntimeLog(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VITEST !== "true") {
    return true;
  }
  if (env.OPENCLAW_TEST_RUNTIME_LOG === "1") {
    return true;
  }
  const maybeMockedLog = console.log as unknown as { mock?: unknown };
  return typeof maybeMockedLog.mock === "object";
}

function shouldEmitRuntimeStdout(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.VITEST !== "true") {
    return true;
  }
  if (env.OPENCLAW_TEST_RUNTIME_LOG === "1") {
    return true;
  }
  const stdout = process.stdout as NodeJS.WriteStream & {
    write: {
      mock?: unknown;
    };
  };
  return typeof stdout.write.mock === "object";
}

function isPipeClosedError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "EPIPE" || code === "EIO";
}

function hasRuntimeOutputWriter(
  runtime: RuntimeEnv | OutputRuntimeEnv,
): runtime is OutputRuntimeEnv {
  return typeof (runtime as Partial<OutputRuntimeEnv>).writeStdout === "function";
}

function writeStdout(value: string): void {
  if (!shouldEmitRuntimeStdout()) {
    return;
  }
  clearActiveProgressLine();
  const line = value.endsWith("\n") ? value : `${value}\n`;
  try {
    process.stdout.write(line);
  } catch (err) {
    if (isPipeClosedError(err)) {
      return;
    }
    throw err;
  }
}

function createRuntimeIo(): Pick<OutputRuntimeEnv, "log" | "error" | "writeStdout" | "writeJson"> {
  return {
    log: (...args: Parameters<typeof console.log>) => {
      if (!shouldEmitRuntimeLog()) {
        return;
      }
      clearActiveProgressLine();
      console.log(...args);
    },
    error: (...args: Parameters<typeof console.error>) => {
      clearActiveProgressLine();
      console.error(...args);
    },
    writeStdout,
    writeJson: (value: unknown, space = 2) => {
      writeStdout(JSON.stringify(value, null, space > 0 ? space : undefined));
    },
  };
}

export const defaultRuntime: OutputRuntimeEnv = {
  ...createRuntimeIo(),
  exit: (code, opts) => {
    restoreTerminalState("runtime exit", {
      resumeStdinIfPaused: false,
      resetStream: opts?.resetStream,
    });
    process.exit(code);
    throw new Error("unreachable"); // satisfies tests when mocked
  },
};

/** Signals a deferred or non-exiting runtime exit so callers can unwind owned resources. */
export class ExitError extends Error {
  constructor(
    public readonly code: number,
    message?: string,
  ) {
    super(message ?? `exit ${code}`);
    this.name = "ExitError";
  }
}

export function createNonExitingRuntime(): OutputRuntimeEnv {
  return {
    ...createRuntimeIo(),
    exit: (code: number, _opts?: RuntimeExitOptions) => {
      throw new ExitError(code);
    },
  };
}

export function writeRuntimeJson(
  runtime: RuntimeEnv | OutputRuntimeEnv,
  value: unknown,
  space = 2,
): void {
  if (hasRuntimeOutputWriter(runtime)) {
    runtime.writeJson(value, space);
    return;
  }
  runtime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
}
