import { formatErrorMessage } from "@openclaw/normalization-core";
import { redactToolDetail } from "./browser-redact.ts";

export function formatUiError(error: unknown, fallback = ""): string {
  return formatErrorMessage(error, { redact: redactToolDetail }) || fallback;
}

export function formatUiExternalText(value: string | null | undefined, fallback = ""): string {
  const text = value?.trim();
  return text ? redactToolDetail(text) : fallback;
}
