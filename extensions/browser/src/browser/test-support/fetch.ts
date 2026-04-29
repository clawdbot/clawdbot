import { createRequire } from "node:module";

type FetchLike = ((input: string | URL, init?: RequestInit) => Promise<Response>) & {
  mock?: unknown;
};

export type BrowserTestFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function isUsableFetch(value: unknown): value is FetchLike {
  return typeof value === "function" && !("mock" in (value as FetchLike));
}

export function getBrowserTestFetch(): BrowserTestFetch {
  const require = createRequire(import.meta.url);
  const vitest = (globalThis as { vi?: { doUnmock?: (id: string) => void } }).vi;
  vitest?.doUnmock?.("undici");
  try {
    delete require.cache[require.resolve("undici")];
  } catch {
    // Best-effort cache bust for shared-thread test workers.
  }
  const { fetch } = require("undici") as typeof import("undici");
  if (isUsableFetch(fetch)) {
    return (input, init) => fetch(input, init);
  }
  if (isUsableFetch(globalThis.fetch)) {
    return (input, init) => globalThis.fetch(input, init);
  }
  throw new TypeError("fetch is not a function");
}
