// Command path match tests cover CLI command path matching and normalization.
import { describe, expect, it } from "vitest";
import {
  matchesAnyCommandPath,
  matchesCommandPath,
  matchesCommandPathRule,
} from "./command-path-matches.js";

describe("command-path-matches", () => {
  it("matches prefix and exact command paths", () => {
    expect(matchesCommandPath(["status"], ["status"])).toBe(true);
    expect(matchesCommandPath(["status", "watch"], ["status"])).toBe(true);
    expect(matchesCommandPath(["status", "watch"], ["status"], { exact: true })).toBe(false);
    expect(matchesCommandPath(["config", "get"], ["config", "get"], { exact: true })).toBe(true);
  });

  it("matches declarative rules", () => {
    expect(matchesCommandPathRule(["plugins", "update"], ["plugins"])).toBe(true);
    expect(
      matchesCommandPathRule(["plugins", "update"], {
        pattern: ["plugins", "update"],
        exact: true,
      }),
    ).toBe(true);
    expect(
      matchesCommandPathRule(["plugins", "update", "now"], {
        pattern: ["plugins", "update"],
        exact: true,
      }),
    ).toBe(false);
  });

  it("treats structured rules without exact as prefix matches", () => {
    expect(
      matchesCommandPathRule(["plugins", "update", "now"], {
        pattern: ["plugins", "update"],
      }),
    ).toBe(true);
  });

  it("matches any command path from a rule set", () => {
    expect(
      matchesAnyCommandPath(
        ["config", "schema"],
        [["backup"], { pattern: ["config", "schema"], exact: true }],
      ),
    ).toBe(true);
    expect(
      matchesAnyCommandPath(
        ["message", "send"],
        [["status"], { pattern: ["config", "schema"], exact: true }],
      ),
    ).toBe(false);
  });
});
