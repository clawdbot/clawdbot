// Home-prefix expansion for user-configured loader path lists.
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Expands a leading `~` against the OS home dir, keeping relative inputs
 * relative so callers can resolve them against their own base dir. Unlike
 * `resolveHomeRelativePath`, `~name` is treated as `<home>/name` (shipped
 * loader behavior for prompt/skill path lists).
 */
export function expandTildePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") {
    return homedir();
  }
  if (trimmed.startsWith("~/")) {
    return join(homedir(), trimmed.slice(2));
  }
  if (trimmed.startsWith("~")) {
    return join(homedir(), trimmed.slice(1));
  }
  return trimmed;
}
