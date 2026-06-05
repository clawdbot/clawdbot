/** Formatting helpers for model-list terminal tables. */
import { isRich as isRichTerminal, theme } from "../../../packages/terminal-core/src/theme.js";
export { maskApiKey } from "../../utils/mask-api-key.js";

/** Enables rich formatting only for non-machine-readable output. */
export const isRich = (opts?: { json?: boolean; plain?: boolean }) =>
  isRichTerminal() && !opts?.json && !opts?.plain;

/** Pads a table cell to a fixed width. */
export const pad = (value: string, size: number) => value.padEnd(size);

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

/** Truncates model-list cells with an ASCII ellipsis. */
export const truncate = (value: string, max: number) => {
  if (value.length <= max) {
    return value;
  }
  if (max <= 3) {
    return value.slice(0, max);
  }
  return `${value.slice(0, max - 3)}...`;
};
