import { beforeEach, describe, expect, it } from "vitest";
import { clearAccountThrottlersForTest, getOrCreateAccountThrottler } from "./account-throttler.js";

describe("getOrCreateAccountThrottler", () => {
  beforeEach(() => {
    clearAccountThrottlersForTest();
  });

  it("shares throttlers per bot token", () => {
    const first = getOrCreateAccountThrottler("tok");
    const second = getOrCreateAccountThrottler("tok");
    const other = getOrCreateAccountThrottler("other");

    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });
});
