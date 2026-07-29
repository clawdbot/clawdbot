// Covers shared config schema fragments and defaults.
import { describe, expect, it } from "vitest";
import { findWildcardHintMatch, schemaHasChildren } from "./schema.shared.js";

describe("schema.shared", () => {
  it("prefers the most specific wildcard hint match", () => {
    const match = findWildcardHintMatch({
      uiHints: {
        "channels.*.token": { label: "wildcard" },
        "channels.telegram.token": { label: "telegram" },
      },
      path: "channels.telegram.token",
      splitPath: (value) => value.split("."),
    });

    expect(match).toEqual({
      path: "channels.telegram.token",
      hint: { label: "telegram" },
    });
  });

  it("treats branch schemas as having children", () => {
    expect(
      schemaHasChildren({
        oneOf: [{}, { properties: { token: {} } }],
      }),
    ).toBe(true);
  });
});
