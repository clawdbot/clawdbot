import { describe, expect, it } from "vitest";
import {
  validateSessionDiscussionInfoParams,
  validateSessionDiscussionInfoResult,
  validateSessionDiscussionOpenParams,
  validateSessionDiscussionOpenResult,
} from "./index.js";

describe("session discussion protocol validators", () => {
  it.each([
    ["info", validateSessionDiscussionInfoParams],
    ["open", validateSessionDiscussionOpenParams],
  ])("requires a non-empty session key for %s", (_name, validate) => {
    expect(validate({ sessionKey: "agent:main:thread" })).toBe(true);
    expect(validate({ sessionKey: "" })).toBe(false);
    expect(validate({})).toBe(false);
    expect(validate({ sessionKey: "thread", extra: true })).toBe(false);
  });

  it.each([
    ["info", validateSessionDiscussionInfoResult],
    ["open", validateSessionDiscussionOpenResult],
  ])("validates discussion states and optional URLs for %s", (_name, validate) => {
    expect(validate({ state: "none" })).toBe(true);
    expect(
      validate({
        state: "open",
        embedUrl: "https://chat.example/embed/thread",
        openUrl: "https://chat.example/thread",
      }),
    ).toBe(true);
    expect(validate({ state: "unknown" })).toBe(false);
    expect(validate({ state: "open", extra: true })).toBe(false);
  });
});
