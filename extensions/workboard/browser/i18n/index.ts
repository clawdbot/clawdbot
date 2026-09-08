import { workboardLocale } from "../host.ts";
import { messages, type TranslationMap } from "./locales.ts";

function lookup(locale: string, key: string): unknown {
  let value: string | TranslationMap | undefined = messages[locale];
  for (const part of key.split(".")) {
    value = value && typeof value === "object" ? value[part] : undefined;
  }
  return value;
}

export function t(key: string, params?: Record<string, string>): string {
  const value = lookup(workboardLocale(), key) ?? lookup("en", key);
  return typeof value === "string"
    ? value.replace(/\{(\w+)\}/g, (_, name: string) => params?.[name] ?? `{${name}}`)
    : key;
}
