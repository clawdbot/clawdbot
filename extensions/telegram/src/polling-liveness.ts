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
  #lastApiActivityAt: number;
  #nextInFlightApiCallId = 0;
  #latestInFlightApiStartedAt: number | null = null;
  #inFlightApiStartedAt = new Map<number, number>();
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
    this.#lastApiActivityAt = this.#now();
  }

  get inFlightGetUpdates() {
    return this.#inFlightGetUpdates;
  }

  noteApiCallStarted(): number {
    const startedAt = this.#now();
    const callId = this.#nextInFlightApiCallId;
    this.#nextInFlightApiCallId += 1;
    this.#inFlightApiStartedAt.set(callId, startedAt);
    this.#latestInFlightApiStartedAt =
      this.#latestInFlightApiStartedAt == null
        ? startedAt
        : Math.max(this.#latestInFlightApiStartedAt, startedAt);
    return callId;
  }

  noteApiCallSuccess(at = this.#now()) {
    this.#lastApiActivityAt = at;
  }

  noteApiCallFinished(callId: number) {
    const startedAt = this.#inFlightApiStartedAt.get(callId);
    this.#inFlightApiStartedAt.delete(callId);
    if (startedAt != null && this.#latestInFlightApiStartedAt === startedAt) {
      this.#latestInFlightApiStartedAt = this.#resolveLatestInFlightApiStartedAt();
    }
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
    this.#lastApiActivityAt = at;
    this.options.onPollSuccess?.(at);
  }

  noteGetUpdatesError(err: unknown, at = this.#now()) {
    this.#lastGetUpdatesFinishedAt = at;
    this.#lastGetUpdatesDurationMs =
      this.#lastGetUpdatesStartedAt == null ? null : at - this.#lastGetUpdatesStartedAt;
    this.#lastGetUpdatesOutcome = "error";
    this.#lastGetUpdatesError = formatErrorMessage(err);
    this.#lastApiActivityAt = at;
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
    const apiLivenessAt =
      this.#latestInFlightApiStartedAt == null
        ? this.#lastApiActivityAt
        : Math.max(this.#lastApiActivityAt, this.#latestInFlightApiStartedAt);
    const apiElapsed = now - apiLivenessAt;

    if (elapsed <= params.thresholdMs || apiElapsed <= params.thresholdMs) {
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

  #resolveLatestInFlightApiStartedAt(): number | null {
    let newestStartedAt: number | null = null;
    for (const activeStartedAt of this.#inFlightApiStartedAt.values()) {
      newestStartedAt =
        newestStartedAt == null ? activeStartedAt : Math.max(newestStartedAt, activeStartedAt);
    }
    return newestStartedAt;
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
