import { describe, expect, it } from "vitest";
import {
  looksLikeSmsPhoneNumber,
  normalizeSmsAllowFrom,
  normalizeSmsPhoneNumber,
} from "./phone.js";

describe("SMS phone normalization", () => {
  it("normalizes sms-prefixed E.164 phone numbers", () => {
    expect(normalizeSmsPhoneNumber("sms:+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizeSmsPhoneNumber("twilio-sms:+1 (555) 123-4567")).toBe("+15551234567");
    expect(normalizeSmsAllowFrom("SMS:+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizeSmsAllowFrom("*")).toBe("*");
  });

  it("validates E.164-ish SMS targets", () => {
    expect(looksLikeSmsPhoneNumber("+15551234567")).toBe(true);
    expect(looksLikeSmsPhoneNumber("15551234567")).toBe(true);
    expect(looksLikeSmsPhoneNumber("+01234567")).toBe(false);
    expect(looksLikeSmsPhoneNumber("+1555")).toBe(false);
  });
});
