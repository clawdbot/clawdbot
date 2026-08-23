import { describe, expect, it } from "vitest";
import {
  hasSameZoomMeetingJoinCredential,
  isRecoverableZoomMeetingTab,
  isSameZoomMeetingUrl,
  normalizeZoomMeetingUrl,
  normalizeZoomMeetingUrlForReuse,
} from "./zoom-meetings-urls.js";

describe("Zoom meeting URL normalization", () => {
  it.each([
    ["https://zoom.us/j/123456789?pwd=abc", "zoom:123456789"],
    ["https://acme.zoom.us/j/12345678901/", "zoom:12345678901"],
    ["https://app.zoom.us/wc/12345678901/join?from=pwa&wpk=opaque", "zoom:12345678901"],
  ])("extracts a stable identity from %s", (url, expected) => {
    expect(normalizeZoomMeetingUrlForReuse(url)).toBe(expected);
  });

  it("compares the invitation and web-client forms as one meeting", () => {
    expect(
      isSameZoomMeetingUrl(
        "https://acme.zoom.us/j/12345678901?pwd=one",
        "https://app.zoom.us/wc/12345678901/join?from=pwa",
      ),
    ).toBe(true);
  });

  it("distinguishes invite credentials without rejecting the admitted web-client URL", () => {
    const oldInvite = "https://zoom.us/j/12345678901?pwd=old";
    const correctedInvite = "https://zoom.us/j/12345678901?pwd=correct";
    const webClient = "https://app.zoom.us/wc/12345678901/join";

    expect(isSameZoomMeetingUrl(oldInvite, correctedInvite)).toBe(true);
    expect(hasSameZoomMeetingJoinCredential(oldInvite, correctedInvite)).toBe(false);
    expect(isRecoverableZoomMeetingTab({ url: oldInvite }, correctedInvite)).toBe(false);
    expect(isRecoverableZoomMeetingTab({ url: webClient }, correctedInvite)).toBe(true);
  });

  it.each([
    "https://zoom.us/",
    "https://zoom.us/j/12345678",
    "https://zoom.us/j/123456789012",
    "https://zoom.us/wc/12345678901/join",
    "https://app.zoom.us/wc/not-a-meeting/join",
    "http://zoom.us/j/12345678901",
    "https://zoom.us:8443/j/12345678901",
    "https://evil.example/j/12345678901",
    "https://zoom.us.evil.example/j/12345678901",
  ])("rejects non-meeting Zoom input: %s", (url) => {
    expect(normalizeZoomMeetingUrlForReuse(url)).toBeUndefined();
    expect(() => normalizeZoomMeetingUrl(url)).toThrow(
      "Zoom meeting URL must use https://<account>.zoom.us/j/<meeting-id>",
    );
  });

  it("preserves passcode parameters and removes fragments", () => {
    const normalized = normalizeZoomMeetingUrl("https://zoom.us/j/12345678901?pwd=abc#success");
    expect(normalized).toContain("pwd=abc");
    expect(normalized).not.toContain("#success");
  });
});
