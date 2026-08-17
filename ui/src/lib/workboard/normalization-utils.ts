import { formatUiError } from "../format-error.ts";

export function formatError(error: unknown): string {
  return formatUiError(error, "Unknown workboard error.");
}
