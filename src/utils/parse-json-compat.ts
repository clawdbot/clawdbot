/**
 * JSON parser compatibility helper for persisted config, manifests, and legacy stores.
 * Strict JSON stays the fast path; JSON5 is only the authored/legacy fallback.
 */
import { createRequire } from "node:module";
import { getSealedRuntimeJson5 } from "../infra/sealed-runtime-registry.js";

type Json5Parser = { parse: (value: string) => unknown };
let json5Runtime: Json5Parser | undefined;
declare const SEALED_RUNTIME_BUILD: boolean;

function isJson5Parser(value: unknown): value is Json5Parser {
  return (
    typeof value === "object" &&
    value !== null &&
    "parse" in value &&
    typeof value.parse === "function"
  );
}

function setJson5Runtime(runtime: unknown): Json5Parser {
  const parser = isJson5Parser(runtime)
    ? runtime
    : typeof runtime === "object" && runtime !== null && "default" in runtime
      ? runtime.default
      : undefined;
  if (!isJson5Parser(parser)) {
    throw new Error("json5 parser unavailable");
  }
  json5Runtime = parser;
  return parser;
}

function loadJson5Parser(): Json5Parser {
  if (json5Runtime) {
    return json5Runtime;
  }
  const injected = getSealedRuntimeJson5();
  if (injected !== undefined) {
    return setJson5Runtime(injected);
  }
  if (typeof SEALED_RUNTIME_BUILD === "boolean" && SEALED_RUNTIME_BUILD) {
    throw new Error("sealed JSON5 runtime was not registered before use");
  }
  return setJson5Runtime(createRequire(import.meta.url)("json5"));
}

/** Parses strict JSON first, then accepts JSON5 syntax such as comments and trailing commas. */
export function parseJsonWithJson5Fallback(raw: string, json5?: Json5Parser): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return (json5 ?? loadJson5Parser()).parse(raw);
  }
}
