// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SessionUnreadPatchGuard } from "./unread.ts";

describe("SessionUnreadPatchGuard", () => {
  it("patches an unread active session only once per unread episode", () => {
    const guard = new SessionUnreadPatchGuard();
    expect(guard.shouldPatch("agent:main:a", true)).toBe(true);
    expect(guard.shouldPatch("agent:main:a", true)).toBe(false);
    expect(guard.shouldPatch("agent:main:a", false)).toBe(false);
  });

  it("unlatches after a failed patch so later snapshots retry", () => {
    const guard = new SessionUnreadPatchGuard();
    expect(guard.shouldPatch("agent:main:a", true)).toBe(true);
    guard.patchFailed("agent:main:a");
    expect(guard.shouldPatch("agent:main:a", true)).toBe(true);
    // Failures for another session leave the current episode latched.
    guard.patchFailed("agent:main:b");
    expect(guard.shouldPatch("agent:main:a", true)).toBe(false);
  });

  it("re-acknowledges when new activity flags the open session unread again", () => {
    const guard = new SessionUnreadPatchGuard();
    expect(guard.shouldPatch("agent:main:a", true)).toBe(true);
    // Server confirms the read, then a background run completes.
    expect(guard.shouldPatch("agent:main:a", false)).toBe(false);
    expect(guard.shouldPatch("agent:main:a", true)).toBe(true);
    expect(guard.shouldPatch("agent:main:a", true)).toBe(false);
  });

  it("does not patch read sessions and resets after changing sessions", () => {
    const guard = new SessionUnreadPatchGuard();
    expect(guard.shouldPatch("agent:main:a", false)).toBe(false);
    expect(guard.shouldPatch("agent:main:a", true)).toBe(true);
    expect(guard.shouldPatch("agent:main:b", true)).toBe(true);
    expect(guard.shouldPatch("agent:main:a", true)).toBe(true);
  });
});
