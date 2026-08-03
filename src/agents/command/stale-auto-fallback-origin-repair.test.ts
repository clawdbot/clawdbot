import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  replaceSessionEntrySync,
  loadSessionEntryReadOnly,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { repairStaleAutoFallbackOriginOverride } from "./stale-auto-fallback-origin-repair.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeSessionEntry(params: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 1_000,
    providerOverride: "anthropic",
    modelOverride: "claude-fallback",
    modelOverrideSource: "auto",
    modelOverrideFallbackOriginProvider: "anthropic",
    modelOverrideFallbackOriginModel: "claude-failed",
    ...params,
  };
}

describe("repairStaleAutoFallbackOriginOverride", () => {
  it("repairs a polluted origin and clears the override atomically", async () => {
    const sessionKey = "agent:main:telegram:123";
    const sessionStore: Record<string, SessionEntry> = {};
    const storePath = path.join(tempDirs.make("repair-store"), "sessions.json");
    replaceSessionEntrySync({ storePath, sessionKey }, makeSessionEntry());
    // Use the canonical persisted snapshot as the observed state so updatedAt matches.
    const sessionEntry = await loadSessionEntryReadOnly({ storePath, sessionKey });
    if (!sessionEntry) {
      throw new Error("session entry not loaded");
    }
    sessionStore[sessionKey] = sessionEntry;

    const result = await repairStaleAutoFallbackOriginOverride({
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      primaryProvider: "openai",
      primaryModel: "gpt-5.5",
    });

    expect(result.entry.providerOverride).toBeUndefined();
    expect(result.entry.modelOverride).toBeUndefined();
    expect(result.entry.modelOverrideSource).toBeUndefined();
    expect(result.hasStoredOverride).toBe(false);
  });

  it("does not repair when the persisted entry has changed concurrently", async () => {
    const sessionKey = "agent:main:telegram:123";
    const sessionStore: Record<string, SessionEntry> = {};
    const storePath = path.join(tempDirs.make("repair-store"), "sessions.json");
    replaceSessionEntrySync({ storePath, sessionKey }, makeSessionEntry());
    const sessionEntry = await loadSessionEntryReadOnly({ storePath, sessionKey });
    if (!sessionEntry) {
      throw new Error("session entry not loaded");
    }
    sessionStore[sessionKey] = sessionEntry;

    // Concurrent update keeps the stale origin but switches to a user override and
    // bumps updatedAt. The repair must be rejected.
    const concurrentEntry: SessionEntry = {
      ...sessionEntry,
      modelOverrideSource: "user",
      updatedAt: sessionEntry.updatedAt + 1,
    };
    replaceSessionEntrySync({ storePath, sessionKey }, concurrentEntry);

    const result = await repairStaleAutoFallbackOriginOverride({
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      primaryProvider: "openai",
      primaryModel: "gpt-5.5",
    });

    expect(result.entry.modelOverrideSource).toBe("user");
    expect(result.entry.modelOverrideFallbackOriginProvider).toBe("anthropic");
    expect(result.entry.modelOverrideFallbackOriginModel).toBe("claude-failed");
    expect(result.hasStoredOverride).toBe(true);
  });

  it("leaves non-stale origins untouched", async () => {
    const sessionKey = "agent:main:telegram:123";
    const sessionStore: Record<string, SessionEntry> = {};
    const sessionEntry = makeSessionEntry({
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "gpt-5.5",
    });
    sessionStore[sessionKey] = sessionEntry;

    const result = await repairStaleAutoFallbackOriginOverride({
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath: undefined,
      primaryProvider: "openai",
      primaryModel: "gpt-5.5",
    });

    expect(result.entry).toBe(sessionEntry);
  });
});
