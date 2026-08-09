import { describe, expect, it } from "vitest";
import { resolveRememberAcrossConversations } from "./config-utils.js";

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
