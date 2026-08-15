import { describe, expect, it } from "vitest";
import { parseRetryAfterHttpDateMs } from "./retry-after.js";

const EXAMPLE_TIMESTAMP = Date.UTC(1994, 10, 6, 8, 49, 37);

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
