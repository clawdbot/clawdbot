import { describe, expect, it } from "vitest";
import {
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
