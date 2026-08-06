import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
    providerOverride: "google",
    modelOverride: "gemini-3-pro",
    modelOverrideSource: "auto",
    // Genuine fallback: origin differs from the override.
    modelOverrideFallbackOriginProvider: "anthropic",
    modelOverrideFallbackOriginModel: "claude-haiku-4-5",
    ...params,
  };
}

describe("repairStaleAutoFallbackOriginOverride", () => {
  it("repairs a genuine fallback origin when persisted with a store path", async () => {
    const sessionKey = "agent:main:telegram:123";
    const sessionStore: Record<string, SessionEntry> = {};
    const storePath = path.join(tempDirs.make("repair-store"), "sessions.json");
    replaceSessionEntrySync({ storePath, sessionKey }, makeSessionEntry());
    const sessionEntry = loadSessionEntryReadOnly({ storePath, sessionKey });
    if (!sessionEntry) {
      throw new Error("session entry not loaded");
    }
    sessionStore[sessionKey] = sessionEntry;

    // Origin differs from override (genuine fallback) and from primary. The stale
    // override is cleared so this turn retries the configured primary.
    const result = await repairStaleAutoFallbackOriginOverride({
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      primaryProvider: "anthropic",
      primaryModel: "claude-opus-4-8",
    });

    expect(result.entry.providerOverride).toBeUndefined();
    expect(result.entry.modelOverride).toBeUndefined();
    expect(result.hasStoredOverride).toBe(false);
  });

  it("repairs the canonical three-distinct state with a store path", async () => {
    const sessionKey = "agent:main:telegram:123";
    const sessionStore: Record<string, SessionEntry> = {};
    const storePath = path.join(tempDirs.make("repair-store"), "sessions.json");
    const originEntry = makeSessionEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-7",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-haiku-4-5",
    });
    replaceSessionEntrySync({ storePath, sessionKey }, originEntry);
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

    // Origin, override, and primary are all different. The stale override is cleared
    // so this turn retries the configured primary.
    expect(result.entry.providerOverride).toBeUndefined();
    expect(result.entry.modelOverride).toBeUndefined();
    expect(result.entry.modelOverrideSource).toBeUndefined();
    expect(result.entry.modelOverrideFallbackOriginProvider).toBeUndefined();
    expect(result.entry.modelOverrideFallbackOriginModel).toBeUndefined();
    expect(result.hasStoredOverride).toBe(false);
  });

  it("returns the observed entry unchanged when no repair is needed", async () => {
    const sessionKey = "agent:main:telegram:123";
    const sessionStore: Record<string, SessionEntry> = {};
    const sessionEntry = makeSessionEntry({
      modelOverrideSource: "user",
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

    // User override is never stale; the observed entry is returned unchanged.
    expect(result.entry).toBe(sessionEntry);
    expect(result.entry.modelOverrideSource).toBe("user");
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
      primaryProvider: "anthropic",
      primaryModel: "claude-opus-4-8",
    });

    expect(result.entry).toBe(sessionEntry);
    expect(result.entry.providerOverride).toBe("google");
    expect(result.entry.modelOverride).toBe("gemini-3-pro");
  });

  it("adopts newer persisted state when a concurrent write blocks the repair", async () => {
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

    const result = await repairStaleAutoFallbackOriginOverride({
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      primaryProvider: "anthropic",
      primaryModel: "claude-opus-4-8",
    });

    // The snapshot guard blocked the repair because the persisted entry was
    // concurrently modified. Adopt the newer persisted state instead.
    expect(result.entry.model).toBe("newer-model");
    expect(result.entry).not.toBe(sessionEntry);
  });

  it("leaves non-stale origins untouched", async () => {
    const sessionKey = "agent:main:telegram:123";
    const sessionStore: Record<string, SessionEntry> = {};
    const sessionEntry = makeSessionEntry({
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-opus-4-8",
    });
    sessionStore[sessionKey] = sessionEntry;

    const result = await repairStaleAutoFallbackOriginOverride({
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath: undefined,
      primaryProvider: "anthropic",
      primaryModel: "claude-opus-4-8",
    });

    expect(result.entry).toBe(sessionEntry);
  });

  it("does not repair a self-referential origin (preserves configured selections)", async () => {
    const sessionKey = "agent:main:telegram:123";
    const sessionStore: Record<string, SessionEntry> = {};
    const sessionEntry = makeSessionEntry({
      // Self-referential: origin equals override. Configured subagent selections
      // use this pattern; hasSessionActiveAutoModelFallback preserves them.
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-7",
      modelOverrideFallbackOriginProvider: "anthropic",
      modelOverrideFallbackOriginModel: "claude-opus-4-7",
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
    expect(result.entry.providerOverride).toBe("anthropic");
    expect(result.entry.modelOverride).toBe("claude-opus-4-7");
  });
});
