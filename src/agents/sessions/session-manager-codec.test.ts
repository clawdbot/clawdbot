import { describe, expect, it } from "vitest";
import { migrateSessionEntries } from "./session-manager-codec.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";

describe("session manager codec compatibility", () => {
  it("leaves header-less canonical transcripts untouched instead of renumbering them as v1", () => {
    const entries = [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:01.000Z",
        message: { role: "user", content: "hello" },
      },
      {
        type: "leaf",
        id: "leaf-1",
        parentId: "user-1",
        targetId: "user-1",
        timestamp: "2026-01-01T00:00:02.000Z",
      },
    ] as never;

    migrateSessionEntries(entries);

    expect(entries).toEqual([
      expect.objectContaining({ id: "user-1", parentId: null }),
      expect.objectContaining({ id: "leaf-1", parentId: "user-1", targetId: "user-1" }),
    ]);
  });

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
});
