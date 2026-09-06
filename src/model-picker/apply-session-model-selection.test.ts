import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { loadProviderScopedThinkingCatalog } from "../agents/model-catalog.runtime.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../sessions/session-lifecycle-events.js";

vi.mock("../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
}));

const effects = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(),
  info: vi.fn(),
  mutateConfigFileWithRetry: vi.fn(),
  refreshQueuedFollowupSession: vi.fn(),
  triggerSessionPatchHook: vi.fn(),
  warn: vi.fn(),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let lifecycleEvents: SessionLifecycleEvent[];
let unsubscribeLifecycle: () => void;

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => effects.enqueueSystemEvent(...args),
}));
vi.mock("../auto-reply/reply/queue.js", () => ({
  refreshQueuedFollowupSession: (...args: unknown[]) =>
    effects.refreshQueuedFollowupSession(...args),
}));
vi.mock("../gateway/session-patch-hooks.js", () => ({
  triggerSessionPatchHook: (...args: unknown[]) => effects.triggerSessionPatchHook(...args),
}));
vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return { ...actual, mutateConfigFileWithRetry: effects.mutateConfigFileWithRetry };
});

vi.mock("../logging/subsystem.js", async () => {
  const actual =
    await vi.importActual<typeof import("../logging/subsystem.js")>("../logging/subsystem.js");
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) =>
      subsystem === "agents/sticky-model-selection"
        ? { info: effects.info, warn: effects.warn }
        : actual.createSubsystemLogger(subsystem),
  };
});

import {
  applySessionModelSelection,
  type ApplySessionModelSelectionParams,
} from "./apply-session-model-selection.js";

const catalog = [
  {
    provider: "anthropic",
    id: "claude-opus-4-6",
    name: "Claude Opus",
    contextTokens: 32_000,
  },
  { provider: "openai", id: "gpt-4o", name: "GPT-4o", contextTokens: 16_000 },
] satisfies ModelCatalogEntry[];

function createEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: 1,
    delivery: { kind: "none" },
    ...overrides,
  };
}

function createParams(overrides: Partial<ApplySessionModelSelectionParams> = {}) {
  const sessionEntry = overrides.sessionEntry ?? createEntry();
  const sessionKey = overrides.sessionKey ?? "agent:main:dm:1";
  return {
    cfg: {},
    agentId: "main",
    sessionKey,
    sessionEntry,
    sessionStore: { [sessionKey]: sessionEntry },
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    currentProvider: "anthropic",
    currentModel: "claude-opus-4-6",
    modelCatalog: catalog,
    thinkingCatalog: catalog,
    canPersistStickyModelSelection: false,
    request: {
      provider: "openai",
      model: "gpt-4o",
      isDefault: false,
      runtime: { kind: "unchanged" },
    },
    markLiveSwitchPending: true,
    ...overrides,
  } satisfies ApplySessionModelSelectionParams;
}

beforeEach(() => {
  vi.mocked(loadProviderScopedThinkingCatalog).mockReset().mockResolvedValue([]);
  lifecycleEvents = [];
  unsubscribeLifecycle = onSessionLifecycleEvent((event) => lifecycleEvents.push(event));
  effects.enqueueSystemEvent.mockReset();
  effects.info.mockReset();
  effects.warn.mockReset();
  effects.mutateConfigFileWithRetry.mockReset().mockResolvedValue({
    nextConfig: {},
    result: "defaults",
  });
  effects.refreshQueuedFollowupSession.mockReset();
  effects.triggerSessionPatchHook.mockReset();
});

afterEach(() => unsubscribeLifecycle());

describe("applySessionModelSelection", () => {
  it("uses selected route metadata for context and thinking outside the prepared inventory", async () => {
    const selected: ModelCatalogEntry = {
      provider: "fixture-route",
      id: "reasoner",
      name: "Reasoner",
      api: "openai-responses",
      contextWindow: 48_000,
      contextTokens: 24_000,
      reasoning: true,
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "max"] },
    };
    vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValueOnce([selected]);
    const sessionEntry = createEntry({ thinkingLevel: "max" });
    const result = await applySessionModelSelection(
      createParams({
        cfg: {
          models: {
            providers: {
              "fixture-route": {
                api: "openai-responses",
                baseUrl: "https://fixture.invalid/v1",
                models: [],
              },
            },
          },
        },
        sessionEntry,
        modelCatalog: [catalog[0]!],
        thinkingCatalog: [catalog[0]!],
        request: {
          provider: selected.provider,
          model: selected.id,
          isDefault: false,
          runtime: { kind: "set", runtime: "openclaw" },
        },
      }),
    );
    expect(result).toMatchObject({ status: "applied", contextTokens: 24_000 });
    expect(result).not.toHaveProperty("thinkingRemap");
    expect(sessionEntry).toMatchObject({
      providerOverride: selected.provider,
      modelOverride: selected.id,
      thinkingLevel: "max",
    });
    expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ provider: selected.provider, model: selected.id }),
    );
    expect(effects.refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        nextThinking: expect.objectContaining({
          level: "max",
          catalog: expect.arrayContaining([selected]),
        }),
      }),
    );
  });

  it.each([
    {
      provider: "missing-provider",
      model: "reasoner",
      runtime: { kind: "unchanged" } as const,
      reason: "unknown-provider",
    },
    {
      provider: "openai",
      model: "gpt-5.6-luna",
      runtime: { kind: "set", runtime: "missing-runtime" } as const,
      reason: "invalid-runtime",
    },
  ])(
    "rejects $reason without persistence under unrestricted policy",
    async ({ provider, model, runtime, reason }) => {
      const sessionEntry = createEntry({ thinkingLevel: "high" });
      const initial = structuredClone(sessionEntry);
      const result = await applySessionModelSelection(
        createParams({
          sessionEntry,
          modelCatalog: [catalog[0]!],
          thinkingCatalog: [catalog[0]!],
          request: { provider, model, runtime, isDefault: false },
        }),
      );
      expect(result).toMatchObject({ status: "rejected", reason });
      expect(sessionEntry).toEqual(initial);
      expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
      expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
      expect(loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, {}, { allow: [] }, { allow: ["openai/*"] }])(
    "persists an off-catalog selection under policy %j without credentials",
    async (modelPolicy) => {
      const sessionEntry = createEntry({ thinkingLevel: "high" });
      const cfg: OpenClawConfig = { agents: { defaults: { modelPolicy } } };
      const result = await applySessionModelSelection(
        createParams({
          cfg,
          sessionEntry,
          modelCatalog: [catalog[0]!],
          thinkingCatalog: [catalog[0]!],
          request: {
            provider: "openai",
            model: "gpt-5.6-luna",
            isDefault: false,
            runtime: { kind: "unchanged" },
          },
        }),
      );
      expect(result).toMatchObject({
        status: "applied",
        provider: "openai",
        model: "gpt-5.6-luna",
      });
      expect(sessionEntry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-luna",
        modelOverrideSource: "user",
        thinkingLevel: "high",
      });
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    },
  );

  it("publishes a profile-only selection after the scoped session has persisted", async () => {
    const tempRoot = tempDirs.make("openclaw-model-picker-profile-");
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionKey = "agent:main:dm:profile";
    const sessionEntry = createEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "auto",
    });
    await replaceSessionEntry({ sessionKey, storePath }, sessionEntry);
    let publishedEntry: SessionEntry | undefined;
    const unsubscribe = onSessionLifecycleEvent(() => {
      publishedEntry = loadSessionEntryReadOnly({ sessionKey, storePath });
    });
    try {
      const result = await applySessionModelSelection(
        createParams({
          sessionEntry,
          sessionKey,
          storePath,
          currentProvider: "openai",
          currentModel: "gpt-5.6-luna",
          modelCatalog: [{ provider: "openai", id: "gpt-5.6-luna", name: "Luna" }],
          request: {
            provider: "openai",
            model: "gpt-5.6-luna",
            isDefault: false,
            profileOverride: "openai:work",
            runtime: { kind: "unchanged" },
          },
        }),
      );

      expect(result).toMatchObject({ status: "applied", changed: true });
      expect(lifecycleEvents).toEqual([{ sessionKey, agentId: "main", reason: "patch" }]);
      expect(publishedEntry).toMatchObject({
        sessionId: "session-1",
        modelOverride: "gpt-5.6-luna",
        authProfileOverride: "openai:work",
        authProfileOverrideSource: "user",
      });
      expect(effects.enqueueSystemEvent).not.toHaveBeenCalled();
      expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("applies a non-default selection, auth profile, cleanup, and side effects once", async () => {
    const sessionEntry = createEntry({
      model: "claude-opus-4-6",
      modelProvider: "anthropic",
      contextTokens: 8_000,
      contextBudgetStatus: {} as NonNullable<SessionEntry["contextBudgetStatus"]>,
    });
    const result = await applySessionModelSelection(
      createParams({
        sessionEntry,
        canPersistStickyModelSelection: true,
        request: {
          provider: "openai",
          model: "gpt-4o",
          isDefault: false,
          alias: "Fast",
          profileOverride: "openai:work",
          runtime: { kind: "unchanged" },
        },
      }),
    );

    expect(result).toMatchObject({
      status: "applied",
      provider: "openai",
      model: "gpt-4o",
      effectiveModelRef: "openai/gpt-4o",
      changed: true,
      contextTokens: 16_000,
      configuredDefaultUpdate: "requested",
    });
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      liveModelSwitchPending: true,
    });
    expect(sessionEntry.model).toBeUndefined();
    expect(sessionEntry.modelProvider).toBeUndefined();
    expect(sessionEntry.contextTokens).toBeUndefined();
    expect(sessionEntry.contextBudgetStatus).toBeUndefined();
    expect(effects.triggerSessionPatchHook).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(effects.mutateConfigFileWithRetry).toHaveBeenCalledOnce());
    expect(effects.refreshQueuedFollowupSession).toHaveBeenCalledOnce();
    expect(effects.enqueueSystemEvent).toHaveBeenCalledWith(
      "Model switched to Fast (openai/gpt-4o).",
      { sessionKey: "agent:main:dm:1", contextKey: "model:openai/gpt-4o" },
    );
  });

  it("resets to a cross-provider default and clears incompatible auth plus runtime", async () => {
    const sessionEntry = createEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 3,
      agentHarnessId: "codex",
      agentRuntimeOverride: "codex",
    });
    const result = await applySessionModelSelection(
      createParams({
        sessionEntry,
        currentProvider: "openai",
        currentModel: "gpt-4o",
        request: {
          provider: "anthropic",
          model: "claude-opus-4-6",
          isDefault: true,
          runtime: { kind: "unchanged" },
        },
      }),
    );

    expect(result).toMatchObject({ status: "applied", runtimeChange: { kind: "clear" } });
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
    expect(sessionEntry.agentRuntimeOverride).toBeUndefined();
    expect(sessionEntry.agentHarnessId).toBe("codex");
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("resets to a same-provider default without clearing compatible auth or writing config", async () => {
    const sessionEntry = createEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4.1",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 3,
    });

    const result = await applySessionModelSelection(
      createParams({
        sessionEntry,
        defaultProvider: "openai",
        defaultModel: "gpt-4o",
        currentProvider: "openai",
        currentModel: "gpt-4.1",
        canPersistStickyModelSelection: true,
        request: {
          provider: "openai",
          model: "gpt-4o",
          isDefault: true,
          runtime: { kind: "unchanged" },
        },
      }),
    );

    expect(result).toMatchObject({ status: "applied", changed: true });
    expect(result).not.toHaveProperty("configuredDefaultUpdate");
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionEntry.modelOverrideSource).toBeUndefined();
    expect(sessionEntry.modelOverrideRouteResolution).toBeUndefined();
    expect(sessionEntry).toMatchObject({
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 3,
    });
    expect(effects.refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({ nextModelOverrideSource: undefined }),
    );
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("preserves a compatible auth profile when changing models within a provider", async () => {
    const sessionEntry = createEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4.1",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 3,
    });

    await applySessionModelSelection(
      createParams({
        sessionEntry,
        currentProvider: "openai",
        currentModel: "gpt-4.1",
      }),
    );

    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 3,
    });
  });

  it.each([
    { name: "legacy user", marker: undefined, expectedSource: "user" as const },
    { name: "marker-backed auto", marker: 0, expectedSource: "auto" as const },
  ])(
    "forwards a source-less $name auth profile canonically to queued work",
    async ({ marker, expectedSource }) => {
      const sessionEntry = createEntry({
        providerOverride: "openai",
        modelOverride: "gpt-4.1",
        authProfileOverride: "openai:work",
        ...(marker === undefined ? {} : { authProfileOverrideCompactionCount: marker }),
      });

      await applySessionModelSelection(
        createParams({
          sessionEntry,
          currentProvider: "openai",
          currentModel: "gpt-4.1",
        }),
      );

      expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
      expect(sessionEntry.authProfileOverrideCompactionCount).toBe(marker);
      expect(effects.refreshQueuedFollowupSession).toHaveBeenCalledWith(
        expect.objectContaining({
          nextAuthProfileId: "openai:work",
          nextAuthProfileIdSource: expectedSource,
        }),
      );
    },
  );

  it("keeps an accepted selection session-scoped without config authority", async () => {
    const sessionEntry = createEntry();

    const result = await applySessionModelSelection(
      createParams({ sessionEntry, canPersistStickyModelSelection: false }),
    );

    expect(result.status).toBe("applied");
    expect(result).not.toHaveProperty("configuredDefaultUpdate");
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    expect(effects.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  });

  it("returns session success and warns when the sticky config write fails", async () => {
    const sessionEntry = createEntry();
    effects.mutateConfigFileWithRetry.mockRejectedValueOnce(new Error("config write failed"));

    const result = await applySessionModelSelection(
      createParams({ sessionEntry, canPersistStickyModelSelection: true }),
    );

    expect(result).toMatchObject({
      status: "applied",
      configuredDefaultUpdate: "requested",
    });
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
    });
    await vi.waitFor(() =>
      expect(effects.warn).toHaveBeenCalledWith(
        "failed sticky model persistence agentId=main model=openai/gpt-4o reason=config write failed",
      ),
    );
  });

  it("resolves SDK effective persistence from the current write draft", async () => {
    const cfg = { agents: { defaults: { model: "anthropic/claude-opus-4-6" } } };
    const draft = {
      agents: {
        ...cfg.agents,
        entries: { main: { model: "anthropic/claude-sonnet-4-6" } },
      },
    };
    effects.mutateConfigFileWithRetry.mockImplementationOnce(
      async ({ mutate }: { mutate: (config: OpenClawConfig) => string }) => ({
        nextConfig: draft,
        result: mutate(draft),
      }),
    );

    await applySessionModelSelection(createParams({ cfg, canPersistStickyModelSelection: true }));

    await vi.waitFor(() => expect(effects.info).toHaveBeenCalledOnce());
    expect(draft.agents.defaults.model).toBe("anthropic/claude-opus-4-6");
    expect(draft.agents.entries.main.model).toBe("openai/gpt-4o");
  });

  it.each([
    {
      name: "clears overrides for an authoritative default",
      request: {
        provider: "anthropic",
        model: "claude-opus-4-6",
        isDefault: false,
        runtime: { kind: "unchanged" } as const,
      },
      expectedOverride: undefined,
    },
    {
      name: "persists an authoritative non-default",
      request: {
        provider: "openai",
        model: "gpt-4o",
        isDefault: true,
        runtime: { kind: "unchanged" } as const,
      },
      expectedOverride: "gpt-4o",
    },
  ])("$name instead of trusting request.isDefault", async ({ request, expectedOverride }) => {
    const sessionEntry = createEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    });
    await applySessionModelSelection(createParams({ sessionEntry, request }));
    expect(sessionEntry.modelOverride).toBe(expectedOverride);
  });

  it.each([
    {
      name: "set",
      initial: undefined,
      runtime: { kind: "set", runtime: "openclaw" } as const,
      expected: "openclaw",
      runtimeChange: { kind: "set", runtime: "openclaw" },
      agentRuntime: "openclaw",
    },
    {
      name: "set idempotently",
      initial: "openclaw",
      runtime: { kind: "set", runtime: "openclaw" } as const,
      expected: "openclaw",
      runtimeChange: { kind: "set", runtime: "openclaw" },
      agentRuntime: "openclaw",
    },
    {
      name: "clear",
      initial: "openclaw",
      runtime: { kind: "clear" } as const,
      expected: undefined,
      runtimeChange: { kind: "clear" },
      agentRuntime: "codex",
    },
    {
      name: "clear idempotently",
      initial: undefined,
      runtime: { kind: "clear" } as const,
      expected: undefined,
      runtimeChange: { kind: "clear" },
      agentRuntime: "codex",
    },
    {
      name: "unchanged",
      initial: "openclaw",
      runtime: { kind: "unchanged" } as const,
      expected: "openclaw",
      runtimeChange: undefined,
      agentRuntime: "openclaw",
    },
  ])(
    "supports runtime $name",
    async ({ initial, runtime, expected, runtimeChange, agentRuntime }) => {
      const sessionEntry = createEntry({ agentRuntimeOverride: initial });
      const result = await applySessionModelSelection(
        createParams({
          sessionEntry,
          request: { provider: "openai", model: "gpt-4o", isDefault: false, runtime },
        }),
      );

      expect(result.status).toBe("applied");
      if (result.status === "applied") {
        expect(result.runtimeChange).toEqual(runtimeChange);
        expect(result.agentRuntime).toBe(agentRuntime);
      }
      expect(sessionEntry.agentRuntimeOverride).toBe(expected);
    },
  );

  it("rejects an incompatible runtime without mutation or side effects", async () => {
    const sessionEntry = createEntry();
    const initial = structuredClone(sessionEntry);
    const result = await applySessionModelSelection(
      createParams({
        sessionEntry,
        request: {
          provider: "anthropic",
          model: "claude-opus-4-6",
          isDefault: true,
          runtime: { kind: "set", runtime: "codex" },
        },
      }),
    );

    expect(result).toEqual({
      status: "rejected",
      reason: "invalid-runtime",
      message: 'Runtime "codex" is not supported for anthropic.',
    });
    expect(sessionEntry).toEqual(initial);
    expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(effects.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("rejects locked selection without mutation or side effects", async () => {
    const sessionEntry = createEntry({ modelSelectionLocked: true });
    const initial = structuredClone(sessionEntry);
    const result = await applySessionModelSelection(createParams({ sessionEntry }));

    expect(result).toEqual({
      status: "rejected",
      reason: "locked",
      message: "Model selection is locked for this session.",
    });
    expect(lifecycleEvents).toEqual([]);
    expect(sessionEntry).toEqual(initial);
    expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(effects.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("rejects a stale in-memory snapshot when the session store row is locked", async () => {
    const sessionEntry = createEntry();
    const lockedEntry = createEntry({ modelSelectionLocked: true, updatedAt: 2 });
    const sessionKey = "agent:main:dm:locked-store";
    const result = await applySessionModelSelection(
      createParams({
        sessionEntry,
        sessionKey,
        sessionStore: { [sessionKey]: lockedEntry },
      }),
    );

    expect(result).toMatchObject({ status: "rejected", reason: "locked" });
    expect(sessionEntry).toEqual(createEntry());
    expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "locked",
      concurrent: createEntry({ modelSelectionLocked: true }),
      outcome: { status: "rejected", reason: "locked" },
    },
    {
      name: "replaced",
      concurrent: createEntry({ sessionId: "session-2" }),
      outcome: { status: "conflict" },
    },
  ])(
    "preserves an in-memory session $name during metadata preparation",
    async ({ concurrent, outcome }) => {
      const metadata = createDeferred<ModelCatalogEntry[]>();
      vi.mocked(loadProviderScopedThinkingCatalog).mockReturnValueOnce(metadata.promise);
      const params = createParams();
      const pending = applySessionModelSelection(params);
      params.sessionStore[params.sessionKey] = concurrent;
      metadata.resolve([]);

      expect(await pending).toMatchObject(outcome);
      expect(params.sessionStore[params.sessionKey]).toBe(concurrent);
      expect(params.sessionEntry).toEqual(createEntry());
      expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
      expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
      expect(effects.enqueueSystemEvent).not.toHaveBeenCalled();
    },
  );

  it("rejects when the authoritative persisted row became locked", async () => {
    const tempRoot = tempDirs.make("openclaw-model-picker-lock-");
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionKey = "agent:main:dm:locked-disk";
    const sessionEntry = createEntry();
    const lockedEntry = createEntry({ modelSelectionLocked: true, updatedAt: 2 });
    await replaceSessionEntry({ sessionKey, storePath }, lockedEntry);

    const result = await applySessionModelSelection(
      createParams({ sessionEntry, sessionKey, storePath }),
    );
    expect(result).toMatchObject({ status: "rejected", reason: "locked" });
    expect(sessionEntry).toEqual(lockedEntry);
    expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(effects.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("rejects account selection authority revoked during metadata preparation", async () => {
    const metadata = createDeferred<ModelCatalogEntry[]>();
    vi.mocked(loadProviderScopedThinkingCatalog).mockReturnValueOnce(metadata.promise);
    let authorized = true;
    const params = createParams({
      validateAuthProfileSelection: () => (authorized ? undefined : "Select an account you own."),
      request: {
        provider: "openai",
        model: "gpt-4o",
        isDefault: false,
        profileOverride: "openai:work",
        runtime: { kind: "unchanged" },
      },
    });
    const initial = structuredClone(params.sessionEntry);
    const pending = applySessionModelSelection(params);
    authorized = false;
    metadata.resolve([]);

    expect(await pending).toMatchObject({
      status: "rejected",
      message: "Select an account you own.",
    });
    expect(params.sessionEntry).toEqual(initial);
    expect(lifecycleEvents).toEqual([]);
    expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "allowlist",
      overrides: { cfg: { agents: { defaults: { modelPolicy: { allow: ["anthropic/*"] } } } } },
    },
  ])("rejects a model missing from the $name", async ({ overrides }) => {
    const sessionEntry = createEntry();
    const initial = structuredClone(sessionEntry);
    const result = await applySessionModelSelection(createParams({ sessionEntry, ...overrides }));

    expect(result).toEqual({
      status: "rejected",
      reason: "not-allowed",
      message: "Model openai/gpt-4o is not available for this agent.",
    });
    expect(sessionEntry).toEqual(initial);
    expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
  });

  it("remaps unsupported thinking and reasserts live switching", async () => {
    const sessionEntry = createEntry({ thinkingLevel: "adaptive" });
    const result = await applySessionModelSelection(createParams({ sessionEntry }));

    expect(result).toMatchObject({
      status: "applied",
      thinkingRemap: {
        from: "adaptive",
        to: "medium",
        provider: "openai",
        model: "gpt-4o",
      },
    });
    expect(sessionEntry.thinkingLevel).toBe("medium");
    expect(sessionEntry.liveModelSwitchPending).toBe(true);
  });

  it("refreshes queued work when an idempotent selection only remaps thinking", async () => {
    const sessionEntry = createEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
      thinkingLevel: "adaptive",
    });
    const result = await applySessionModelSelection(
      createParams({ sessionEntry, currentProvider: "openai", currentModel: "gpt-4o" }),
    );

    expect(result).toMatchObject({ status: "applied", changed: true });
    expect(sessionEntry.thinkingLevel).toBe("medium");
    expect(effects.triggerSessionPatchHook).toHaveBeenCalledOnce();
    expect(effects.refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        nextThinking: expect.objectContaining({ level: "medium" }),
      }),
    );
  });

  it("uses the resolved parent or bound target session key for every effect", async () => {
    const sessionKey = "agent:main:telegram:bound:thread:42";
    await applySessionModelSelection(createParams({ sessionKey }));

    expect(effects.triggerSessionPatchHook).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey, patch: { key: sessionKey, model: "openai/gpt-4o" } }),
    );
    expect(effects.refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({ key: sessionKey }),
    );
    expect(effects.enqueueSystemEvent).toHaveBeenCalledWith(expect.any(String), {
      sessionKey,
      contextKey: "model:openai/gpt-4o",
    });
  });

  it.each([
    {
      name: "session replacement",
      concurrent: createEntry({ sessionId: "session-2", providerOverride: "anthropic" }),
    },
    {
      name: "model switch",
      concurrent: createEntry({
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "user",
        modelOverrideRouteResolution: "resolved",
      }),
    },
  ])("returns conflict without a hybrid row after concurrent $name", async ({ concurrent }) => {
    const tempRoot = tempDirs.make("openclaw-model-picker-service-");
    const storePath = path.join(tempRoot, "sessions.json");
    const sessionEntry = createEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    });
    const sessionKey = "agent:main:dm:race";
    await replaceSessionEntry({ sessionKey, storePath }, concurrent);

    const result = await applySessionModelSelection(
      createParams({ sessionKey, storePath, sessionEntry }),
    );
    expect(result).toEqual({
      status: "conflict",
      message: "Model change was not applied because the session changed. Retry.",
    });
    expect(lifecycleEvents).toEqual([]);
    expect(sessionEntry).toEqual(concurrent);
    expect(sessionEntry).not.toMatchObject({ modelOverride: "gpt-4o" });
    expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(effects.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("keeps idempotent model acknowledgement facts without duplicate effects", async () => {
    const sessionEntry = createEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
    });
    const result = await applySessionModelSelection(
      createParams({ sessionEntry, currentProvider: "openai", currentModel: "gpt-4o" }),
    );

    expect(result).toMatchObject({
      status: "applied",
      effectiveModelRef: "openai/gpt-4o",
      changed: false,
    });
    expect(lifecycleEvents).toEqual([]);
    expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(effects.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
