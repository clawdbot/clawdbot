import { describe, expect, it } from "vitest";
import { resolveOperatorRequestHeaders } from "./operator-request-headers.js";

const RESERVED = ["accept", "user-agent"];

function resolve(configured: unknown) {
  return resolveOperatorRequestHeaders({ configured, reservedNames: RESERVED });
}

function expectSendableValue(value: string): void {
  expect(resolve({ "X-Test": value }).headers?.["X-Test"]).toBe(value);
}

function expectIgnoredValue(value: unknown): void {
  const { headers, ignored } = resolve({ "X-Test": value });
  expect(headers).toBeUndefined();
  expect(ignored).toEqual(["X-Test"]);
}

describe("operator request header value validation", () => {
  it("accepts visible ASCII, spaces, HTAB, and obs-text", () => {
    expectSendableValue("staging");
    expectSendableValue("Mozilla/5.0 (Macintosh)");
    expectSendableValue("a\tb");
    expectSendableValue("café");
  });

  it("rejects values Headers cannot encode or that forge headers", () => {
    // Above U+00FF has no single-byte form, so Headers throws instead of encoding.
    expectIgnoredValue("staging—eu");
    expectIgnoredValue("東京");
    expectIgnoredValue("a\r\nX-Smuggled: yes");
    expectIgnoredValue("a\0b");
    expectIgnoredValue(42);
  });

  it("accepts literal environment placeholder text after config escaping", () => {
    // Config's $${VAR} escape resolves to ${VAR} before request normalization.
    expectSendableValue("${WEB_FETCH_TARGET}");
    expectSendableValue("prefix-${TOKEN}-suffix");
    expectSendableValue("${lowercase}");
  });
});

describe("resolveOperatorRequestHeaders", () => {
  it("returns no headers for a non-record", () => {
    expect(resolve(undefined).headers).toBeUndefined();
    expect(resolve("nope").headers).toBeUndefined();
  });

  it("trims names and values and sorts the result", () => {
    const { headers } = resolve({ "  X-B  ": " two ", "X-A": "one", "X-Empty": " \t " });
    expect(Object.entries(headers ?? {})).toEqual([
      ["X-A", "one"],
      ["X-B", "two"],
      ["X-Empty", ""],
    ]);
  });

  it("keeps one entry per name regardless of case", () => {
    const { headers, collisions } = resolve({ "X-Dup": "first", "x-dup": "second" });
    expect(headers).toEqual({ "x-dup": "second" });
    expect(collisions).toEqual(["X-Dup"]);
  });

  it("does not retain an earlier value when a later case variant is unusable", () => {
    const { headers, ignored, collisions } = resolve({
      "X-Route": "staging",
      "x-route": "東京",
    });
    expect(headers).toBeUndefined();
    expect(ignored).toEqual(["x-route"]);
    expect(collisions).toEqual(["X-Route"]);
  });

  it("refuses reserved, framing, and credential names", () => {
    const { headers, refused } = resolve({
      Accept: "text/plain",
      Upgrade: "h2c",
      "Transfer-Encoding": "chunked",
      "Content-Length": "0",
      TE: "trailers",
      Authorization: "Bearer x",
      "X-Authorization": "Bearer y",
      "X-Api-Key": "live",
      "X-Api-Token": "api-token-live",
      "Api-Token": "api-token-live",
      "x-goog-api-key": "google-live",
      "Ocp-Apim-Subscription-Key": "azure-live",
      "Private-Token": "gitlab-live",
      "X-Vault-Token": "vault-live",
      "X-Amz-Security-Token": "aws-live",
      "X-GitHub-Token": "github-live",
      "X-APIKEY": "generic-live",
      "Fastly-Key": "fastly-live",
      "X-Auth-Key": "auth-live",
      "X-RapidAPI-Key": "rapidapi-live",
      "X-Akamai-ACS-Auth-Sign": "akamai-live",
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
        "X-Authorization",
        "X-Api-Key",
        "X-Api-Token",
        "Api-Token",
        "x-goog-api-key",
        "Ocp-Apim-Subscription-Key",
        "Private-Token",
        "X-Vault-Token",
        "X-Amz-Security-Token",
        "X-GitHub-Token",
        "X-APIKEY",
        "Fastly-Key",
        "X-Auth-Key",
        "X-RapidAPI-Key",
        "X-Akamai-ACS-Auth-Sign",
      ]),
    );
  });

  it("trims only HTTP whitespace and preserves valid obs-text bytes", () => {
    const { headers } = resolve({
      "X-Http-Padded": " \tvalue\t ",
      "X-Obs-Text-Padded": "\u00a0route\u00a0",
    });
    expect(headers?.["X-Http-Padded"]).toBe("value");
    expect(headers?.["X-Obs-Text-Padded"]).toBe("\u00a0route\u00a0");
  });

  it("reports unsendable entries as ignored without dropping the rest", () => {
    const { headers, ignored } = resolve({
      "X Invalid": "spaced name",
      "X-Unicode": "東",
      "X-Fine": "ok",
    });
    expect(Object.keys(headers ?? {})).toEqual(["X-Fine"]);
    expect(ignored).toEqual(expect.arrayContaining(["X Invalid", "X-Unicode"]));
  });

  it("accepts known non-credential metadata despite sensitive-looking names", () => {
    const { headers, suspicious } = resolve({
      "X-Tokenizer-Version": "v2",
      "X-Secret-Scan-Status": "clean",
      "X-Trace-Token": "trace-context",
      "Idempotency-Key": "request-123",
      "X-Idempotency-Key": "request-456",
      "Surrogate-Key": "product-123",
      "X-Cache-Key": "tenant-123",
    });

    expect(headers).toEqual({
      "Idempotency-Key": "request-123",
      "Surrogate-Key": "product-123",
      "X-Cache-Key": "tenant-123",
      "X-Idempotency-Key": "request-456",
      "X-Secret-Scan-Status": "clean",
      "X-Tokenizer-Version": "v2",
      "X-Trace-Token": "trace-context",
    });
    expect(suspicious).toEqual(["X-Secret-Scan-Status", "X-Tokenizer-Version", "X-Trace-Token"]);
  });
});
