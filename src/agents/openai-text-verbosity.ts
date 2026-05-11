import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { log } from "./pi-embedded-runner/logger.js";

/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export type OpenAITextVerbosity = "low" | "medium" | "high";

function normalizeOpenAITextVerbosity(value: unknown): OpenAITextVerbosity | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return undefined;
}

/** @deprecated OpenAI provider-owned stream helper; do not use from third-party plugins. */
export function resolveOpenAITextVerbosity(
  extraParams: Record<string, unknown> | undefined,
): OpenAITextVerbosity | undefined {
  const raw = extraParams?.textVerbosity ?? extraParams?.text_verbosity;
  const normalized = normalizeOpenAITextVerbosity(raw);
  if (raw !== undefined && normalized === undefined) {
    const rawSummary = typeof raw === "string" ? raw : typeof raw;
    log.warn(`ignoring invalid OpenAI text verbosity param: ${rawSummary}`);
  }
  return normalized;
}
