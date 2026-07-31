import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";

type CodexThreadLifecycleTimingSpan = {
  name: string;
  durationMs: number;
  elapsedMs: number;
};

type CodexThreadLifecycleTimingSummary = {
  totalMs: number;
  spans: CodexThreadLifecycleTimingSpan[];
};

type CodexThreadLifecycleTimingLogger = {
  isEnabled?: (level: "trace") => boolean;
  trace: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

type CodexThreadLifecycleTimingAction = "started" | "resumed" | "forked" | "rotated";

export type CodexThreadLifecycleTimingOptions = {
  enabled?: boolean;
  now?: () => number;
  log?: CodexThreadLifecycleTimingLogger;
  totalThresholdMs?: number;
  stageThresholdMs?: number;
};

export type CodexThreadLifecycleTimingTracker = {
  measure: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
  measureSync: <T>(name: string, run: () => T) => T;
  mark: (name: string) => void;
  logSummary: (params: {
    runId: string;
    sessionId: string;
    sessionKey?: string;
    action: CodexThreadLifecycleTimingAction;
    threadId?: string;
  }) => void;
};

const CODEX_THREAD_LIFECYCLE_TIMING_WARN_TOTAL_MS = 1_000;
const CODEX_THREAD_LIFECYCLE_TIMING_WARN_STAGE_MS = 500;

function shouldWarnCodexThreadLifecycleTimingSummary(
  summary: CodexThreadLifecycleTimingSummary,
  options: CodexThreadLifecycleTimingOptions = {},
): boolean {
  const totalThresholdMs = options.totalThresholdMs ?? CODEX_THREAD_LIFECYCLE_TIMING_WARN_TOTAL_MS;
  const stageThresholdMs = options.stageThresholdMs ?? CODEX_THREAD_LIFECYCLE_TIMING_WARN_STAGE_MS;
  return (
    summary.totalMs >= totalThresholdMs ||
    summary.spans.some((span) => span.durationMs >= stageThresholdMs)
  );
}

function formatCodexThreadLifecycleTimingSummary(params: {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  action: CodexThreadLifecycleTimingAction;
  summary: CodexThreadLifecycleTimingSummary;
}): string {
  const spans =
    params.summary.spans.length > 0
      ? params.summary.spans
          .map((span) => `${span.name}:${span.durationMs}ms@${span.elapsedMs}ms`)
          .join(",")
      : "none";
  return (
    `[trace:codex-app-server] thread lifecycle: runId=${params.runId} ` +
    `sessionId=${params.sessionId} sessionKey=${params.sessionKey ?? "unknown"} ` +
    `action=${params.action} totalMs=${params.summary.totalMs} stages=${spans}`
  );
}

export function createCodexThreadLifecycleTimingTracker(
  options: CodexThreadLifecycleTimingOptions = {},
): CodexThreadLifecycleTimingTracker {
  const log = options.log ?? embeddedAgentLog;
  if (!options.enabled && log.isEnabled?.("trace") !== true) {
    return {
      async measure(_name, run) {
        return await run();
      },
      measureSync(_name, run) {
        return run();
      },
      mark() {},
      logSummary() {},
    };
  }

  const now = options.now ?? Date.now;
  const startedAt = now();
  let didLog = false;
  const spans: CodexThreadLifecycleTimingSpan[] = [];
  const toMs = (value: number) => Math.max(0, Math.round(value));
  const record = (name: string, spanStartedAt: number) => {
    const currentAt = now();
    spans.push({
      name,
      durationMs: toMs(currentAt - spanStartedAt),
      elapsedMs: toMs(currentAt - startedAt),
    });
  };
  const snapshot = (): CodexThreadLifecycleTimingSummary => ({
    totalMs: toMs(now() - startedAt),
    spans: spans.slice(),
  });
  return {
    async measure(name, run) {
      const spanStartedAt = now();
      try {
        return await run();
      } finally {
        record(name, spanStartedAt);
      }
    },
    measureSync(name, run) {
      const spanStartedAt = now();
      try {
        return run();
      } finally {
        record(name, spanStartedAt);
      }
    },
    mark(name) {
      record(name, now());
    },
    logSummary(params) {
      if (didLog) {
        return;
      }
      const summary = snapshot();
      const shouldWarn = shouldWarnCodexThreadLifecycleTimingSummary(summary, options);
      if (!shouldWarn && !log.isEnabled?.("trace")) {
        return;
      }
      didLog = true;
      const message = formatCodexThreadLifecycleTimingSummary({
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        action: params.action,
        summary,
      });
      const meta = {
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        action: params.action,
        threadId: params.threadId,
        totalMs: summary.totalMs,
        spans: summary.spans,
      };
      if (shouldWarn) {
        log.warn(message, meta);
      } else {
        log.trace(message, meta);
      }
    },
  };
}
