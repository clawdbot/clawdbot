// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  countSessionToolOverrides,
  nextBooleanToolOverrides,
  nextMcpToolsDenyOverrides,
  nextWebSearchToolOverrides,
  readOwnEntry,
  resolveToolOverrideState,
} from "./tool-overrides.ts";

describe("session tool overrides", () => {
  it("resolves sparse booleans against their base state", () => {
    expect(resolveToolOverrideState(true, undefined)).toBe(true);
    expect(resolveToolOverrideState(false, undefined)).toBe(false);
    expect(resolveToolOverrideState(true, false)).toBe(false);
    expect(resolveToolOverrideState(false, true)).toBe(true);
  });

  it("reads only own dynamic-key entries", () => {
    expect(readOwnEntry({ github: false }, "constructor")).toBeUndefined();
    expect(readOwnEntry({ constructor: false }, "constructor")).toBe(false);
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

  it("adds sorted MCP tool denials without mutating sibling overrides", () => {
    const current = {
      mcpToolsDeny: { github: ["zebra"], notion: ["delete_page"] },
      webSearch: false,
    };
    expect(nextMcpToolsDenyOverrides(current, "github", "alpha", true)).toEqual({
      mcpToolsDeny: { github: ["alpha", "zebra"], notion: ["delete_page"] },
      webSearch: false,
    });
    expect(current.mcpToolsDeny.github).toEqual(["zebra"]);
  });

  it("removes MCP tool denials and keeps the map sparse", () => {
    expect(
      nextMcpToolsDenyOverrides(
        { mcpToolsDeny: { github: ["read", "write"], notion: ["delete_page"] } },
        "github",
        "read",
        false,
      ),
    ).toEqual({ mcpToolsDeny: { github: ["write"], notion: ["delete_page"] } });
    expect(
      nextMcpToolsDenyOverrides(
        { mcpToolsDeny: { github: ["write"], notion: ["delete_page"] } },
        "github",
        "write",
        false,
      ),
    ).toEqual({ mcpToolsDeny: { notion: ["delete_page"] } });
    expect(
      nextMcpToolsDenyOverrides({ mcpToolsDeny: { github: ["write"] } }, "github", "write", false),
    ).toEqual({});
  });

  it("treats constructor as an own MCP server key", () => {
    expect(
      nextMcpToolsDenyOverrides(
        { mcpToolsDeny: { github: ["read"] } },
        "constructor",
        "inspect",
        true,
      ),
    ).toEqual({
      mcpToolsDeny: { constructor: ["inspect"], github: ["read"] },
    });
  });

  it.each(["mcpServers", "skills"] as const)("treats hasOwnProperty as an own %s key", (group) => {
    expect(nextBooleanToolOverrides({}, group, "hasOwnProperty", false, true)).toEqual({
      [group]: { hasOwnProperty: false },
    });
  });

  it("counts override categories", () => {
    const overrides = {
      mcpServers: { zeta: false, alpha: true },
      mcpToolsDeny: { tools: ["danger"] },
      skills: { beta: false },
      webSearch: false,
    };
    expect(countSessionToolOverrides(overrides)).toBe(5);
  });
});
