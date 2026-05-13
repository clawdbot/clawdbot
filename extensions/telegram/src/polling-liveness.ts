import { formatDurationPrecise } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";

type TelegramPollingLivenessTrackerOptions = {
  now?: () => number;
  onPollSuccess?: (finishedAt: number) => void;
};

type TelegramPollingStall = {
  message: string;
};

export class TelegramPollingLivenessTracker {
  #lastGetUpdatesAt: number;
  #lastGetUpdatesStartedAt: number | null = null;
  #lastGetUpdatesFinishedAt: number | null = null;
  #lastGetUpdatesDurationMs: number | null = null;
  #lastGetUpdatesOutcome = "not-started";
  #lastGetUpdatesError: string | null = null;
  #lastGetUpdatesOffset: number | null = null;
  #inFlightGetUpdates = 0;
  #stallDiagLoggedAt = 0;

  constructor(private readonly options: TelegramPollingLivenessTrackerOptions = {}) {
    this.#lastGetUpdatesAt = this.#now();
  }

  get inFlightGetUpdates() {
    return this.#inFlightGetUpdates;
  }

  noteGetUpdatesStarted(payload: unknown, at = this.#now()) {
    this.#lastGetUpdatesAt = at;
    this.#lastGetUpdatesStartedAt = at;
    this.#lastGetUpdatesOffset = resolveGetUpdatesOffset(payload);
    this.#inFlightGetUpdates += 1;
    this.#lastGetUpdatesOutcome = "started";
    this.#lastGetUpdatesError = null;
  }

  noteGetUpdatesSuccess(result: unknown, at = this.#now()) {
    this.#lastGetUpdatesFinishedAt = at;
    this.#lastGetUpdatesDurationMs =
      this.#lastGetUpdatesStartedAt == null ? null : at - this.#lastGetUpdatesStartedAt;
    this.#lastGetUpdatesOutcome = Array.isArray(result) ? `ok:${result.length}` : "ok";
    this.options.onPollSuccess?.(at);
  }

  noteGetUpdatesError(err: unknown, at = this.#now()) {
    this.#lastGetUpdatesFinishedAt = at;
    this.#lastGetUpdatesDurationMs =
      this.#lastGetUpdatesStartedAt == null ? null : at - this.#lastGetUpdatesStartedAt;
    this.#lastGetUpdatesOutcome = "error";
    this.#lastGetUpdatesError = formatErrorMessage(err);
  }

  noteGetUpdatesFinished() {
    this.#inFlightGetUpdates = Math.max(0, this.#inFlightGetUpdates - 1);
  }

  detectStall(params: { thresholdMs: number; now?: number }): TelegramPollingStall | null {
    const now = params.now ?? this.#now();
    const activeElapsed =
      this.#inFlightGetUpdates > 0 && this.#lastGetUpdatesStartedAt != null
        ? now - this.#lastGetUpdatesStartedAt
        : 0;
    const idleElapsed =
      this.#inFlightGetUpdates > 0
        ? 0
        : now - (this.#lastGetUpdatesFinishedAt ?? this.#lastGetUpdatesAt);
    const elapsed = this.#inFlightGetUpdates > 0 ? activeElapsed : idleElapsed;
    if (elapsed <= params.thresholdMs) {
      return null;
    }
    if (this.#stallDiagLoggedAt && now - this.#stallDiagLoggedAt < params.thresholdMs / 2) {
      return null;
    }
    this.#stallDiagLoggedAt = now;

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
}

function resolveGetUpdatesOffset(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || !("offset" in payload)) {
    return null;
  }
  const offset = (payload as { offset?: unknown }).offset;
  return typeof offset === "number" ? offset : null;
}
