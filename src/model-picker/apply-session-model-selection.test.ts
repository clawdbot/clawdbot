import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";

const effects = vi.hoisted(() => ({
  enqueueSystemEvent: vi.fn(),
  refreshQueuedFollowupSession: vi.fn(),
  triggerSessionPatchHook: vi.fn(),
}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

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
    cfg: { agents: { defaults: { contextTokens: 12_000 } } },
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
      contextTokens: 12_000,
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
    expect(effects.refreshQueuedFollowupSession).toHaveBeenCalledOnce();
    expect(effects.enqueueSystemEvent).toHaveBeenCalledWith(
      "Model switched to Fast (openai/gpt-4o).",
      { sessionKey: "agent:main:dm:1", contextKey: "model:openai/gpt-4o" },
    );
  });

  it("resets to default and clears auth plus a provider-incompatible runtime", async () => {
    const sessionEntry = createEntry({
      providerOverride: "openai",
      modelOverride: "gpt-4o",
      modelOverrideSource: "user",
      modelOverrideRouteResolution: "resolved",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
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
    expect(sessionEntry.agentRuntimeOverride).toBeUndefined();
    expect(sessionEntry.agentHarnessId).toBe("codex");
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
