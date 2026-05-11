import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

type HttpHeaderMap = Record<string, string | string[] | undefined>;

export function getHeader(headers: HttpHeaderMap, name: string): string | undefined {
  const target = normalizeLowercaseStringOrEmpty(name);
  const direct = headers[target];
  const value =
    direct ??
    Object.entries(headers).find(([key]) => normalizeLowercaseStringOrEmpty(key) === target)?.[1];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}
