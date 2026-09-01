// Terminal Core module implements prompt style behavior.
import { isRich, theme } from "./theme.js";

// Shared styling helpers for interactive prompt copy.

/** Style a prompt message when rich terminal output is active. */
export const stylePromptMessage = (message: string): string =>
  isRich() ? theme.accent(message) : message;

/** Style a prompt title when rich terminal output is active. */
export const stylePromptTitle = (title?: string): string | undefined =>
  title && isRich() ? theme.heading(title) : title;

/** Style a prompt hint when rich terminal output is active. */
export const stylePromptHint = (hint?: string): string | undefined =>
  hint && isRich() ? theme.muted(hint) : hint;
