import { describe, expect, it } from "vitest";
import { testing } from "./agents.js";

const { cleanupIdentityEquals, cleanupIdentityFromJournal, cleanupPathIdentity } = testing;

// Regression for #137416: NTFS file ids past 2^53 must survive capture
// exactly, and the fence re-reads them exactly (bigint lstat) so deletion can
// proceed instead of throwing "exceeds the safe integer range".
describe("agent delete cleanup identity (137416)", () => {
  it("keeps safe ids as numbers (prior-release journal compatible)", () => {
    expect(cleanupPathIdentity({ dev: 1n, ino: 7n })).toEqual({ dev: 1, ino: 7 });
    expect(cleanupPathIdentity({ dev: 1, ino: 7 })).toEqual({ dev: 1, ino: 7 });
  });

  it("captures unsafe NTFS ids as null + exact strings", () => {
    expect(cleanupPathIdentity({ dev: 1n, ino: 9007199254740993n })).toEqual({
      dev: 1,
      ino: null,
      inoStr: "9007199254740993",
    });
    expect(cleanupPathIdentity({ dev: 9007199254740993n, ino: 7n })).toEqual({
      dev: null,
      devStr: "9007199254740993",
      ino: 7,
    });
  });

  it("returns null when identity parts are missing", () => {
    expect(cleanupPathIdentity(undefined)).toBeNull();
    expect(cleanupPathIdentity({ dev: 1n })).toBeNull();
  });

  it("matches an exact re-read of an unsafe NTFS id", () => {
    // The fence re-reads unsafe prepared ids with bigint lstat, so both sides
    // are exact here — never the rounded number-valued fs-safe stat.
    const prepared = cleanupPathIdentity({ dev: 1n, ino: 9007199254740993n });
    const fresh = cleanupPathIdentity({ dev: 1n, ino: 9007199254740993n });
    expect(prepared).not.toBeNull();
    expect(fresh).not.toBeNull();
    expect(cleanupIdentityEquals(prepared!, fresh!)).toBe(true);
  });

  it("still rejects a rounded number recheck of an unsafe id (fail closed)", () => {
    // 9007199254740993n rounds to 9007199254740992 as a double; the fence
    // always re-reads exactly (a failed re-read is a retryable failure, never
    // a rounded fallback), and this comparison must NOT match regardless.
    const prepared = cleanupPathIdentity({ dev: 1n, ino: 9007199254740993n });
    expect(prepared).not.toBeNull();
    expect(cleanupIdentityEquals(prepared!, { dev: 1, ino: 9007199254740992 })).toBe(false);
  });

  it("compares safe ids across number/bigint journal forms", () => {
    expect(
      cleanupIdentityEquals({ dev: 1, ino: 7 }, cleanupPathIdentity({ dev: 1n, ino: 7n })!),
    ).toBe(true);
    expect(cleanupIdentityEquals({ dev: 1, ino: 100 }, { dev: 1, ino: 200 })).toBe(false);
  });

  it("rejects a substituted path whose id rounds to the same double", () => {
    // 9007199254740993 and 9007199254740992 are distinct file ids that
    // collapse to one IEEE-754 number; the fence must tell them apart.
    expect(
      cleanupIdentityEquals(
        { dev: 1, ino: null, inoStr: "9007199254740993" },
        { dev: 1, ino: null, inoStr: "9007199254740992" },
      ),
    ).toBe(false);
  });

  it("round-trips mixed journal identities through JSON", () => {
    const prepared = cleanupPathIdentity({ dev: 1n, ino: 9007199254740993n });
    const journaled = structuredClone(prepared);
    expect(journaled).toEqual(prepared);
    // Safe stays numeric, the unsafe part is null + exact string: dev/ino are
    // always old-reader values, the exact id rides on inoStr.
    expect(typeof journaled?.dev).toBe("number");
    expect(journaled?.ino).toBeNull();
    expect(journaled?.inoStr).toBe("9007199254740993");
    expect(JSON.stringify(prepared)).toBe('{"dev":1,"ino":null,"inoStr":"9007199254740993"}');
  });

  it("keeps absent and unsafe journal identities apart on read-back", () => {
    // Legacy absent identity (nulls, no exact strings) stays adopt-on-recheck.
    expect(
      cleanupIdentityFromJournal({
        path: "/p",
        canonicalPath: "/p",
        parentPath: "/",
        kind: "target",
        sourcePaths: ["/p"],
        dev: null,
        ino: null,
        coversDescendants: true,
        done: false,
      }),
    ).toBeNull();
    // Unsafe identity (null + exact strings) survives the round trip exactly.
    expect(
      cleanupIdentityFromJournal({
        path: "/p",
        canonicalPath: "/p",
        parentPath: "/",
        kind: "target",
        sourcePaths: ["/p"],
        dev: 1,
        ino: null,
        inoStr: "9007199254740993",
        coversDescendants: true,
        done: false,
      }),
    ).toEqual({ dev: 1, ino: null, inoStr: "9007199254740993" });
  });
});

// Backward-compat contract for PR #137935: journals written by the new code
// must still parse with the pre-137416 parseCleanupPaths (v2026.8.2), which
// only accepts number|null dev/ino and throws on strings. That old validator
// checks known fields with && only, so unknown fields (devStr/inoStr) are
// ignored. The predicate below is a verbatim copy of the old per-entry check
// (src/state/agent-deletion-journal.ts @ HEAD~1) to pin both facts.
function oldCleanupPathEntryValid(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    typeof (entry as { path?: unknown }).path === "string" &&
    typeof (entry as { canonicalPath?: unknown }).canonicalPath === "string" &&
    typeof (entry as { parentPath?: unknown }).parentPath === "string" &&
    ((entry as { kind?: unknown }).kind === "target" ||
      (entry as { kind?: unknown }).kind === "symlink") &&
    ((entry as { dev?: unknown }).dev === null ||
      typeof (entry as { dev?: unknown }).dev === "number") &&
    ((entry as { ino?: unknown }).ino === null ||
      typeof (entry as { ino?: unknown }).ino === "number") &&
    typeof (entry as { coversDescendants?: unknown }).coversDescendants === "boolean" &&
    typeof (entry as { done?: unknown }).done === "boolean" &&
    ((entry as { note?: unknown }).note === undefined ||
      typeof (entry as { note?: unknown }).note === "string") &&
    Array.isArray((entry as { sourcePaths?: unknown }).sourcePaths) &&
    (entry as { sourcePaths: unknown[] }).sourcePaths.every(
      (sourcePath) => typeof sourcePath === "string",
    )
  );
}

function oldParseCleanupPaths(value: string): unknown[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every(oldCleanupPathEntryValid)) {
    throw new Error("Invalid agent deletion cleanup path journal.");
  }
  return parsed;
}

describe("agent delete journal backward compat (137935)", () => {
  const baseEntry = {
    path: "/p",
    canonicalPath: "/p",
    parentPath: "/",
    kind: "target",
    sourcePaths: ["/p"],
    coversDescendants: true,
    done: false,
  };

  it("old parser ignores the new devStr/inoStr fields", () => {
    expect(() =>
      oldParseCleanupPaths(
        JSON.stringify([{ ...baseEntry, dev: 1, ino: 7, devStr: "1", inoStr: "7" }]),
      ),
    ).not.toThrow();
  });

  it("old parser accepts the new unsafe-id shape (null + exact strings)", () => {
    // This is exactly what the new writer emits for ids past 2^53.
    expect(() =>
      oldParseCleanupPaths(
        JSON.stringify([{ ...baseEntry, dev: 1, ino: null, inoStr: "9007199254740993" }]),
      ),
    ).not.toThrow();
  });

  it("old parser throws on string dev/ino (why the new shape exists)", () => {
    expect(() =>
      oldParseCleanupPaths(JSON.stringify([{ ...baseEntry, dev: 1, ino: "9007199254740993" }])),
    ).toThrow("Invalid agent deletion cleanup path journal.");
  });

  it("new unsafe-id journals keep exact comparison working", () => {
    const prepared = cleanupIdentityFromJournal({
      ...baseEntry,
      kind: "target",
      sourcePaths: ["/p"],
      dev: 1,
      ino: null,
      inoStr: "9007199254740993",
      coversDescendants: true,
      done: false,
    });
    expect(prepared).not.toBeNull();
    // Exact re-read matches; a distinct id that rounds to the same double does not.
    expect(
      cleanupIdentityEquals(prepared!, { dev: 1, ino: null, inoStr: "9007199254740993" }),
    ).toBe(true);
    expect(
      cleanupIdentityEquals(prepared!, { dev: 1, ino: null, inoStr: "9007199254740992" }),
    ).toBe(false);
    expect(cleanupIdentityEquals(prepared!, { dev: 1, ino: 9007199254740992 })).toBe(false);
  });
});
