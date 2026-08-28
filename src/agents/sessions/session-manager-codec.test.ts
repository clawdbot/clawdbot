import { describe, expect, it } from "vitest";
import {
  buildSessionContext,
  isIndexedSessionEntry,
  parseOpaqueLeafEntry,
  parseParentLinkedOpaqueEntry,
} from "./session-manager-codec.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";

describe("session manager codec compatibility", () => {
  it("backfills current-version hook messages persisted without a custom type", () => {
    const manager = SessionManager.fromEntries([
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "persisted-hook-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp",
      },
      {
        type: "message",
        id: "persisted-hook-message",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "custom", content: "persisted hook context" },
      },
    ]);

    expect(manager.getEntry("persisted-hook-message")).toMatchObject({
      message: { role: "custom", customType: "hook", content: "persisted hook context" },
    });
  });

  it.each([
    {
      name: "message with malformed content",
      entry: { type: "message", id: "m1", parentId: null, message: { role: "user" } },
    },
    {
      name: "compaction without a kept entry",
      entry: { type: "compaction", id: "c1", parentId: null, summary: "", tokensBefore: 1 },
    },
    {
      name: "partial model change",
      entry: { type: "model_change", id: "model1", parentId: null, provider: "openai" },
    },
  ])("rejects an indexed $name", ({ entry }) => {
    expect(isIndexedSessionEntry(entry)).toBe(false);
  });

  it.each([
    { name: "singleton", reason: ["reset"] },
    { name: "nested singleton", reason: [["reset"]] },
  ])("preserves a $name legacy reset reason", ({ reason }) => {
    const manager = SessionManager.fromEntries([
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: "legacy-reset-session",
        timestamp: "2026-01-01T00:00:00.000Z",
        cwd: "/tmp",
      },
      {
        type: "message",
        id: "before-reset",
        parentId: null,
        message: { role: "user", content: "before" },
      },
      { type: "reset", id: "legacy-reset", parentId: "before-reset", reason },
      {
        type: "message",
        id: "after-reset",
        parentId: "legacy-reset",
        message: { role: "user", content: "after" },
      },
    ]);

    expect(manager.getEntry("legacy-reset")).toBeDefined();
    const context = JSON.stringify(manager.buildSessionContext());
    expect(context).not.toContain("before");
    expect(context).toContain("after");
  });

  it("returns instead of looping when the parent chain forms a cycle", () => {
    // buildSessionContext walks parentId links directly off the map it is given, so a
    // caller that hands it a cycle drives the walk forever. Every other parent-chain walk
    // in this directory already guards against that -- getBranch
    // (session-manager-entries.ts), resolveCanonicalParentId (session-manager-core.ts),
    // and the branch walk in session-manager-branching.ts all carry a visited set.
    const entries = [
      {
        type: "message",
        id: "cyc-a",
        parentId: "cyc-b",
        message: { role: "user", content: "first" },
      },
      {
        type: "message",
        id: "cyc-b",
        parentId: "cyc-a",
        message: { role: "user", content: "second" },
      },
    ] as unknown as Parameters<typeof buildSessionContext>[0];
    const byId = new Map(entries.map((entry) => [entry.id, entry]));

    const context = buildSessionContext(entries, "cyc-a", byId);

    // Terminating at all is the assertion. Each entry is visited at most once, so the
    // walk yields the cycle members and stops rather than growing the path forever.
    expect(context.messages.length).toBeLessThanOrEqual(2);
  }, 5_000);

  it("parses opaque tree links without widening their variants", () => {
    expect(parseParentLinkedOpaqueEntry({ type: "future", id: "f1", parentId: null })).toEqual({
      id: "f1",
      parentId: null,
    });
    expect(parseParentLinkedOpaqueEntry({ id: "untyped", parentId: "f1" })).toEqual({
      id: "untyped",
      parentId: "f1",
    });
    expect(
      parseOpaqueLeafEntry({ type: "leaf", id: "leaf1", parentId: null, targetId: null }),
    ).toEqual({ id: "leaf1", parentId: null, targetId: null });
    expect(parseOpaqueLeafEntry({ type: "leaf", id: "leaf1", parentId: null })).toBeUndefined();
  });
});
