import { describe, expect, it } from "vitest";
import { resolveMarkdownTableMode } from "./markdown-tables.js";

describe("resolveMarkdownTableMode", () => {
  it("defaults Slack tables to bullets", () => {
    expect(resolveMarkdownTableMode({ cfg: {}, channel: "slack", accountId: "default" })).toBe(
      "bullets",
    );
  });

  it("allows Slack table mode overrides", () => {
    expect(
      resolveMarkdownTableMode({
        cfg: { channels: { slack: { markdown: { tables: "code" } } } },
        channel: "slack",
        accountId: "default",
      }),
    ).toBe("code");
  });
});
