// @vitest-environment node
import { describe, expect, it } from "vitest";
import { matchesNodeSearch, parseConfigSearchQuery } from "./config-form.search.ts";

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

  it("searches array item schemas before entries exist", () => {
    const matched = matchesNodeSearch({
      schema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description: "Credential source for outgoing requests",
            },
          },
        },
      },
      value: [],
      path: ["headers"],
      hints: {},
      criteria: parseConfigSearchQuery("credential source"),
    });

    expect(matched).toBe(true);
  });

  it.each([
    { values: [], query: "secondary endpoint" },
    { values: ["primary"], query: "secondary endpoint" },
    { values: [], query: "overflow endpoint" },
    { values: ["primary"], query: "overflow endpoint" },
  ])("searches positional and typed-tail schemas for $values", ({ values, query }) => {
    const matched = matchesNodeSearch({
      schema: {
        type: "array",
        items: [
          { type: "string", description: "Primary endpoint" },
          { type: "string", description: "Secondary endpoint" },
        ],
        additionalItems: { type: "string", description: "Overflow endpoint" },
      },
      value: values,
      path: ["endpoints"],
      hints: {},
      criteria: parseConfigSearchQuery(query),
    });

    expect(matched).toBe(true);
  });

  it.each(["composed secondary", "composed overflow"])(
    "searches %s array schemas declared through allOf",
    (query) => {
      const matched = matchesNodeSearch({
        schema: {
          type: "array",
          items: [{ type: "string", description: "Outer endpoint" }],
          allOf: [
            {
              items: [{}, { type: "string", description: "Composed secondary endpoint" }],
              additionalItems: { type: "string", description: "Composed overflow endpoint" },
            },
          ],
        },
        value: [],
        path: ["endpoints"],
        hints: {},
        criteria: parseConfigSearchQuery(query),
      });

      expect(matched).toBe(true);
    },
  );

  it("does not search tuple positions forbidden by an allOf branch", () => {
    const matched = matchesNodeSearch({
      schema: {
        type: "array",
        allOf: [
          {
            items: [{ type: "string", description: "Reachable endpoint" }],
            additionalItems: false,
          },
          {
            items: [{}, { type: "string", description: "Impossible endpoint" }],
          },
        ],
      },
      value: [],
      path: ["endpoints"],
      hints: {},
      criteria: parseConfigSearchQuery("impossible endpoint"),
    });

    expect(matched).toBe(false);
  });

  it("searches additional-property schemas before entries exist", () => {
    const matched = matchesNodeSearch({
      schema: {
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            url: {
              type: "string",
            },
          },
        },
      },
      value: {},
      path: ["servers"],
      hints: {
        "servers.*.url": {
          help: "Endpoint used by the remote service",
        },
      },
      criteria: parseConfigSearchQuery("remote service"),
    });

    expect(matched).toBe(true);
  });
});
