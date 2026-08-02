import { formatErrorMessage } from "../infra/errors.js";

const MAX_REFRESH_ERROR_GRAPH_ITEMS = 8;
const MAX_REFRESH_ERROR_MESSAGE_LENGTH = 2_048;

export function formatRuntimeRefreshError(error: unknown): string {
  const queue = [error];
  const seen = new Set<unknown>();
  const messages: string[] = [];
  while (queue.length > 0 && seen.size < MAX_REFRESH_ERROR_GRAPH_ITEMS) {
    const current = queue.shift();
    if (current == null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    const message = formatErrorMessage(current);
    if (message && !messages.includes(message)) {
      messages.push(message);
    }
    if (current instanceof AggregateError) {
      queue.push(...current.errors);
    }
  }
  const formatted = messages.join(" | ");
  return formatted.length > MAX_REFRESH_ERROR_MESSAGE_LENGTH
    ? `${formatted.slice(0, MAX_REFRESH_ERROR_MESSAGE_LENGTH)}...`
    : formatted;
}
