import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";

const effects = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(),
  info: vi.fn(),
  mutateConfigFileWithRetry: vi.fn(),
  refreshQueuedFollowupSession: vi.fn(),
  triggerSessionPatchHook: vi.fn(),
  warn: vi.fn(),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEventRaw: (...args: unknown[]) => effects.enqueueSystemEvent(...args),
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
    allowedModelKeys: new Set(["anthropic/claude-opus-4-6", "openai/gpt-4o"]),
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

describe("applySessionModelSelection", () => {
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
    },
    {
      name: "set idempotently",
      initial: "openclaw",
      runtime: { kind: "set", runtime: "openclaw" } as const,
      expected: "openclaw",
      runtimeChange: { kind: "set", runtime: "openclaw" },
    },
    {
      name: "clear",
      initial: "openclaw",
      runtime: { kind: "clear" } as const,
      expected: undefined,
      runtimeChange: { kind: "clear" },
    },
    {
      name: "clear idempotently",
      initial: undefined,
      runtime: { kind: "clear" } as const,
      expected: undefined,
      runtimeChange: { kind: "clear" },
    },
    {
      name: "unchanged",
      initial: "openclaw",
      runtime: { kind: "unchanged" } as const,
      expected: "openclaw",
      runtimeChange: undefined,
    },
  ])("supports runtime $name", async ({ initial, runtime, expected, runtimeChange }) => {
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
    }
    expect(sessionEntry.agentRuntimeOverride).toBe(expected);
  });

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

  it.each([
    {
      name: "allowlist",
      overrides: { allowedModelKeys: new Set(["anthropic/claude-opus-4-6"]) },
    },
    {
      name: "fresh catalog",
      overrides: { allowedModelKeys: new Set<string>(), modelCatalog: [catalog[0]!] },
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
    expect(effects.triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(effects.refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(effects.enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
