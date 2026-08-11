import { describe, expect, it } from "vitest";
import {
  normalizeConfiguredMemoryExtraPaths,
  resolveRememberAcrossConversations,
} from "./config-utils.js";

describe("resolveRememberAcrossConversations", () => {
  it("honors keyed per-agent memory overrides", () => {
    const config = {
      memory: { search: { rememberAcrossConversations: true } },
      agents: {
        entries: {
          support: { memory: { search: { rememberAcrossConversations: false } } },
        },
      },
    };

    expect(resolveRememberAcrossConversations(config, "support")).toBe(false);
  });
});

describe("normalizeConfiguredMemoryExtraPaths", () => {
  it("preserves distinct patterns and canonicalizes unpatterned objects", () => {
    expect(
      normalizeConfiguredMemoryExtraPaths([
        " notes ",
        { path: "notes" },
        { path: " notes ", pattern: " runbooks/**/*.md " },
        { path: "notes", pattern: "runbooks/**/*.md" },
        { path: "notes", pattern: "decisions/**/*.md" },
      ]),
    ).toEqual([
      "notes",
      { path: "notes", pattern: "runbooks/**/*.md" },
      { path: "notes", pattern: "decisions/**/*.md" },
    ]);
  });
});
