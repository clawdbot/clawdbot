import { describe, expect, it } from "vitest";
import {
  parseRetryAfterErrorSeconds,
  parseRetryAfterHeadersSeconds,
  parseRetryAfterHttpDateMs,
} from "./retry-after.js";

const EXAMPLE_TIMESTAMP = Date.UTC(1994, 10, 6, 8, 49, 37);

describe("retry header floors", () => {
  it.each([
    { headers: { "retry-after": "7", "retry-after-ms": "335" }, expected: 7 },
    { headers: { "Retry-After": 7, "retry-after-ms": 8500 }, expected: 8.5 },
    { headers: { "retry-after": "7", "retry-after-ms": "invalid" }, expected: 7 },
    { headers: { "retry-after": "7", "retry-after-ms": "0" }, expected: 7 },
    {
      headers: { "retry-after": "Sun, 06 Nov 1994 08:49:37 GMT", "retry-after-ms": "335" },
      expected: 7,
    },
    { headers: { "retry-after": "9007199254740993", "retry-after-ms": "335" }, expected: Infinity },
    { headers: { "retry-after-ms": "9007199254740993" }, expected: Infinity },
    { headers: { "retry-after": "120 seconds", "retry-after-ms": "90000ms" }, expected: undefined },
  ])("keeps the greatest valid native and record floor: $headers", ({ headers, expected }) => {
    const native = new Headers();
    for (const [key, value] of Object.entries(headers)) {
      native.set(key, String(value));
    }
    for (const source of [headers, native]) {
      expect(parseRetryAfterHeadersSeconds(source, EXAMPLE_TIMESTAMP - 7000)).toBe(expected);
    }
  });

  it("reads native Headers without calling an overridden get method", () => {
    const headers = new Headers({ "retry-after": "7" });
    headers.get = () => {
      throw new Error("overridden get called");
    };
    expect(parseRetryAfterHeadersSeconds(headers)).toBe(7);
  });

  it.each(["retry-after", "retry-after-ms"])("fails closed on unsafe numeric %s values", (key) => {
    expect(parseRetryAfterHeadersSeconds({ [key]: 1e30 })).toBe(Infinity);
    expect(parseRetryAfterHeadersSeconds({ [key]: Infinity })).toBe(Infinity);
  });

  it("reads only own timing data without invoking metadata accessors", () => {
    let invoked = false;
    const getter = () => {
      invoked = true;
      throw new Error("getter called");
    };
    const headers = Object.defineProperties(
      { "Retry-After": 7 },
      {
        "retry-after-ms": { get: getter },
        unrelated: { get: getter },
        toJSON: { get: getter },
      },
    );
    expect(parseRetryAfterHeadersSeconds(headers)).toBe(7);
    expect(
      parseRetryAfterErrorSeconds(Object.defineProperty({}, "headers", { get: getter })),
    ).toBeUndefined();
    expect(parseRetryAfterErrorSeconds(Object.create({ headers }))).toBeUndefined();
    expect(invoked).toBe(false);
  });

  it("combines SDK and response header floors", () => {
    expect(
      parseRetryAfterErrorSeconds({
        headers: new Headers({ "retry-after": "7" }),
        response: { headers: { "Retry-After-Ms": 8500 } },
      }),
    ).toBe(8.5);
  });

  it("ignores malformed and revoked metadata", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    for (const headers of [undefined, null, 42, "retry-after: 7", proxy]) {
      expect(parseRetryAfterHeadersSeconds(headers)).toBeUndefined();
      expect(parseRetryAfterErrorSeconds({ headers })).toBeUndefined();
    }
    expect(parseRetryAfterErrorSeconds(proxy)).toBeUndefined();
  });
});

describe("parseRetryAfterHttpDateMs", () => {
  it.each([
    ["IMF-fixdate", "Sun, 06 Nov 1994 08:49:37 GMT"],
    ["RFC 850", "Sunday, 06-Nov-94 08:49:37 GMT"],
    ["asctime single-digit day", "Sun Nov  6 08:49:37 1994"],
    ["asctime two-digit day", "Sun Nov 06 08:49:37 1994"],
  ])("parses %s", (_label, value) => {
    expect(parseRetryAfterHttpDateMs(value, Date.UTC(1994, 0, 1))).toBe(EXAMPLE_TIMESTAMP);
  });

  it.each([
    "Sun, 31 Feb 2027 00:00:00 GMT",
    "Sunday, 31-Feb-27 00:00:00 GMT",
    "Sun Feb 31 00:00:00 2027",
    "Thu, 29 Feb 2027 00:00:00 GMT",
  ])("rejects an invalid calendar date: %s", (value) => {
    expect(parseRetryAfterHttpDateMs(value)).toBeUndefined();
  });

  it.each([
    "Mon, 06 Nov 1994 08:49:37 GMT",
    "Monday, 06-Nov-94 08:49:37 GMT",
    "Mon Nov  6 08:49:37 1994",
  ])("rejects a weekday that does not match the date: %s", (value) => {
    expect(parseRetryAfterHttpDateMs(value, Date.UTC(1994, 0, 1))).toBeUndefined();
  });

  it("accepts the HTTP-date leap-second range", () => {
    expect(parseRetryAfterHttpDateMs("Sat, 31 Dec 2016 23:59:60 GMT")).toBe(Date.UTC(2017, 0, 1));
  });

  it("uses the RFC 850 rolling 50-year rule before validating the weekday", () => {
    const now = Date.UTC(2026, 10, 6);
    expect(parseRetryAfterHttpDateMs("Sunday, 06-Nov-50 00:00:00 GMT", now)).toBe(
      Date.UTC(2050, 10, 6),
    );
    expect(parseRetryAfterHttpDateMs("Sunday, 06-Nov-77 00:00:00 GMT", now)).toBe(
      Date.UTC(1977, 10, 6),
    );
  });

  it.each([
    "sun, 06 Nov 1994 08:49:37 GMT",
    "Sun, 06 Nov 1899 08:49:37 GMT",
    "Sun, 06 Nov 1994 24:00:00 GMT",
    "Sun, 06 Nov 1994 08:60:00 GMT",
    "Sun, 06 Nov 1994 08:49:61 GMT",
    "Sun, 6 Nov 1994 08:49:37 GMT",
    "Sun Nov 6 08:49:37 1994",
  ])("rejects a value outside the HTTP-date grammar: %s", (value) => {
    expect(parseRetryAfterHttpDateMs(value)).toBeUndefined();
  });
});
