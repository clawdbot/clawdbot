/** Formatting helpers for model-list terminal tables. */
import { truncateToVisibleWidth, visibleWidth } from "../../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { isRich as isRichTerminal, theme } from "../../../packages/terminal-core/src/theme.js";

const TRUNCATED_SUFFIX = "...";

/** Enables rich formatting only for non-machine-readable output. */
export const isRich = (opts?: { json?: boolean; plain?: boolean }) =>
  isRichTerminal() && !opts?.json && !opts?.plain;

/** Pads a table cell to a fixed terminal visible width. */
export const pad = (value: string, size: number) => {
  const remaining = size - visibleWidth(value);
  return remaining > 0 ? `${value}${" ".repeat(remaining)}` : value;
};

/** Applies terminal color based on a model-list tag. */
export const formatTag = (tag: string, rich: boolean) => {
  if (!rich) {
    return tag;
  }
  if (tag === "default") {
    return theme.success(tag);
  }
  if (tag === "image") {
    return theme.accentBright(tag);
  }
  if (tag === "configured") {
    return theme.accent(tag);
  }
  if (tag === "missing") {
    return theme.error(tag);
  }
  if (tag.startsWith("fallback#")) {
    return theme.warn(tag);
  }
  if (tag.startsWith("img-fallback#")) {
    return theme.warn(tag);
  }
  if (tag.startsWith("alias:")) {
    return theme.accentDim(tag);
  }
  return theme.muted(tag);
};

/** Truncates model-list cells to terminal visible width with an ASCII ellipsis. */
export const truncate = (value: string, max: number) => {
  const sanitized = sanitizeTerminalText(value);
  if (visibleWidth(sanitized) <= max) {
    return sanitized;
  }
  if (max <= TRUNCATED_SUFFIX.length) {
    return truncateToVisibleWidth(sanitized, max);
  }
  return `${truncateToVisibleWidth(sanitized, max - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
};
