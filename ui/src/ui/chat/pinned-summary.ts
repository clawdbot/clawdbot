// Control UI chat module implements pinned summary behavior.
import { extractTextCached } from "./message-extract.ts";

export function getPinnedMessageSummary(message: unknown): string {
  return extractTextCached(message) ?? "";
}
