// Terminal progress reporter used by long-running CLI commands.
import { log, spinner, symbol } from "@clack/prompts";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { truncateToVisibleWidth, visibleWidth } from "../../packages/terminal-core/src/ansi.js";
import {
  createOscProgressController,
  supportsOscProgress,
} from "../../packages/terminal-core/src/osc-progress.js";
import {
  clearActiveProgressLine,
  registerActiveProgressLine,
  unregisterActiveProgressLine,
} from "../../packages/terminal-core/src/progress-line.js";
import { theme } from "../../packages/terminal-core/src/theme.js";

/** Keep animated labels inside Clack's captured erase width. */
export function createProgressSpinner(
  options: Parameters<typeof spinner>[0] & { output: NodeJS.WriteStream },
  decorationColumns: number,
) {
  const { output } = options;
  const readColumns = () =>
    Number.isFinite(output.columns) && output.columns > 0 ? Math.floor(output.columns) : undefined;
  let columns = readColumns();
  let label = "";
  let finished = false;
  const spin = spinner(options);
  const render = (message: string) => {
    label = message;
    const width = columns === undefined ? undefined : columns - decorationColumns;
    return theme.accent(
      width === undefined || visibleWidth(label) <= width
        ? label
        : width <= 0
          ? ""
          : `${truncateToVisibleWidth(label, width - 1)}…`,
    );
  };
  const resize = () => {
    const next = readColumns();
    if (columns === undefined || next === undefined || next >= columns) {
      return;
    }
    columns = next;
    if (columns <= decorationColumns) {
      spin.clear();
    } else {
      spin.message(render(label));
    }
  };
  return {
    start: (message: string) => {
      resize();
      if (columns === undefined || columns > decorationColumns) {
        if (columns !== undefined) {
          output.on("resize", resize);
        }
        spin.start(render(message));
      }
    },
    message: (message: string) => spin.message(render(message)),
    stop: (message?: string) => {
      if (finished) {
        return;
      }
      finished = true;
      output.off("resize", resize);
      spin.clear();
      if (message !== undefined) {
        log.message([`${symbol("submit")}  ${message}`], { output, spacing: 0, withGuide: false });
      }
    },
  };
}

const DEFAULT_DELAY_MS = 0;
// Only one active progress renderer may own the terminal line at a time.
let activeProgress = 0;

type ProgressOptions = {
  label: string;
  indeterminate?: boolean;
  total?: number;
  enabled?: boolean;
  delayMs?: number;
  stream?: NodeJS.WriteStream;
  fallback?: "spinner" | "line" | "log" | "none";
};

/** Minimal progress API exposed to CLI work callbacks. */
export type ProgressReporter = {
  setLabel: (label: string) => void;
  setPercent: (percent: number) => void;
  tick: (delta?: number) => void;
  done: () => void;
};

/** Completed/total progress update shape used by totals-based commands. */
export type ProgressTotalsUpdate = {
  completed: number;
  total: number;
  label?: string;
};

/** Decide whether the interactive spinner is safe for the current terminal state. */
export function shouldUseInteractiveProgressSpinner(params: {
  fallback?: ProgressOptions["fallback"];
  streamIsTty?: boolean;
  stdinIsRaw?: boolean;
}): boolean {
  const spinnerRequested = params.fallback === undefined || params.fallback === "spinner";
  return spinnerRequested && params.streamIsTty === true && params.stdinIsRaw !== true;
}

const noopReporter: ProgressReporter = {
  setLabel: () => {},
  setPercent: () => {},
  tick: () => {},
  done: () => {},
};

/** Create a no-op, spinner, line, log, and OSC-capable progress reporter. */
export function createCliProgress(options: ProgressOptions): ProgressReporter {
  if (options.enabled === false) {
    return noopReporter;
  }
  if (activeProgress > 0) {
    return noopReporter;
  }

  const stream = options.stream ?? process.stderr;
  const isTty = stream.isTTY;
  const allowLog = !isTty && options.fallback === "log";
  if (!isTty && !allowLog) {
    return noopReporter;
  }

  const delayMs = resolveTimerTimeoutMs(options.delayMs, DEFAULT_DELAY_MS, 0);
  const canOsc = isTty && supportsOscProgress(process.env, isTty);
  const stdinIsRaw = process.stdin.isRaw;
  const allowSpinner = shouldUseInteractiveProgressSpinner({
    fallback: options.fallback,
    streamIsTty: isTty,
    stdinIsRaw,
  });
  const allowLine = isTty && options.fallback === "line";
  if (isTty && stdinIsRaw && (options.fallback === undefined || options.fallback === "spinner")) {
    // Raw stdin usually means an interactive prompt owns cursor movement.
    return noopReporter;
  }

  let started = false;
  let finished = false;
  let label = options.label;
  const total = options.total ?? null;
  let completed = 0;
  let percent = 0;
  let indeterminate =
    options.indeterminate ?? (options.total === undefined || options.total === null);

  activeProgress += 1;
  if (isTty) {
    registerActiveProgressLine(stream);
  }

  const controller = canOsc
    ? createOscProgressController({
        env: process.env,
        isTty: stream.isTTY,
        write: (chunk: string) => stream.write(chunk),
      })
    : null;

  const spin = allowSpinner ? createProgressSpinner({ output: stream }, 7) : null;
  const renderLine = allowLine
    ? () => {
        if (!started) {
          return;
        }
        const suffix = indeterminate ? "" : ` ${percent}%`;
        clearActiveProgressLine();
        stream.write(`${theme.accent(label)}${suffix}`);
      }
    : null;
  const renderLog = allowLog
    ? (() => {
        let lastLine = "";
        let lastAt = 0;
        const throttleMs = 250;
        return () => {
          if (!started) {
            return;
          }
          const suffix = indeterminate ? "" : ` ${percent}%`;
          const nextLine = `${label}${suffix}`;
          const now = Date.now();
          if (nextLine === lastLine && now - lastAt < throttleMs) {
            return;
          }
          lastLine = nextLine;
          lastAt = now;
          stream.write(`${nextLine}\n`);
        };
      })()
    : null;
  let timer: NodeJS.Timeout | null = null;

  const applyState = () => {
    if (!started || finished) {
      return;
    }
    if (controller) {
      if (indeterminate) {
        controller.setIndeterminate(label);
      } else {
        controller.setPercent(label, percent);
      }
    }
    spin?.message(label);
    if (renderLine) {
      renderLine();
    }
    if (renderLog) {
      renderLog();
    }
  };

  const start = () => {
    if (started) {
      return;
    }
    started = true;
    spin?.start(label);
    applyState();
  };

  if (delayMs === 0) {
    start();
  } else {
    timer = setTimeout(start, delayMs);
  }

  const setLabel = (next: string) => {
    label = next;
    applyState();
  };

  const setPercent = (nextPercent: number) => {
    percent = Math.max(0, Math.min(100, Math.round(nextPercent)));
    indeterminate = false;
    applyState();
  };

  const tick = (delta = 1) => {
    if (!total) {
      return;
    }
    completed = Math.min(total, completed + delta);
    const nextPercent = total > 0 ? Math.round((completed / total) * 100) : 0;
    setPercent(nextPercent);
  };

  const done = () => {
    // A finally block may finish an already-stopped reporter; never clear a newer owner's line.
    if (finished) {
      return;
    }
    finished = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!started) {
      if (isTty) {
        unregisterActiveProgressLine(stream);
      }
      activeProgress = Math.max(0, activeProgress - 1);
      return;
    }
    if (controller) {
      controller.clear();
    }
    spin?.stop("");
    clearActiveProgressLine();
    if (isTty) {
      unregisterActiveProgressLine(stream);
    }
    activeProgress = Math.max(0, activeProgress - 1);
  };

  return { setLabel, setPercent, tick, done };
}

/** Run async work with a progress reporter that is always stopped in finally. */
export async function withProgress<T>(
  options: ProgressOptions,
  work: (progress: ProgressReporter) => Promise<T>,
): Promise<T> {
  const progress = createCliProgress(options);
  try {
    return await work(progress);
  } finally {
    progress.done();
  }
}

/** Run async work with a progress reporter plus a completed/total update adapter. */
export async function withProgressTotals<T>(
  options: ProgressOptions,
  work: (update: (update: ProgressTotalsUpdate) => void, progress: ProgressReporter) => Promise<T>,
): Promise<T> {
  return await withProgress(options, async (progress) => {
    const update = ({ completed, total, label }: ProgressTotalsUpdate) => {
      if (label) {
        progress.setLabel(label);
      }
      if (!Number.isFinite(total) || total <= 0) {
        return;
      }
      progress.setPercent((completed / total) * 100);
    };
    return await work(update, progress);
  });
}
