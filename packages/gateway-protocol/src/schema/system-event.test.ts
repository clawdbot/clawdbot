import { describe, expect, it } from "vitest";
import {
  SYSTEM_PRESENCE_CLEAR_LAST_INPUT_TAG,
  SYSTEM_PRESENCE_LEGACY_CLEAR_LAST_INPUT_SECONDS,
  validateSystemEventParams,
} from "./system-event.js";

describe("validateSystemEventParams", () => {
  it("accepts input activity values and the backward-compatible clear marker", () => {
    expect(validateSystemEventParams({ text: "Node: mac", lastInputSeconds: 4 })).toBe(true);
    expect(
      validateSystemEventParams({
        text: "Node: mac",
        lastInputSeconds: SYSTEM_PRESENCE_LEGACY_CLEAR_LAST_INPUT_SECONDS,
        tags: [SYSTEM_PRESENCE_CLEAR_LAST_INPUT_TAG],
      }),
    ).toBe(true);
  });

  it("rejects invalid input activity values", () => {
    expect(validateSystemEventParams({ text: "Node: mac", lastInputSeconds: "4" })).toBe(false);
    expect(validateSystemEventParams({ text: "Node: mac", lastInputSeconds: null })).toBe(false);
  });
});
