import { describe, expect, it } from "vitest";
import { createIMessageThrottledDropDiagnosticCache } from "./drop-diagnostic-cache.js";

describe("createIMessageThrottledDropDiagnosticCache", () => {
  it("evicts the least recently used conversation after 512 entries", () => {
    const cache = createIMessageThrottledDropDiagnosticCache();

    for (let index = 0; index < 512; index += 1) {
      expect(cache.check(`conversation-${index}`)).toBe(false);
    }
    expect(cache.check("conversation-0")).toBe(true);
    expect(cache.check("conversation-512")).toBe(false);

    expect(cache.size()).toBe(512);
    expect(cache.check("conversation-0")).toBe(true);
    expect(cache.check("conversation-1")).toBe(false);
  });
});
