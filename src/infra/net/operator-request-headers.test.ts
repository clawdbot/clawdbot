import { describe, expect, it } from "vitest";
import {
  isSendableHeaderValue,
  resolveOperatorRequestHeaders,
} from "./operator-request-headers.js";

const RESERVED = ["accept", "user-agent"];

function resolve(configured: unknown) {
  return resolveOperatorRequestHeaders({ configured, reservedNames: RESERVED });
}

describe("isSendableHeaderValue", () => {
  it("accepts visible ASCII, spaces, HTAB, and obs-text", () => {
    expect(isSendableHeaderValue("staging")).toBe(true);
    expect(isSendableHeaderValue("Mozilla/5.0 (Macintosh)")).toBe(true);
    expect(isSendableHeaderValue("a\tb")).toBe(true);
    expect(isSendableHeaderValue("café")).toBe(true);
  });

  it("rejects values Headers cannot encode or that forge headers", () => {
    // Above U+00FF has no single-byte form, so Headers throws instead of encoding.
    expect(isSendableHeaderValue("staging—eu")).toBe(false);
    expect(isSendableHeaderValue("東京")).toBe(false);
    expect(isSendableHeaderValue("a\r\nX-Smuggled: yes")).toBe(false);
    expect(isSendableHeaderValue("a\0b")).toBe(false);
    expect(isSendableHeaderValue(42)).toBe(false);
  });

  it("rejects values still holding an unexpanded env placeholder", () => {
    // Substitution never ran, so sending it would leak the literal to the host.
    expect(isSendableHeaderValue("${WEB_FETCH_TARGET}")).toBe(false);
    expect(isSendableHeaderValue("prefix-${TOKEN}-suffix")).toBe(false);
    // Only uppercase placeholders are substituted, so this is a real value.
    expect(isSendableHeaderValue("${lowercase}")).toBe(true);
  });
});

describe("resolveOperatorRequestHeaders", () => {
  it("returns no headers for a non-record", () => {
    expect(resolve(undefined).headers).toBeUndefined();
    expect(resolve("nope").headers).toBeUndefined();
  });

  it("trims names and values and sorts the result", () => {
    const { headers } = resolve({ "  X-B  ": " two ", "X-A": "one" });
    expect(Object.entries(headers ?? {})).toEqual([
      ["X-A", "one"],
      ["X-B", "two"],
    ]);
  });

  it("keeps one entry per name regardless of case", () => {
    const { headers } = resolve({ "X-Dup": "first", "x-dup": "second" });
    expect(Object.keys(headers ?? {})).toHaveLength(1);
  });

  it("refuses reserved, framing, and credential names", () => {
    const { headers, refused } = resolve({
      Accept: "text/plain",
      Upgrade: "h2c",
      "Transfer-Encoding": "chunked",
      "Content-Length": "0",
      TE: "trailers",
      Authorization: "Bearer x",
      "X-Api-Key": "live",
      "X-Fine": "ok",
    });
    expect(Object.keys(headers ?? {})).toEqual(["X-Fine"]);
    expect(refused).toEqual(
      expect.arrayContaining([
        "Accept",
        "Upgrade",
        "Transfer-Encoding",
        "Content-Length",
        "TE",
        "Authorization",
        "X-Api-Key",
      ]),
    );
  });

  it("reports unsendable entries as ignored without dropping the rest", () => {
    const { headers, ignored } = resolve({
      "X Invalid": "spaced name",
      "X-Unicode": "東",
      "X-Placeholder": "prefix-${UNSET_TARGET}-suffix",
      "X-Blank": "   ",
      "X-Fine": "ok",
    });
    expect(Object.keys(headers ?? {})).toEqual(["X-Fine"]);
    expect(ignored).toEqual(
      expect.arrayContaining(["X Invalid", "X-Unicode", "X-Placeholder", "X-Blank"]),
    );
  });

  it("accepts credential-looking names but reports them as suspicious", () => {
    const { headers, suspicious } = resolve({ "X-Trace-Token": "abc" });
    expect(headers?.["X-Trace-Token"]).toBe("abc");
    expect(suspicious).toEqual(["X-Trace-Token"]);
  });
});
