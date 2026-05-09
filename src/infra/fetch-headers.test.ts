import { describe, expect, it } from "vitest";
import {
  normalizeHeadersInitForFetch,
  normalizeRequestInitHeadersForFetch,
} from "./fetch-headers.js";

function createHeadersWithSymbol(enumerable: boolean): HeadersInit {
  const headers = { "Content-Type": "application/json" } as Record<string, string> & {
    [key: symbol]: unknown;
  };
  Object.defineProperty(headers, Symbol("sensitiveHeaders"), {
    value: new Set(["content-type"]),
    enumerable,
  });
  return headers;
}

describe("normalizeHeadersInitForFetch", () => {
  it("keeps Headers instances unchanged", () => {
    const headers = new Headers({ Accept: "application/json" });

    expect(normalizeHeadersInitForFetch(headers)).toBe(headers);
  });

  it("keeps tuple headers unchanged", () => {
    const headers: HeadersInit = [["Accept", "application/json"]];

    expect(normalizeHeadersInitForFetch(headers)).toBe(headers);
  });

  it("keeps plain string-key dictionaries unchanged when they have no symbol keys", () => {
    const headers = { Accept: "application/json" };

    expect(normalizeHeadersInitForFetch(headers)).toBe(headers);
  });

  it.each([
    { enumerable: true, name: "enumerable" },
    { enumerable: false, name: "non-enumerable" },
  ])("drops $name own symbol keys from plain header dictionaries", ({ enumerable }) => {
    const headers = createHeadersWithSymbol(enumerable);

    const normalized = normalizeHeadersInitForFetch(headers);

    expect(normalized).not.toBe(headers);
    expect(Object.getOwnPropertySymbols(normalized as object)).toStrictEqual([]);
    expect(new Headers(normalized).get("content-type")).toBe("application/json");
    expect(Object.getOwnPropertySymbols(headers as object)).toHaveLength(1);
  });

  it("preserves non-enumerable string header keys when dropping symbol keys", () => {
    const headers = createHeadersWithSymbol(false);
    Object.defineProperty(headers, "X-Hidden", {
      value: "yes",
      enumerable: false,
    });

    const normalized = normalizeHeadersInitForFetch(headers);

    expect(Object.getOwnPropertySymbols(normalized as object)).toStrictEqual([]);
    expect(new Headers(normalized).get("x-hidden")).toBe("yes");
    expect(new Headers(normalized).get("content-type")).toBe("application/json");
  });
});

describe("normalizeRequestInitHeadersForFetch", () => {
  it("returns the original init when headers do not need normalization", () => {
    const init: RequestInit = { headers: { Accept: "application/json" } };

    expect(normalizeRequestInitHeadersForFetch(init)).toBe(init);
  });

  it("returns a cloned init with symbol-free headers when needed", () => {
    const init: RequestInit = { headers: createHeadersWithSymbol(false) };

    const normalized = normalizeRequestInitHeadersForFetch(init);

    expect(normalized).not.toBe(init);
    expect(Object.getOwnPropertySymbols(normalized?.headers as object)).toStrictEqual([]);
    expect(Object.getOwnPropertySymbols(init.headers as object)).toHaveLength(1);
  });
});
