import { describe, expect, it } from "vitest";
import { formatInternationalPhoneNumberForDisplay } from "./phone-presentation.js";

describe("formatInternationalPhoneNumberForDisplay", () => {
  it.each([
    ["+4930123456", "Germany · +49 30 123456"],
    ["  +4930123456  ", "Germany · +49 30 123456"],
    ["+15551234567", "+1 555 123 4567"],
  ])("formats %s for display without requiring assignment validity", (raw, expected) => {
    expect(formatInternationalPhoneNumberForDisplay(raw, "en")).toBe(expected);
  });

  it.each([
    ["NANPA US", "+12133734253", "+1 213 373 4253"],
    ["NANPA Canada", "+16045551234", "+1 604 555 1234"],
    ["NANPA toll-free", "+18005551234", "+1 800 555 1234"],
    ["United Kingdom", "+442079460018", "+44 20 7946 0018"],
    ["Finland and Åland", "+358412345678", "+358 41 2345678"],
    ["Australia and external territories", "+61412345678", "+61 412 345 678"],
  ])("does not claim a country for shared calling codes: %s", (_name, raw, expected) => {
    expect(formatInternationalPhoneNumberForDisplay(raw, "en")).toBe(expected);
  });

  it("formats non-geographic numbers without a country label", () => {
    expect(formatInternationalPhoneNumberForDisplay("+80012345678", "en")).toBe("+800 1234 5678");
  });

  it.each([
    ["malformed", "+not-a-number"],
    ["short", "+123"],
    ["national", "020 7946 0018"],
    ["token", "bot-token"],
    ["JID", "15551234567@s.whatsapp.net"],
    ["email", "person@example.com"],
    ["whitespace", "   "],
  ])("returns undefined for %s input", (_kind, raw) => {
    expect(formatInternationalPhoneNumberForDisplay(raw, "en")).toBeUndefined();
  });

  it("returns undefined for a malformed locale", () => {
    expect(formatInternationalPhoneNumberForDisplay("+4930123456", "not_a_locale")).toBeUndefined();
  });
});
