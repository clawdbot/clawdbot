import { describe, expect, it } from "vitest";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./google-meet-platform-adapter.js";

describe("GOOGLE_MEET_PLATFORM_ADAPTER captions", () => {
  it("enables caption capture for durable notes in every browser mode", () => {
    expect(GOOGLE_MEET_PLATFORM_ADAPTER.browser.captions.enabled("agent")).toBe(true);
    expect(GOOGLE_MEET_PLATFORM_ADAPTER.browser.captions.enabled("bidi")).toBe(true);
    expect(GOOGLE_MEET_PLATFORM_ADAPTER.browser.captions.enabled("transcribe")).toBe(true);
  });
});
