// Allowlist resolve utility tests cover channel allowlist lookup and config matching helpers.
import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import {
  addAllowlistUserEntriesFromConfigEntry,
  buildAllowlistResolutionSummary,
  canonicalizeAllowlistWithResolvedIds,
  patchAllowlistUsersInConfigEntries,
  summarizeMapping,
} from "./resolve-utils.js";

describe("buildAllowlistResolutionSummary", () => {
  it("returns mapping, additions, and unresolved (including missing ids)", () => {
    const resolvedUsers = [
      { input: "a", resolved: true, id: "1" },
      { input: "b", resolved: false },
      { input: "c", resolved: true },
    ];
    const result = buildAllowlistResolutionSummary(resolvedUsers);
    expect(result.mapping).toEqual(["a→1"]);
    expect(result.additions).toEqual(["1"]);
    expect(result.unresolved).toEqual(["b", "c"]);
  });

  it("omits identity lookups from the logged mapping but keeps their additions", () => {
    const resolvedUsers = [
      { input: "42", resolved: true, id: "42" },
      { input: "alice", resolved: true, id: "1" },
    ];
    const result = buildAllowlistResolutionSummary(resolvedUsers);
    expect(result.mapping).toEqual(["alice→1"]);
    expect(result.additions).toEqual(["42", "1"]);
  });

  it("supports custom resolved formatting", () => {
    const resolvedUsers = [{ input: "a", resolved: true, id: "1", note: "x" }];
    const result = buildAllowlistResolutionSummary(resolvedUsers, {
      formatResolved: (entry) =>
        `${entry.input}→${entry.id}${(entry as { note?: string }).note ? " (note)" : ""}`,
    });
    expect(result.mapping).toEqual(["a→1 (note)"]);
  });

  it("supports custom unresolved formatting", () => {
    const resolvedUsers = [{ input: "a", resolved: false, note: "missing" }];
    const result = buildAllowlistResolutionSummary(resolvedUsers, {
      formatUnresolved: (entry) =>
        `${entry.input}${(entry as { note?: string }).note ? " (missing)" : ""}`,
    });
    expect(result.unresolved).toEqual(["a (missing)"]);
  });
});

describe("addAllowlistUserEntriesFromConfigEntry", () => {
  it("adds trimmed users and skips '*' and blanks", () => {
    const target = new Set<string>();
    addAllowlistUserEntriesFromConfigEntry(target, { users: ["  a  ", "*", "", "b"] });
    expect(Array.from(target).toSorted()).toEqual(["a", "b"]);
  });

  it("ignores non-objects", () => {
    const target = new Set<string>(["a"]);
    addAllowlistUserEntriesFromConfigEntry(target, null);
    expect(Array.from(target)).toEqual(["a"]);
  });
});

describe("canonicalizeAllowlistWithResolvedIds", () => {
  it("replaces resolved names with ids and keeps unresolved entries", () => {
    const resolvedMap = new Map([
      ["Alice#1234", { input: "Alice#1234", resolved: true, id: "111" }],
      ["bob", { input: "bob", resolved: false }],
    ]);
    const result = canonicalizeAllowlistWithResolvedIds({
      existing: ["Alice#1234", "bob", "222", "*"],
      resolvedMap,
    });
    expect(result).toEqual(["111", "bob", "222", "*"]);
  });

  it("deduplicates ids after canonicalization", () => {
    const resolvedMap = new Map([["alice", { input: "alice", resolved: true, id: "111" }]]);
    const result = canonicalizeAllowlistWithResolvedIds({
      existing: ["alice", "111", "alice"],
      resolvedMap,
    });
    expect(result).toEqual(["111"]);
  });
});

describe("patchAllowlistUsersInConfigEntries", () => {
  it("supports canonicalization strategy for nested users", () => {
    const entries = {
      alpha: { users: ["Alice", "111", "Bob"] },
      beta: { users: ["*"] },
    };
    const resolvedMap = new Map([
      ["Alice", { input: "Alice", resolved: true, id: "111" }],
      ["Bob", { input: "Bob", resolved: false }],
    ]);
    const patched = patchAllowlistUsersInConfigEntries({
      entries,
      resolvedMap,
      strategy: "canonicalize",
    });
    expect((patched.alpha as { users: string[] }).users).toEqual(["111", "Bob"]);
    expect((patched.beta as { users: string[] }).users).toEqual(["*"]);
  });
});

describe("summarizeMapping", () => {
  it("logs sampled resolved and unresolved entries", () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    summarizeMapping("demo allowlist", ["a", "b", "c", "d", "e", "f", "g"], ["x", "y"], runtime);

    // Separate calls per line so each gets its own timestamp/subsystem prefix.
    expect(runtime.log).toHaveBeenNthCalledWith(
      1,
      "demo allowlist resolved: a, b, c, d, e, f (+1)",
    );
    expect(runtime.log).toHaveBeenNthCalledWith(2, "demo allowlist unresolved: x, y");
  });

  it("skips logging when both lists are empty", () => {
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    summarizeMapping("demo allowlist", [], [], runtime);

    expect(runtime.log).not.toHaveBeenCalled();
  });
});
