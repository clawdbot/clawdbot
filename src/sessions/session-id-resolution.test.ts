// Session id resolution tests cover resolving aliases and explicit ids.
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  resolvePreferredSessionKeyForSessionIdMatches,
  resolveSessionIdMatchSelection,
} from "./session-id-resolution.js";

function entry(updatedAt: number, sessionId = "s1"): SessionEntry {
  return { sessionId, updatedAt };
}

describe("resolvePreferredSessionKeyForSessionIdMatches", () => {
  it("returns undefined for empty matches", () => {
    expect(resolvePreferredSessionKeyForSessionIdMatches([], "s1")).toBeUndefined();
  });

  it("returns the only match for a single-element array", () => {
    const matches: Array<[string, SessionEntry]> = [["agent:main:main", entry(10)]];
    expect(resolvePreferredSessionKeyForSessionIdMatches(matches, "s1")).toBe("agent:main:main");
  });

  it("collapses alias duplicates before resolving structural ties", () => {
    const matches: Array<[string, SessionEntry]> = [
      ["agent:main:MAIN", entry(10, "main")],
      ["agent:main:main", entry(10, "main")],
    ];

    expect(resolvePreferredSessionKeyForSessionIdMatches(matches, "main")).toBe("agent:main:main");
  });

  it("returns the freshest match when timestamps differ", () => {
    const matches: Array<[string, SessionEntry]> = [
      ["agent:main:alpha", entry(10)],
      ["agent:main:beta", entry(20)],
    ];
    expect(resolvePreferredSessionKeyForSessionIdMatches(matches, "s1")).toBe("agent:main:beta");
  });

  it("returns undefined for fuzzy-only matches with tied timestamps", () => {
    const matches: Array<[string, SessionEntry]> = [
      ["agent:main:beta", entry(10)],
      ["agent:main:alpha", entry(10)],
    ];
    expect(resolvePreferredSessionKeyForSessionIdMatches(matches, "s1")).toBeUndefined();
  });

  it("reports ambiguity for fuzzy-only matches with tied timestamps", () => {
    const matches: Array<[string, SessionEntry]> = [
      ["agent:main:beta", entry(10)],
      ["agent:main:alpha", entry(10)],
    ];

    expect(resolveSessionIdMatchSelection(matches, "s1")).toEqual({
      kind: "ambiguous",
      sessionKeys: ["agent:main:beta", "agent:main:alpha"],
    });
  });

  it("prefers the freshest structural match over a fresher fuzzy match", () => {
    const matches: Array<[string, SessionEntry]> = [
      ["agent:main:other", entry(999, "run-dup")],
      ["agent:main:acp:run-dup", entry(100, "run-dup")],
      ["agent:main:acp2:run-dup", entry(50, "run-dup")],
    ];

    expect(resolvePreferredSessionKeyForSessionIdMatches(matches, "run-dup")).toBe(
      "agent:main:acp:run-dup",
    );
  });

  it("preserves ambiguity for distinct structural ties", () => {
    const matches: Array<[string, SessionEntry]> = [
      ["agent:main:b:sid", entry(10, "sid")],
      ["agent:main:a:sid", entry(10, "sid")],
      ["agent:main:extra", entry(500, "sid")],
    ];

    expect(resolvePreferredSessionKeyForSessionIdMatches(matches, "sid")).toBeUndefined();
  });
});
