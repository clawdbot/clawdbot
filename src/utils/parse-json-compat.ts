/**
 * JSON parser compatibility helper for persisted config, manifests, and legacy stores.
 * Strict JSON stays the fast path; JSON5 is only the authored/legacy fallback.
 */
import { createRequire } from "node:module";

type Json5Parser = { parse: (value: string) => unknown };
let json5Runtime: Json5Parser | undefined;
// oxlint-disable-next-line eslint/no-underscore-dangle -- Bundled worker builds replace this compile-time define.
declare const __WORKER_DEPLOY_BUILD__: boolean;

function isJson5Parser(value: unknown): value is Json5Parser {
  return (
    typeof value === "object" &&
    value !== null &&
    "parse" in value &&
    typeof value.parse === "function"
  );
}

/** Registers the statically bundled JSON5 parser for portable worker startup. */
export function registerJson5Runtime(runtime: unknown): void {
  const parser = isJson5Parser(runtime)
    ? runtime
    : typeof runtime === "object" && runtime !== null && "default" in runtime
      ? runtime.default
      : undefined;
  if (!isJson5Parser(parser)) {
    throw new Error("json5 parser unavailable");
  }
  json5Runtime = parser;
}

function loadJson5Parser(): Json5Parser {
  if (json5Runtime) {
    return json5Runtime;
  }
  // oxlint-disable-next-line unicorn/no-typeof-undefined -- The build define is absent in source runtimes.
  if (typeof __WORKER_DEPLOY_BUILD__ !== "undefined" && __WORKER_DEPLOY_BUILD__) {
    throw new Error("worker JSON5 runtime was not registered before use");
  }
  registerJson5Runtime(createRequire(import.meta.url)("json5"));
  return json5Runtime!;
}

/** Parses strict JSON first, then accepts JSON5 syntax such as comments and trailing commas. */
export function parseJsonWithJson5Fallback(raw: string, json5?: Json5Parser): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return (json5 ?? loadJson5Parser()).parse(raw);
  }
}
