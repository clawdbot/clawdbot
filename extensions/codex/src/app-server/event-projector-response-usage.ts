import {
  accumulateCodexResponseTokenUsage,
  normalizeCodexResponseTokenUsage,
} from "./event-projector-usage.js";
import { readNonEmptyString } from "./event-projector-values.js";
import { isJsonObject, type JsonObject } from "./protocol.js";

type CodexResponseUsage = ReturnType<typeof normalizeCodexResponseTokenUsage>;

export type CodexCompletedResponseUsage = {
  responseId: string;
  usage?: NonNullable<CodexResponseUsage>;
};

export class CodexResponseUsageProjection {
  private latest: CodexResponseUsage;
  private accumulated: CodexResponseUsage;
  private readonly completedResponseIds = new Set<string>();
  private aggregationComplete = true;

  get modelIterations(): number {
    return this.completedResponseIds.size;
  }

  handleCompleted(params: JsonObject): CodexCompletedResponseUsage | undefined {
    const responseId = readNonEmptyString(params, "responseId");
    if (responseId && this.completedResponseIds.has(responseId)) {
      return undefined;
    }
    const usage = isJsonObject(params.usage) ? params.usage : undefined;
    const normalizedUsage = usage ? normalizeCodexResponseTokenUsage(usage) : undefined;
    // The latest exact response owns context freshness. Attempt accounting is
    // separately deduplicated because one turn can call the provider around tools.
    this.latest = normalizedUsage;
    if (!responseId) {
      this.aggregationComplete = false;
      return undefined;
    }
    this.completedResponseIds.add(responseId);
    if (!normalizedUsage) {
      this.aggregationComplete = false;
      return { responseId };
    }
    if (!this.aggregationComplete) {
      return { responseId, usage: normalizedUsage };
    }
    this.accumulated = accumulateCodexResponseTokenUsage(this.accumulated, normalizedUsage);
    return { responseId, usage: normalizedUsage };
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

  project(params: { aborted: boolean; fallback: CodexResponseUsage }): {
    assistantUsage: CodexResponseUsage;
    attemptUsage: CodexResponseUsage;
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
