import { describe, expect, it } from "vitest";
import { normalizeDiscordDisplaySlug, normalizeDiscordSlug } from "./allow-list.js";

describe("discord slug normalization", () => {
  it("keeps config slugs ASCII-only", () => {
    expect(normalizeDiscordSlug("\uC2E4\uD5D8")).toBe("");
    expect(normalizeDiscordSlug("baseline-\uAC80\uC99D")).toBe("baseline");
  });

  it("preserves Unicode in display slugs", () => {
    expect(normalizeDiscordDisplaySlug("\uC2E4\uD5D8")).toBe("\uC2E4\uD5D8");
    expect(normalizeDiscordDisplaySlug("baseline-\uAC80\uC99D")).toBe("baseline-\uAC80\uC99D");
  });
});
