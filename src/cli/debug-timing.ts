import { performance } from "node:perf_hooks";

const CLI_DEBUG_TIMING_ENV = "OPENCLAW_DEBUG_TIMING";

type TimingDetailValue = string | number | boolean | null | undefined;
type TimingDetails = Record<string, TimingDetailValue>;
type TimingMode = "off" | "pretty" | "json";

type TimingPayload = {
  command: string;
  phase: string;
  elapsedMs: number;
  deltaMs: number;
} & Record<string, string | number | boolean | null>;

type TimingWriter = (line: string) => void;
type NonPromise<T> = T extends PromiseLike<unknown> ? never : T;

export type CliDebugTiming = {
  enabled: boolean;
  mark: (phase: string, details?: TimingDetails) => void;
  time: <T>(
    phase: string,
    fn: () => NonPromise<T>,
    details?: TimingDetails | ((result: NonPromise<T>) => TimingDetails),
  ) => NonPromise<T>;
  timeAsync: <T>(
    phase: string,
    fn: () => Promise<T>,
    details?: TimingDetails | ((result: T) => TimingDetails),
  ) => Promise<T>;
};

function resolveCliDebugTimingMode(env: NodeJS.ProcessEnv = process.env): TimingMode {
  const raw = env[CLI_DEBUG_TIMING_ENV]?.trim().toLowerCase();
  if (raw === "1") {
    return "pretty";
  }
  if (raw === "json") {
    return "json";
  }
  return "off";
}

function normalizeDetailValue(value: TimingDetailValue): string | number | boolean | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  return value ?? null;
}

function appendDetails(payload: TimingPayload, details?: TimingDetails): TimingPayload {
  if (!details) {
    return payload;
  }
  for (const [key, value] of Object.entries(details)) {
    if (value === undefined) {
      continue;
    }
    payload[key] = normalizeDetailValue(value);
  }
  return payload;
}

function defaultTimingWriter(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "EPIPE" || code === "EIO") {
      return;
    }
    throw error;
  }
}

function resolveDetails<T>(
  details: TimingDetails | ((result: T) => TimingDetails) | undefined,
  result: T,
): TimingDetails | undefined {
  return typeof details === "function" ? details(result) : details;
}

function formatDuration(ms: number): string {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  return `${ms}ms`;
}

function formatPrettyDetailValue(value: string | number | boolean | null): string {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  return String(value);
}

function formatPrettyLabel(value: string): string {
  return JSON.stringify(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function formatPrettyTimingLine(payload: TimingPayload): string {
  const details = Object.entries(payload)
    .filter(
      ([key]) =>
        key !== "command" &&
        key !== "phase" &&
        key !== "elapsedMs" &&
        key !== "deltaMs" &&
        key !== "durationMs",
    )
    .map(([key, value]) => `${key}=${formatPrettyDetailValue(value)}`);
  const duration =
    typeof payload.durationMs === "number" ? ` duration=${formatDuration(payload.durationMs)}` : "";
  const suffix = details.length > 0 ? ` ${details.join(" ")}` : "";
  return `${formatDuration(payload.elapsedMs).padStart(8)} ${`+${formatDuration(payload.deltaMs)}`.padStart(8)} ${formatPrettyLabel(payload.phase)}${duration}${suffix}`;
}

export function createCliDebugTiming(params: {
  command: string;
  env?: NodeJS.ProcessEnv;
  writer?: TimingWriter;
}): CliDebugTiming {
  const mode = resolveCliDebugTimingMode(params.env);
  const enabled = mode !== "off";
  const writer = params.writer ?? defaultTimingWriter;
  const startedAt = performance.now();
  let lastAt = startedAt;
  let wrotePrettyHeader = false;

  const mark = (phase: string, details?: TimingDetails) => {
    if (!enabled) {
      return;
    }
    const now = performance.now();
    const payload = appendDetails(
      {
        command: params.command,
        phase,
        elapsedMs: Math.round(now - startedAt),
        deltaMs: Math.round(now - lastAt),
      },
      details,
    );
    lastAt = now;
    if (mode === "json") {
      writer(JSON.stringify(payload));
      return;
    }
    if (!wrotePrettyHeader) {
      writer(`OpenClaw CLI debug timing: ${formatPrettyLabel(params.command)}`);
      wrotePrettyHeader = true;
    }
    writer(formatPrettyTimingLine(payload));
  };

  return {
    enabled,
    mark,
    time<T>(
      phase: string,
      fn: () => NonPromise<T>,
      details?: TimingDetails | ((result: NonPromise<T>) => TimingDetails),
    ): NonPromise<T> {
      const started = enabled ? performance.now() : 0;
      try {
        const result = fn();
        if (isPromiseLike(result)) {
          void Promise.resolve(result).catch(() => undefined);
          throw new Error("CLI debug timing time() received a Promise; use timeAsync() instead.");
        }
        if (enabled) {
          mark(phase, {
            durationMs: Math.round(performance.now() - started),
            ...resolveDetails(details, result),
          });
        }
        return result;
      } catch (error) {
        if (enabled) {
          mark(phase, {
            durationMs: Math.round(performance.now() - started),
            error: true,
          });
        }
        throw error;
      }
    },
    async timeAsync<T>(
      phase: string,
      fn: () => Promise<T>,
      details?: TimingDetails | ((result: T) => TimingDetails),
    ): Promise<T> {
      const started = enabled ? performance.now() : 0;
      try {
        const result = await fn();
        if (enabled) {
          mark(phase, {
            durationMs: Math.round(performance.now() - started),
            ...resolveDetails(details, result),
          });
        }
        return result;
      } catch (error) {
        if (enabled) {
          mark(phase, {
            durationMs: Math.round(performance.now() - started),
            error: true,
          });
        }
        throw error;
      }
    },
  };
}

export function formatCliDebugTimingCommand(commandPath: readonly string[]): string {
  return commandPath.length > 0 ? commandPath.join(" ") : "root";
}
