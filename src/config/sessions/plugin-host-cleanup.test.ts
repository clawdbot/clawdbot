import { describe, expect, it } from "vitest";
import { matchesPluginHostCleanupSession } from "./plugin-host-cleanup.js";
import type { SessionEntry } from "./types.js";

const entry = (sessionId: string): SessionEntry => ({
  sessionId,
  updatedAt: 1,
});

describe("matchesPluginHostCleanupSession", () => {
  it("keeps ordinary session-key matching case-insensitive", () => {
    expect(
      matchesPluginHostCleanupSession(
        "agent:MAIN:telegram:group:ROOM",
        entry("runtime-session"),
        "agent:main:telegram:group:room",
      ),
    ).toBe(true);
    expect(
      matchesPluginHostCleanupSession(
        "agent:main:main",
        entry("Runtime-Session"),
        "runtime-session",
      ),
    ).toBe(true);
  });

  it("does not match case-distinct Matrix room ids", () => {
    const target = "agent:main:matrix:group:!Room:server";
    const sibling = "agent:main:matrix:group:!room:server";

    expect(matchesPluginHostCleanupSession(target, entry("target"), target)).toBe(true);
    expect(matchesPluginHostCleanupSession(sibling, entry("sibling"), target)).toBe(false);
  });

  it("does not match case-distinct Signal group ids", () => {
    const target = "agent:main:signal:group:AbCdEf==";
    const sibling = "agent:main:signal:group:abcdef==";

    expect(matchesPluginHostCleanupSession(target, entry("target"), target)).toBe(true);
    expect(matchesPluginHostCleanupSession(sibling, entry("sibling"), target)).toBe(false);
  });
});
