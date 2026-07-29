import { describe, expect, it } from "vitest";
import {
  countSessionToolOverrides,
  nextBooleanToolOverrides,
  nextWebSearchToolOverrides,
  resolveToolOverrideState,
  sessionToolOverrideNames,
} from "./tool-overrides.ts";

describe("session tool overrides", () => {
  it("resolves sparse booleans against their base state", () => {
    expect(resolveToolOverrideState(true, undefined)).toBe(true);
    expect(resolveToolOverrideState(false, undefined)).toBe(false);
    expect(resolveToolOverrideState(true, false)).toBe(false);
    expect(resolveToolOverrideState(false, true)).toBe(true);
  });

  it("adds and removes named overrides without disturbing sibling groups", () => {
    const current = {
      mcpServers: { github: false },
      mcpToolsDeny: { notion: ["delete_page"] },
      webSearch: false,
    };
    expect(nextBooleanToolOverrides(current, "skills", "release", false, true)).toEqual({
      ...current,
      skills: { release: false },
    });
    expect(nextBooleanToolOverrides(current, "mcpServers", "github", true, true)).toEqual({
      mcpToolsDeny: { notion: ["delete_page"] },
      webSearch: false,
    });
    expect(current).toEqual({
      mcpServers: { github: false },
      mcpToolsDeny: { notion: ["delete_page"] },
      webSearch: false,
    });
  });

  it("restores default-on web search by removing the key", () => {
    const off = nextWebSearchToolOverrides({ skills: { docs: true } }, false);
    expect(off).toEqual({ skills: { docs: true }, webSearch: false });
    expect(nextWebSearchToolOverrides(off, true)).toEqual({ skills: { docs: true } });
    expect(nextWebSearchToolOverrides({}, true, false)).toEqual({ webSearch: true });
    expect(nextWebSearchToolOverrides({ webSearch: true }, false, false)).toEqual({});
  });

  it("counts override categories and returns deterministic tooltip names", () => {
    const overrides = {
      mcpServers: { zeta: false, alpha: true },
      mcpToolsDeny: { tools: ["danger"] },
      skills: { beta: false },
      webSearch: false,
    };
    expect(countSessionToolOverrides(overrides)).toBe(5);
    expect(sessionToolOverrideNames(overrides, "Web search")).toEqual([
      "alpha",
      "beta",
      "tools",
      "Web search",
      "zeta",
    ]);
  });
});
