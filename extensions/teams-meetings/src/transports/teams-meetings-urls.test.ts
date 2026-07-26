import { describe, expect, it } from "vitest";
import {
  isSameTeamsMeetingUrl,
  normalizeTeamsMeetingUrl,
  normalizeTeamsMeetingUrlForReuse,
} from "./teams-meetings-urls.js";

const WORK_URL =
  "https://teams.microsoft.com/l/meetup-join/19%3ameeting_NzQ1ZDBjYzItZDAxNS00N2YxLTg4Y2EtYjQ1N2I4NDg2Njli%40thread.v2/0?context=%7b%22Tid%22%3a%22tenant%22%7d";
const CONSUMER_COORDINATES = Buffer.from(
  JSON.stringify({ meetingCode: "9326458712345", passcode: "abc" }),
).toString("base64");

describe("Microsoft Teams meeting URL normalization", () => {
  it.each([
    [WORK_URL, "teams-work:19:meeting_NzQ1ZDBjYzItZDAxNS00N2YxLTg4Y2EtYjQ1N2I4NDg2Njli@thread.v2"],
    ["https://teams.live.com/meet/9326458712345?p=abc", "teams-consumer:9326458712345:p:abc"],
    [
      "https://teams.live.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2F9326458712345%3Fp%3Dabc",
      "teams-consumer:9326458712345:p:abc",
    ],
    [
      `https://teams.live.com/light-meetings/launch?coords=${encodeURIComponent(CONSUMER_COORDINATES)}`,
      "teams-consumer:9326458712345:p:abc",
    ],
  ])("extracts a stable identity from %s", (url, expected) => {
    expect(normalizeTeamsMeetingUrlForReuse(url)).toBe(expected);
  });

  it("ignores query parameters when comparing meeting identity", () => {
    expect(
      isSameTeamsMeetingUrl(
        WORK_URL,
        `${WORK_URL.split("?")[0]}?context=%7b%22Tid%22%3a%22other%22%7d&anon=true`,
      ),
    ).toBe(true);
    expect(
      isSameTeamsMeetingUrl(
        "https://teams.live.com/meet/abc-123?invite=one",
        "https://teams.live.com/meet/ABC-123?invite=two",
      ),
    ).toBe(true);
  });

  it.each([
    [
      "https://teams.live.com/meet/abc-123?p=one",
      "https://teams.live.com/meet/ABC-123?p=one&invite=x",
      true,
    ],
    [
      "https://teams.live.com/meet/abc-123?p=one",
      "https://teams.live.com/meet/abc-123?p=two",
      false,
    ],
    ["https://teams.live.com/meet/abc-123?p=one", "https://teams.live.com/meet/abc-123", false],
  ])("compares consumer meeting passcode identity: %s / %s", (left, right, expected) => {
    expect(isSameTeamsMeetingUrl(left, right)).toBe(expected);
  });

  it.each([
    "https://teams.microsoft.com/",
    "https://teams.microsoft.com/v2/",
    "https://teams.microsoft.com/l/channel/19%3Achannel%40thread.tacv2",
    "https://teams.live.com/",
    "https://teams.live.com/dl/launcher/launcher.html?url=https%3A%2F%2Fevil.example%2Fmeet%2Fabc",
    "https://teams.live.com/dl/launcher/launcher.html?url=%2F_%23%2Fmeet%2Fabc%2Fextra",
    "https://teams.live.com/light-meetings/launch?coords=not-json",
    "http://teams.live.com/meet/abc",
    "https://example.com/l/meetup-join/19%3ameeting_x%40thread.v2/0",
  ])("rejects non-meeting Teams input: %s", (url) => {
    expect(normalizeTeamsMeetingUrlForReuse(url)).toBeUndefined();
    expect(() => normalizeTeamsMeetingUrl(url)).toThrow("Microsoft Teams meeting URL must use");
  });

  it("preserves the join query while removing fragments", () => {
    const normalized = normalizeTeamsMeetingUrl(`${WORK_URL}#ignored`);
    expect(normalized).toContain("context=");
    expect(normalized).not.toContain("#ignored");
  });
});
