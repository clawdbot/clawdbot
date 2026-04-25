import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

const DEFAULT_MAX_CONCURRENT_FIRE_AND_FORGET_HOOKS = 16;
const DEFAULT_MAX_QUEUED_FIRE_AND_FORGET_HOOKS = 256;
const DEFAULT_FIRE_AND_FORGET_HOOK_TIMEOUT_MS = 2_000;
const MAX_HOOK_LOG_MESSAGE_LENGTH = 500;

type FireAndForgetHookJob = {
  task: () => Promise<unknown>;
  label: string;
  logger: (message: string) => void;
  timeoutMs: number;
};

type FireAndForgetHookState = {
  active: number;
  queue: FireAndForgetHookJob[];
};

export type FireAndForgetBoundedHookOptions = {
  maxConcurrency?: number;
  maxQueue?: number;
  timeoutMs?: number;
};

const getFireAndForgetHookState = () =>
  resolveGlobalSingleton<FireAndForgetHookState>(
    Symbol.for("openclaw.fireAndForgetHookState"),
    () => ({
      active: 0,
      queue: [],
    }),
  );

function positiveIntegerOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function replaceLogControlCharacters(value: string): string {
  let result = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (
      codePoint === undefined ||
      codePoint <= 0x1f ||
      codePoint === 0x7f ||
      codePoint === 0x2028 ||
      codePoint === 0x2029
    ) {
      result += " ";
      continue;
    }
    result += char;
  }
  return result;
}

export function formatHookErrorForLog(err: unknown): string {
  const formatted = replaceLogControlCharacters(formatErrorMessage(err))
    .replace(/\s+/g, " ")
    .trim();
  return (formatted || "unknown error").slice(0, MAX_HOOK_LOG_MESSAGE_LENGTH);
}

export function fireAndForgetHook(
  task: Promise<unknown>,
  label: string,
  logger: (message: string) => void = logVerbose,
): void {
  void task.catch((err) => {
    logger(`${label}: ${formatHookErrorForLog(err)}`);
  });
}

function runFireAndForgetHookJob(
  state: FireAndForgetHookState,
  job: FireAndForgetHookJob,
  limits: { maxConcurrency: number },
): void {
  state.active += 1;
  let didLogTimeout = false;
  const timeout =
    job.timeoutMs > 0
      ? setTimeout(() => {
          didLogTimeout = true;
          job.logger(`${job.label}: timed out after ${job.timeoutMs}ms`);
        }, job.timeoutMs)
      : undefined;

  void Promise.resolve()
    .then(job.task)
    .catch((err) => {
      if (!didLogTimeout) {
        job.logger(`${job.label}: ${formatHookErrorForLog(err)}`);
      }
    })
    .finally(() => {
      if (timeout) {
        clearTimeout(timeout);
      }
      state.active -= 1;
      drainFireAndForgetHookQueue(state, limits);
    });
}

function drainFireAndForgetHookQueue(
  state: FireAndForgetHookState,
  limits: { maxConcurrency: number },
): void {
  while (state.active < limits.maxConcurrency) {
    const next = state.queue.shift();
    if (!next) {
      return;
    }
    runFireAndForgetHookJob(state, next, limits);
  }
}

export function fireAndForgetBoundedHook(
  task: () => Promise<unknown>,
  label: string,
  logger: (message: string) => void = logVerbose,
  options: FireAndForgetBoundedHookOptions = {},
): void {
  const state = getFireAndForgetHookState();
  const maxConcurrency = positiveIntegerOrDefault(
    options.maxConcurrency,
    DEFAULT_MAX_CONCURRENT_FIRE_AND_FORGET_HOOKS,
  );
  const maxQueue = positiveIntegerOrDefault(
    options.maxQueue,
    DEFAULT_MAX_QUEUED_FIRE_AND_FORGET_HOOKS,
  );
  const timeoutMs = positiveIntegerOrDefault(
    options.timeoutMs,
    DEFAULT_FIRE_AND_FORGET_HOOK_TIMEOUT_MS,
  );

  if (state.active >= maxConcurrency && state.queue.length >= maxQueue) {
    logger(`${label}: queue full; dropping hook`);
    return;
  }

  state.queue.push({ task, label, logger, timeoutMs });
  drainFireAndForgetHookQueue(state, { maxConcurrency });
}
