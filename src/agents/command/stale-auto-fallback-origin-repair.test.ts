import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { repairStaleAutoFallbackOriginOverride } from "./stale-auto-fallback-origin-repair.js";

const { replaceSessionEntrySync, loadSessionEntryReadOnly } = sessionAccessor;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeSessionEntry(params: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 1_000,
    providerOverride: "anthropic",
    modelOverride: "claude-fallback",
    modelOverrideSource: "auto",
    // Provably polluted: the recorded origin equals the fallback override itself.
    modelOverrideFallbackOriginProvider: "anthropic",
    modelOverrideFallbackOriginModel: "claude-fallback",
    ...params,
  };
}

function createConflictError(): Error {
  return Object.assign(
    new Error("SQLite session state changed while preparing session-entry.patch"),
    { name: "SqliteSessionMutationConflictError" },
  );
}

describe("repairStaleAutoFallbackOriginOverride", () => {
  it("repairs a polluted origin and clears the override atomically", async () => {
    const sessionKey = "agent:main:telegram:123";
    const sessionStore: Record<string, SessionEntry> = {};
    const storePath = path.join(tempDirs.make("repair-store"), "sessions.json");
    replaceSessionEntrySync({ storePath, sessionKey }, makeSessionEntry());
    // Use the canonical persisted snapshot as the observed state so updatedAt matches.
    const sessionEntry = loadSessionEntryReadOnly({ storePath, sessionKey });
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

  it("repairs the canonical three-distinct state by updating the origin only", async () => {
    const sessionKey = "agent:main:telegram:123";
    const sessionStore: Record<string, SessionEntry> = {};
    const storePath = path.join(tempDirs.make("repair-store"), "sessions.json");
    replaceSessionEntrySync(
      { storePath, sessionKey },
      makeSessionEntry({
        modelOverride: "claude-opus-4-7",
        modelOverrideFallbackOriginProvider: "anthropic",
        modelOverrideFallbackOriginModel: "claude-haiku-4-5",
      }),
    );
    const sessionEntry = loadSessionEntryReadOnly({ storePath, sessionKey });
    if (!sessionEntry) {
      throw new Error("session entry not loaded");
    }
    sessionStore[sessionKey] = sessionEntry;

    const result = await repairStaleAutoFallbackOriginOverride({
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      primaryProvider: "anthropic",
      primaryModel: "claude-opus-4-8",
    });

    // Override is preserved; origin is rewritten to the current primary so the
    // snap-back probe can fire on the next interval.
    expect(result.entry.providerOverride).toBe("anthropic");
    expect(result.entry.modelOverride).toBe("claude-opus-4-7");
    expect(result.entry.modelOverrideSource).toBe("auto");
    expect(result.entry.modelOverrideFallbackOriginProvider).toBe("anthropic");
    expect(result.entry.modelOverrideFallbackOriginModel).toBe("claude-opus-4-8");
    expect(result.hasStoredOverride).toBe(true);
  });

  it("does not repair when the persisted entry has changed concurrently", async () => {
    const sessionKey = "agent:main:telegram:123";
    const sessionStore: Record<string, SessionEntry> = {};
    const storePath = path.join(tempDirs.make("repair-store"), "sessions.json");
    replaceSessionEntrySync({ storePath, sessionKey }, makeSessionEntry());
    const sessionEntry = loadSessionEntryReadOnly({ storePath, sessionKey });
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
    expect(result.entry.modelOverrideFallbackOriginModel).toBe("claude-fallback");
    expect(result.hasStoredOverride).toBe(true);
  });

  it("does not repair a locked session selection", async () => {
    const sessionKey = "agent:main:telegram:123";
    const sessionStore: Record<string, SessionEntry> = {};
    const sessionEntry = makeSessionEntry({ modelSelectionLocked: true });
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
    expect(result.entry.providerOverride).toBe("anthropic");
    expect(result.entry.modelOverride).toBe("claude-fallback");
  });

  it("adopts the persisted row when a commit-edge conflict occurs", async () => {
    const sessionKey = "agent:main:telegram:123";
    const sessionStore: Record<string, SessionEntry> = {};
    const storePath = path.join(tempDirs.make("repair-store"), "sessions.json");
    replaceSessionEntrySync({ storePath, sessionKey }, makeSessionEntry());
    const sessionEntry = loadSessionEntryReadOnly({ storePath, sessionKey });
    if (!sessionEntry) {
      throw new Error("session entry not loaded");
    }
    sessionStore[sessionKey] = sessionEntry;

    // A concurrent write lands before our patch commits.
    const newerEntry: SessionEntry = {
      ...sessionEntry,
      model: "newer-model",
      updatedAt: sessionEntry.updatedAt + 1,
    };
    replaceSessionEntrySync({ storePath, sessionKey }, newerEntry);

    vi.spyOn(sessionAccessor, "patchSessionEntry").mockRejectedValueOnce(createConflictError());

    const result = await repairStaleAutoFallbackOriginOverride({
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      primaryProvider: "openai",
      primaryModel: "gpt-5.5",
    });

    expect(result.entry.model).toBe("newer-model");
    expect(result.entry.updatedAt).toBe(sessionEntry.updatedAt + 1);
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
