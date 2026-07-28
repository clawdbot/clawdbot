import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { FollowupRun } from "./queue.js";

const state = vi.hoisted(() => ({
  updateSessionEntryMock: vi.fn(),
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  updateSessionEntry: (...args: unknown[]) => state.updateSessionEntryMock(...args),
}));

import { clearRecoveredAutoFallbackPrimaryProbeSelection } from "./agent-runner-auto-fallback.js";

describe("clearRecoveredAutoFallbackPrimaryProbeSelection", () => {
  beforeEach(() => {
    state.updateSessionEntryMock.mockReset();
  });

  it("refreshes the local selection when the persisted comparison rejects the probe", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5.4",
    };
    const staleAutoEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: probe.provider,
      modelOverrideFallbackOriginModel: probe.model,
    };
    const newerUserEntry: SessionEntry = {
      sessionId: "newer-session",
      updatedAt: 2,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
    };
    const activeSessionStore = { main: staleAutoEntry };
    state.updateSessionEntryMock.mockImplementationOnce(
      async (_scope: unknown, update: (entry: SessionEntry) => unknown) => {
        expect(await update(newerUserEntry)).toBeNull();
        return null;
      },
    );

    await clearRecoveredAutoFallbackPrimaryProbeSelection({
      run: {
        provider: probe.provider,
        model: probe.model,
        autoFallbackPrimaryProbe: probe,
      } as FollowupRun["run"],
      provider: probe.provider,
      model: probe.model,
      sessionKey: "main",
      activeSessionStore,
      getActiveSessionEntry: () => staleAutoEntry,
      storePath: "/tmp/sessions.sqlite",
    });

    expect(activeSessionStore.main).toBe(newerUserEntry);
    expect(activeSessionStore.main).toMatchObject({
      sessionId: "newer-session",
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
    });
  });

  it("preserves an identically reselected persisted fallback generation", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5.4",
    };
    const staleAutoEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: probe.provider,
      modelOverrideFallbackOriginModel: probe.model,
    };
    const newerAutoEntry: SessionEntry = {
      ...staleAutoEntry,
      updatedAt: 2,
    };
    const activeSessionStore = { main: staleAutoEntry };
    state.updateSessionEntryMock.mockImplementationOnce(
      async (_scope: unknown, update: (entry: SessionEntry) => unknown) => {
        expect(await update(newerAutoEntry)).toBeNull();
        return null;
      },
    );

    await clearRecoveredAutoFallbackPrimaryProbeSelection({
      run: {
        provider: probe.provider,
        model: probe.model,
        autoFallbackPrimaryProbe: probe,
      } as FollowupRun["run"],
      provider: probe.provider,
      model: probe.model,
      sessionKey: "main",
      activeSessionStore,
      getActiveSessionEntry: () => staleAutoEntry,
      storePath: "/tmp/sessions.sqlite",
    });

    expect(activeSessionStore.main).toBe(newerAutoEntry);
    expect(activeSessionStore.main).toMatchObject({
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
      modelOverrideSource: "auto",
      updatedAt: 2,
    });
  });

  it("keeps a newer local selection installed while persistence is pending", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5.4",
    };
    const staleAutoEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: probe.provider,
      modelOverrideFallbackOriginModel: probe.model,
    };
    const newerUserEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 2,
      providerOverride: "openai",
      modelOverride: "gpt-5.5",
      modelOverrideSource: "user",
    };
    const activeSessionStore = { main: staleAutoEntry };
    state.updateSessionEntryMock.mockImplementationOnce(
      async (_scope: unknown, update: (entry: SessionEntry) => unknown) => {
        const persistedEntry = { ...staleAutoEntry };
        const patch = await update(persistedEntry);
        activeSessionStore.main = newerUserEntry;
        return { ...persistedEntry, ...(patch as Partial<SessionEntry>) };
      },
    );

    await clearRecoveredAutoFallbackPrimaryProbeSelection({
      run: {
        provider: probe.provider,
        model: probe.model,
        autoFallbackPrimaryProbe: probe,
      } as FollowupRun["run"],
      provider: probe.provider,
      model: probe.model,
      sessionKey: "main",
      activeSessionStore,
      getActiveSessionEntry: () => staleAutoEntry,
      storePath: "/tmp/sessions.sqlite",
    });

    expect(activeSessionStore.main).toBe(newerUserEntry);
  });

  it("preserves an in-place auth selection while applying persisted probe cleanup", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5.4",
    };
    const staleAutoEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: probe.provider,
      modelOverrideFallbackOriginModel: probe.model,
      authProfileOverride: "openai:fallback",
      authProfileOverrideSource: "auto",
    };
    const activeSessionStore = { main: staleAutoEntry };
    state.updateSessionEntryMock.mockImplementationOnce(
      async (_scope: unknown, update: (entry: SessionEntry) => unknown) => {
        const persistedEntry = { ...staleAutoEntry };
        const patch = await update(persistedEntry);
        Object.assign(staleAutoEntry, {
          authProfileOverrideSource: "user",
          updatedAt: 3,
        });
        return { ...persistedEntry, ...(patch as Partial<SessionEntry>) };
      },
    );

    await clearRecoveredAutoFallbackPrimaryProbeSelection({
      run: {
        provider: probe.provider,
        model: probe.model,
        autoFallbackPrimaryProbe: probe,
      } as FollowupRun["run"],
      provider: probe.provider,
      model: probe.model,
      sessionKey: "main",
      activeSessionStore,
      getActiveSessionEntry: () => staleAutoEntry,
      storePath: "/tmp/sessions.sqlite",
    });

    expect(activeSessionStore.main).not.toBe(staleAutoEntry);
    expect(activeSessionStore.main).toMatchObject({
      authProfileOverride: "openai:fallback",
      authProfileOverrideSource: "user",
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
    });
    expect(activeSessionStore.main.updatedAt).toBeGreaterThanOrEqual(3);
  });

  it("preserves a value-identical same-session cache replacement", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5.4",
    };
    const staleAutoEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: probe.provider,
      modelOverrideFallbackOriginModel: probe.model,
      authProfileOverride: "openai:fallback",
      authProfileOverrideSource: "auto",
    };
    const replacementEntry: SessionEntry = {
      ...staleAutoEntry,
      updatedAt: 3,
    };
    const activeSessionStore = { main: staleAutoEntry };
    state.updateSessionEntryMock.mockImplementationOnce(
      async (_scope: unknown, update: (entry: SessionEntry) => unknown) => {
        const persistedEntry = { ...staleAutoEntry };
        const patch = await update(persistedEntry);
        activeSessionStore.main = replacementEntry;
        return { ...persistedEntry, ...(patch as Partial<SessionEntry>) };
      },
    );

    await clearRecoveredAutoFallbackPrimaryProbeSelection({
      run: {
        provider: probe.provider,
        model: probe.model,
        autoFallbackPrimaryProbe: probe,
      } as FollowupRun["run"],
      provider: probe.provider,
      model: probe.model,
      sessionKey: "main",
      activeSessionStore,
      getActiveSessionEntry: () => staleAutoEntry,
      storePath: "/tmp/sessions.sqlite",
    });

    expect(activeSessionStore.main).toBe(replacementEntry);
    expect(activeSessionStore.main).toMatchObject({
      authProfileOverride: "openai:fallback",
      authProfileOverrideSource: "auto",
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
      updatedAt: 3,
    });
  });

  it("preserves a same-session cache replacement when persistence has no row", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5.4",
    };
    const staleAutoEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: probe.provider,
      modelOverrideFallbackOriginModel: probe.model,
    };
    const replacementEntry: SessionEntry = {
      ...staleAutoEntry,
      updatedAt: 2,
    };
    const activeSessionStore = { main: staleAutoEntry };
    state.updateSessionEntryMock.mockImplementationOnce(async () => {
      activeSessionStore.main = replacementEntry;
      return undefined;
    });

    await clearRecoveredAutoFallbackPrimaryProbeSelection({
      run: {
        provider: probe.provider,
        model: probe.model,
        autoFallbackPrimaryProbe: probe,
      } as FollowupRun["run"],
      provider: probe.provider,
      model: probe.model,
      sessionKey: "main",
      activeSessionStore,
      getActiveSessionEntry: () => staleAutoEntry,
      storePath: "/tmp/sessions.sqlite",
    });

    expect(activeSessionStore.main).toBe(replacementEntry);
  });

  it("preserves an in-place cache update when persistence has no row", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5.4",
    };
    const staleAutoEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: probe.provider,
      modelOverrideFallbackOriginModel: probe.model,
      authProfileOverride: "openai:fallback",
      authProfileOverrideSource: "auto",
    };
    const activeSessionStore = { main: staleAutoEntry };
    state.updateSessionEntryMock.mockImplementationOnce(async () => {
      Object.assign(staleAutoEntry, {
        authProfileOverrideSource: "user",
        updatedAt: 2,
      });
      return undefined;
    });

    await clearRecoveredAutoFallbackPrimaryProbeSelection({
      run: {
        provider: probe.provider,
        model: probe.model,
        autoFallbackPrimaryProbe: probe,
      } as FollowupRun["run"],
      provider: probe.provider,
      model: probe.model,
      sessionKey: "main",
      activeSessionStore,
      getActiveSessionEntry: () => staleAutoEntry,
      storePath: "/tmp/sessions.sqlite",
    });

    expect(activeSessionStore.main).toBe(staleAutoEntry);
    expect(activeSessionStore.main).toMatchObject({
      authProfileOverride: "openai:fallback",
      authProfileOverrideSource: "user",
      updatedAt: 2,
    });
  });

  it("preserves an in-place nested cache update", async () => {
    const probe = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      fallbackProvider: "openai",
      fallbackModel: "gpt-5.4",
    };
    const staleAutoEntry: SessionEntry = {
      sessionId: "session",
      updatedAt: 1,
      providerOverride: probe.fallbackProvider,
      modelOverride: probe.fallbackModel,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: probe.provider,
      modelOverrideFallbackOriginModel: probe.model,
      cliSessionBindings: {
        codex: { sessionId: "old-cli-session" },
      },
    };
    const activeSessionStore = { main: staleAutoEntry };
    state.updateSessionEntryMock.mockImplementationOnce(
      async (_scope: unknown, update: (entry: SessionEntry) => unknown) => {
        const persistedEntry = structuredClone(staleAutoEntry);
        const patch = await update(persistedEntry);
        staleAutoEntry.cliSessionBindings!.codex!.sessionId = "new-cli-session";
        staleAutoEntry.updatedAt = 2;
        return { ...persistedEntry, ...(patch as Partial<SessionEntry>) };
      },
    );

    await clearRecoveredAutoFallbackPrimaryProbeSelection({
      run: {
        provider: probe.provider,
        model: probe.model,
        autoFallbackPrimaryProbe: probe,
      } as FollowupRun["run"],
      provider: probe.provider,
      model: probe.model,
      sessionKey: "main",
      activeSessionStore,
      getActiveSessionEntry: () => staleAutoEntry,
      storePath: "/tmp/sessions.sqlite",
    });

    expect(activeSessionStore.main).not.toBe(staleAutoEntry);
    expect(activeSessionStore.main.cliSessionBindings?.codex?.sessionId).toBe("new-cli-session");
    expect(activeSessionStore.main.updatedAt).toBeGreaterThanOrEqual(2);
    expect(activeSessionStore.main.modelOverride).toBeUndefined();
  });
});
