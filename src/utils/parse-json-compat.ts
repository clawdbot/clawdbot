/**
 * JSON parser compatibility helper for persisted config, manifests, and legacy stores.
 * Strict JSON stays the fast path; JSON5 is only the authored/legacy fallback.
 */
import { createRequire } from "node:module";

type Json5Parser = { parse: (value: string) => unknown };
let lazyJson5Parser: Json5Parser | undefined;

function loadJson5Parser(): Json5Parser {
  if (lazyJson5Parser) {
    return lazyJson5Parser;
  }
  const loaded = createRequire(import.meta.url)("json5") as Json5Parser | { default?: Json5Parser };
  const parser = "parse" in loaded ? loaded : loaded.default;
  if (!parser) {
    throw new Error("json5 parser unavailable");
  }
  lazyJson5Parser = parser;
  return parser;
}

/** Parses strict JSON first, then accepts JSON5 syntax such as comments and trailing commas. */
export function parseJsonWithJson5Fallback(raw: string, json5?: Json5Parser): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return (json5 ?? loadJson5Parser()).parse(raw);
  }
}
