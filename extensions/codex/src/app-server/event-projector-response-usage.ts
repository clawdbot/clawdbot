import {
  accumulateCodexResponseTokenUsage,
  normalizeCodexResponseTokenUsage,
} from "./event-projector-usage.js";
import { readNonEmptyString } from "./event-projector-values.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

type ResponseUsage = ReturnType<typeof normalizeCodexResponseTokenUsage>;

export class CodexResponseUsageProjection {
  private latest: ResponseUsage;
  private accumulated: ResponseUsage;
  private readonly completedResponseIds = new Set<string>();
  private aggregationComplete = true;

  get modelIterations(): number {
    return this.completedResponseIds.size;
  }

  handleCompleted(params: JsonObject): void {
    const responseId = readNonEmptyString(params, "responseId");
    if (responseId && this.completedResponseIds.has(responseId)) {
      return;
    }
    const usage = isJsonObject(params.usage) ? params.usage : undefined;
    const normalizedUsage = usage ? normalizeCodexResponseTokenUsage(usage) : undefined;
    // The latest exact response owns context freshness. Attempt accounting is
    // separately deduplicated because one turn can call the provider around tools.
    this.latest = normalizedUsage;
    if (responseId) {
      this.completedResponseIds.add(responseId);
    }
    if (!responseId || !normalizedUsage) {
      this.aggregationComplete = false;
      return;
    }
    if (!this.aggregationComplete) {
      return;
    }
    this.accumulated = accumulateCodexResponseTokenUsage(this.accumulated, normalizedUsage);
  }

  markRetryableError(): void {
    this.latest = undefined;
    if (this.accumulated) {
      this.accumulated = {
        ...this.accumulated,
        contextUsage: { state: "unavailable" },
      };
    }
  }

  invalidate(): void {
    this.latest = undefined;
    this.accumulated = undefined;
    this.aggregationComplete = false;
  }

  project(params: { aborted: boolean; fallback: ResponseUsage }): {
    assistantUsage: ResponseUsage;
    attemptUsage: ResponseUsage;
  } {
    const assistantUsage = params.aborted ? params.fallback : (this.latest ?? params.fallback);
    // Top-level attempt buckets account for every exact response. The nested
    // context snapshot still belongs only to the final response.
    const attemptUsage =
      params.aborted || !this.aggregationComplete
        ? params.fallback
        : (this.accumulated ?? assistantUsage);
    return { assistantUsage, attemptUsage };
  }
}
