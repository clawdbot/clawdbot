import { describe, expect, it } from "vitest";
import { resolveRememberAcrossConversations, splitShellArgs } from "./config-utils.js";

describe("splitShellArgs", () => {
  it("preserves quoted command arguments through the focused re-export", () => {
    expect(splitShellArgs('qmd query --collection "Project Notes"')).toEqual([
      "qmd",
      "query",
      "--collection",
      "Project Notes",
    ]);
  });
});

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
