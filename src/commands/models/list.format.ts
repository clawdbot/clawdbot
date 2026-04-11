import { colorize, isRich as isRichTerminal, theme } from "../../terminal/theme.js";
export { maskApiKey } from "../../utils/mask-api-key.js";

export const isRich = (opts?: { json?: boolean; plain?: boolean }) =>
  isRichTerminal() && !opts?.json && !opts?.plain;

export const pad = (value: string, size: number) => value.padEnd(size);

export const formatKey = (key: string, rich: boolean) => colorize(rich, theme.warn, key);

export const formatValue = (value: string, rich: boolean) => colorize(rich, theme.info, value);

export const formatKeyValue = (
  key: string,
  value: string,
  rich: boolean,
  valueColor: (value: string) => string = theme.info,
) => `${formatKey(key, rich)}=${colorize(rich, valueColor, value)}`;

export const formatSeparator = (rich: boolean) => colorize(rich, theme.muted, " | ");

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

export const truncate = (value: string, max: number) => {
  if (value.length <= max) {
    return value;
  }
  if (max <= 3) {
    return value.slice(0, max);
  }
  return `${value.slice(0, max - 3)}...`;
};
