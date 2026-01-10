import { spinner } from "@clack/prompts";
import { createOscProgressController, supportsOscProgress } from "osc-progress";
import { theme } from "../terminal/theme.js";

const DEFAULT_DELAY_MS = 300;
let activeProgress = 0;

type ProgressOptions = {
  label: string;
  indeterminate?: boolean;
  total?: number;
  enabled?: boolean;
  delayMs?: number;
  stream?: NodeJS.WriteStream;
  fallback?: "spinner" | "none";
};

export type ProgressReporter = {
  setLabel: (label: string) => void;
  setPercent: (percent: number) => void;
  tick: (delta?: number) => void;
  done: () => void;
};

export type ProgressTotalsUpdate = {
  completed: number;
  total: number;
  label?: string;
};

const noopReporter: ProgressReporter = {
  setLabel: () => {},
  setPercent: () => {},
  tick: () => {},
  done: () => {},
};

export function createCliProgress(options: ProgressOptions): ProgressReporter {
  if (options.enabled === false) return noopReporter;
  if (activeProgress > 0) return noopReporter;

  const stream = options.stream ?? process.stderr;
  if (!stream.isTTY) return noopReporter;

  const delayMs =
    typeof options.delayMs === "number" ? options.delayMs : DEFAULT_DELAY_MS;
  const canOsc = supportsOscProgress(process.env, stream.isTTY);
  const allowSpinner =
    options.fallback === undefined || options.fallback === "spinner";

  let started = false;
  let label = options.label;
  const total = options.total ?? null;
  let completed = 0;
  let percent = 0;
  let indeterminate =
    options.indeterminate ??
    (options.total === undefined || options.total === null);

  activeProgress += 1;

  const controller = canOsc
    ? createOscProgressController({
        env: process.env,
        isTty: stream.isTTY,
        write: (chunk: string) => stream.write(chunk),
      })
    : null;

  const spin = allowSpinner ? spinner() : null;
  let timer: NodeJS.Timeout | null = null;

  const applyState = () => {
    if (!started) return;
    if (controller) {
      if (indeterminate) controller.setIndeterminate(label);
      else controller.setPercent(label, percent);
    }
    if (spin) {
      spin.message(theme.accent(label));
    }
  };

  const start = () => {
    if (started) return;
    started = true;
    if (spin) {
      spin.start(theme.accent(label));
    }
    applyState();
  };

  timer = setTimeout(start, delayMs);

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
    if (!total) return;
    completed = Math.min(total, completed + delta);
    const nextPercent = total > 0 ? Math.round((completed / total) * 100) : 0;
    setPercent(nextPercent);
  };

  const done = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!started) {
      activeProgress = Math.max(0, activeProgress - 1);
      return;
    }
    if (controller) controller.clear();
    if (spin) spin.stop();
    activeProgress = Math.max(0, activeProgress - 1);
  };

  return { setLabel, setPercent, tick, done };
}

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

export async function withProgressTotals<T>(
  options: ProgressOptions,
  work: (
    update: (update: ProgressTotalsUpdate) => void,
    progress: ProgressReporter,
  ) => Promise<T>,
): Promise<T> {
  return await withProgress(options, async (progress) => {
    const update = ({ completed, total, label }: ProgressTotalsUpdate) => {
      if (label) progress.setLabel(label);
      if (!Number.isFinite(total) || total <= 0) return;
      progress.setPercent((completed / total) * 100);
    };
    return await work(update, progress);
  });
}
