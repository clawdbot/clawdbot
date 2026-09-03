// Telegram plugin module implements polling liveness behavior.
import { formatDurationPrecise } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";

type TelegramPollingLivenessTrackerOptions = {
  now?: () => number;
  monotonicNow?: () => number;
  onPollSuccess?: (finishedAt: number) => void;
};

type TelegramPollingStall = {
  message: string;
};

export class TelegramPollingLivenessTracker {
  #lastGetUpdatesActivityMonotonicAt: number;
  #lastGetUpdatesStartedAt: number | null = null;
  #lastGetUpdatesStartedMonotonicAt: number | null = null;
  #lastGetUpdatesFinishedAt: number | null = null;
  #lastGetUpdatesDurationMs: number | null = null;
  #lastGetUpdatesOutcome = "not-started";
  #lastGetUpdatesError: string | null = null;
  #lastGetUpdatesOffset: number | null = null;
  #inFlightGetUpdates = 0;
  #stallDiagLoggedMonotonicAt = 0;
  #lastStallCheckMonotonicAt: number;
  #retryAfterUntilMonotonicAt: number | null = null;

  constructor(private readonly options: TelegramPollingLivenessTrackerOptions = {}) {
    const monotonicNow = this.#monotonicNow();
    this.#lastGetUpdatesActivityMonotonicAt = monotonicNow;
    this.#lastStallCheckMonotonicAt = monotonicNow;
  }

  get inFlightGetUpdates() {
    return this.#inFlightGetUpdates;
  }

  noteGetUpdatesStarted(payload: unknown, at = this.#now()) {
    const startedMonotonicAt = this.#monotonicNow();
    this.#retryAfterUntilMonotonicAt = null;
    this.#lastGetUpdatesActivityMonotonicAt = startedMonotonicAt;
    this.#lastGetUpdatesStartedAt = at;
    this.#lastGetUpdatesStartedMonotonicAt = startedMonotonicAt;
    this.#lastGetUpdatesFinishedAt = null;
    this.#lastGetUpdatesDurationMs = null;
    this.#lastGetUpdatesOffset = resolveGetUpdatesOffset(payload);
    this.#inFlightGetUpdates += 1;
    this.#lastGetUpdatesOutcome = "started";
    this.#lastGetUpdatesError = null;
  }

  noteGetUpdatesSuccess(result: unknown, at = this.#now()) {
    this.#noteGetUpdatesCompleted(at);
    this.#lastGetUpdatesOutcome = Array.isArray(result) ? `ok:${result.length}` : "ok";
    this.options.onPollSuccess?.(at);
  }

  noteGetUpdatesSuccessCount(count: number, at = this.#now()) {
    this.#noteGetUpdatesCompleted(at);
    const normalizedCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    this.#lastGetUpdatesOutcome = `ok:${normalizedCount}`;
    this.options.onPollSuccess?.(at);
  }

  noteGetUpdatesError(err: unknown, at = this.#now(), retryAfterMs?: number) {
    this.#noteGetUpdatesCompleted(at);
    if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      this.#retryAfterUntilMonotonicAt = this.#monotonicNow() + retryAfterMs;
    }
    this.#lastGetUpdatesOutcome = "error";
    this.#lastGetUpdatesError = formatErrorMessage(err);
  }

  noteGetUpdatesFinished() {
    this.#inFlightGetUpdates = Math.max(0, this.#inFlightGetUpdates - 1);
  }

  noteGetUpdatesActivity() {
    this.#lastGetUpdatesActivityMonotonicAt = this.#monotonicNow();
  }

  detectStall(params: { thresholdMs: number }): TelegramPollingStall | null {
    const monotonicNow = this.#monotonicNow();
    const checkGap = monotonicNow - this.#lastStallCheckMonotonicAt;
    this.#lastStallCheckMonotonicAt = monotonicNow;
    // The watchdog cannot distinguish a stalled poll from delayed callbacks after
    // missing two full detection windows. Rebase once, then observe normally.
    if (checkGap > params.thresholdMs * 2) {
      this.#lastGetUpdatesActivityMonotonicAt = monotonicNow;
      return null;
    }
    // Flood waits excuse an idle worker, never a newly stuck in-flight poll.
    if (
      this.#inFlightGetUpdates === 0 &&
      this.#retryAfterUntilMonotonicAt !== null &&
      monotonicNow <= this.#retryAfterUntilMonotonicAt
    ) {
      return null;
    }
    const elapsed = monotonicNow - this.#lastGetUpdatesActivityMonotonicAt;
    if (elapsed <= params.thresholdMs) {
      return null;
    }
    if (
      this.#stallDiagLoggedMonotonicAt &&
      monotonicNow - this.#stallDiagLoggedMonotonicAt < params.thresholdMs / 2
    ) {
      return null;
    }
    this.#stallDiagLoggedMonotonicAt = monotonicNow;

    const elapsedLabel =
      this.#inFlightGetUpdates > 0
        ? `active getUpdates stuck for ${formatDurationPrecise(elapsed)}`
        : `no completed getUpdates for ${formatDurationPrecise(elapsed)}`;
    return {
      message: `Polling stall detected (${elapsedLabel}); forcing restart. [diag ${this.formatDiagnosticFields("error")}]`,
    };
  }

  formatDiagnosticFields(errorLabel?: "error" | "lastGetUpdatesError"): string {
    const error =
      this.#lastGetUpdatesError && errorLabel ? ` ${errorLabel}=${this.#lastGetUpdatesError}` : "";
    return `inFlight=${this.#inFlightGetUpdates} outcome=${this.#lastGetUpdatesOutcome} startedAt=${this.#lastGetUpdatesStartedAt ?? "n/a"} finishedAt=${this.#lastGetUpdatesFinishedAt ?? "n/a"} durationMs=${this.#lastGetUpdatesDurationMs ?? "n/a"} offset=${this.#lastGetUpdatesOffset ?? "n/a"}${error}`;
  }

  #now(): number {
    return this.options.now?.() ?? Date.now();
  }

  #monotonicNow(): number {
    return this.options.monotonicNow?.() ?? performance.now();
  }

  #noteGetUpdatesCompleted(finishedAt: number): void {
    const finishedMonotonicAt = this.#monotonicNow();
    this.#retryAfterUntilMonotonicAt = null;
    this.#lastGetUpdatesActivityMonotonicAt = finishedMonotonicAt;
    this.#lastGetUpdatesFinishedAt = finishedAt;
    this.#lastGetUpdatesDurationMs =
      this.#lastGetUpdatesStartedMonotonicAt == null
        ? null
        : finishedMonotonicAt - this.#lastGetUpdatesStartedMonotonicAt;
  }
}

function resolveGetUpdatesOffset(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || !("offset" in payload)) {
    return null;
  }
  const offset = (payload as { offset?: unknown }).offset;
  return typeof offset === "number" ? offset : null;
}
