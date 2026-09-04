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

  it("inherits the most specific ancestor hint when requested", () => {
    const match = findWildcardHintMatch({
      uiHints: {
        "plugins.entries.*.config.headers": { sensitive: true },
        "plugins.entries.*.config.headers.*": {},
        "plugins.entries.codex.config.headers.Public": { sensitive: false },
      },
      path: "plugins.entries.codex.config.headers.Authorization",
      splitPath: (value) => value.split("."),
      includeAncestors: true,
      acceptHint: (hint) => hint.sensitive !== undefined,
    });

    expect(match).toEqual({
      path: "plugins.entries.*.config.headers",
      hint: { sensitive: true },
    });
    expect(
      findWildcardHintMatch({
        uiHints: {
          "plugins.entries.*.config.headers": { sensitive: true },
          "plugins.entries.*.config.headers.*": {},
          "plugins.entries.codex.config.headers.Public": { sensitive: false },
        },
        path: "plugins.entries.codex.config.headers.Public",
        splitPath: (value) => value.split("."),
        includeAncestors: true,
        acceptHint: (hint) => hint.sensitive !== undefined,
      }),
    ).toEqual({
      path: "plugins.entries.codex.config.headers.Public",
      hint: { sensitive: false },
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
