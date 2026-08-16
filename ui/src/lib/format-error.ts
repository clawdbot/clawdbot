import { formatErrorMessage } from "@openclaw/normalization-core";
import { redactToolDetail } from "./browser-redact.ts";

export function formatUiError(error: unknown, fallback = ""): string {
  return formatErrorMessage(error, { redact: redactToolDetail }) || fallback;
}
