// @vitest-environment node
import { describe, expect, it } from "vitest";
import { matchesNodeSearch, parseConfigSearchQuery } from "./config-form.node.ts";

const schema = {
  type: "object",
  properties: {
    gateway: {
      type: "object",
      properties: {
        auth: {
          type: "object",
          properties: {
            token: { type: "string" },
          },
        },
      },
    },
    mode: {
      type: "string",
      enum: ["off", "token"],
    },
  },
};

describe("config form search", () => {
  it("parses tag-prefixed query terms", () => {
    const parsed = parseConfigSearchQuery("token tag:security tag:Auth");
    expect(parsed.text).toBe("token");
    expect(parsed.tags).toEqual(["security", "auth"]);
  });

  it("matches fields by tag through ui hints", () => {
    const parsed = parseConfigSearchQuery("tag:security");
    const matched = matchesNodeSearch({
      schema: schema.properties.gateway,
      value: {},
      path: ["gateway"],
      hints: {
        "gateway.auth.token": { tags: ["security", "secret"] },
      },
      criteria: parsed,
    });
    expect(matched).toBe(true);
  });

  it("requires text and tag when combined", () => {
    const positive = matchesNodeSearch({
      schema: schema.properties.gateway,
      value: {},
      path: ["gateway"],
      hints: {
        "gateway.auth.token": { tags: ["security"] },
      },
      criteria: parseConfigSearchQuery("token tag:security"),
    });
    expect(positive).toBe(true);

    const negative = matchesNodeSearch({
      schema: schema.properties.gateway,
      value: {},
      path: ["gateway"],
      hints: {
        "gateway.auth.token": { tags: ["security"] },
      },
      criteria: parseConfigSearchQuery("mode tag:security"),
    });
    expect(negative).toBe(false);
  });
});
