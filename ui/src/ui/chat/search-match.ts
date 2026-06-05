// Control UI chat module implements search match behavior.
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";
import { extractTextCached } from "./message-extract.ts";

export function messageMatchesSearchQuery(message: unknown, query: string): boolean {
  const normalizedQuery = normalizeLowercaseStringOrEmpty(query);
  if (!normalizedQuery) {
    return true;
  }
  const text = normalizeLowercaseStringOrEmpty(extractTextCached(message));
  return text.includes(normalizedQuery);
}
