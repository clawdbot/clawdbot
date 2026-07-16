// Session patch tests cover model/provider edits, subagent patching, provider
// aliases, model catalog validation, and rejected invalid patch payloads.
import { afterEach, describe, expect, test, vi } from "vitest";
import { resetProviderAuthAliasMapCacheForTest } from "../agents/provider-auth-aliases.test-support.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE } from "../sessions/agent-harness-session-key.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
import { withAgentSessionModelPatchOrigin } from "./session-model-patch-origin.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";

const acpSessionMetaMocks = vi.hoisted(() => ({
  readAcpSessionMetaForEntry: vi.fn(),
}));

vi.mock("../acp/runtime/session-meta.js", () => ({
  readAcpSessionMetaForEntry: acpSessionMetaMocks.readAcpSessionMetaForEntry,
}));

const SUBAGENT_MODEL = "synthetic/hf:moonshotai/Kimi-K2.5";
const KIMI_SUBAGENT_KEY = "agent:kimi:subagent:child";
const MAIN_SESSION_KEY = "agent:main:main";
const ANTHROPIC_SONNET_MODEL = "anthropic/claude-sonnet-4-6";
const ANTHROPIC_SONNET_ID = "claude-sonnet-4-6";
const ANTHROPIC_OPUS_MODEL = "anthropic/claude-opus-4-6";
const ANTHROPIC_OPUS_ID = "claude-opus-4-6";
const OPENAI_GPT_MODEL = "openai/gpt-5.4";
const OPENAI_GPT_ID = "gpt-5.4";
const EMPTY_CFG = {} as OpenClawConfig;

type ApplySessionsPatchArgs = Parameters<typeof applySessionsPatchToStore>[0];

async function runPatch(params: {
  patch: ApplySessionsPatchArgs["patch"];
  store?: Record<string, SessionEntry>;
  cfg?: OpenClawConfig;
  storeKey?: string;
  agentId?: string;
  loadGatewayModelCatalog?: ApplySessionsPatchArgs["loadGatewayModelCatalog"];
}) {
  return applySessionsPatchToStore({
    cfg: params.cfg ?? EMPTY_CFG,
    store: params.store ?? {},
    storeKey: params.storeKey ?? MAIN_SESSION_KEY,
    agentId: params.agentId,
    patch: params.patch,
    loadGatewayModelCatalog: params.loadGatewayModelCatalog,
  });
}

function expectPatchOk(
  result: Awaited<ReturnType<typeof applySessionsPatchToStore>>,
): SessionEntry {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.entry;
}

function expectPatchError(
  result: Awaited<ReturnType<typeof applySessionsPatchToStore>>,
  message: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`Expected patch failure containing: ${message}`);
  }
  expect(result.error.message).toContain(message);
}

function mainStoreEntry(overrides: Partial<SessionEntry>): Record<string, SessionEntry> {
  return {
    [MAIN_SESSION_KEY]: {
      sessionId: "sess",
      updatedAt: 1,
      ...overrides,
    } as SessionEntry,
  };
}

function mainAuthOverrideStore(overrides: Partial<SessionEntry>): Record<string, SessionEntry> {
  return mainStoreEntry({
    providerOverride: "anthropic",
    modelOverride: ANTHROPIC_OPUS_ID,
    authProfileOverrideSource: "user",
    ...overrides,
  });
}

function catalogEntry(ref: string, name?: string) {
  const separator = ref.indexOf("/");
  if (separator < 0) {
    throw new Error(`model ref must include provider: ${ref}`);
  }
  const id = ref.slice(separator + 1);
  return {
    provider: ref.slice(0, separator),
    id,
    name: name ?? id,
  };
}

function loadCatalog(...refs: string[]): ApplySessionsPatchArgs["loadGatewayModelCatalog"] {
  return async () => refs.map((ref) => catalogEntry(ref));
}

function expectModelSelection(
  entry: SessionEntry,
  providerOverride: string | undefined,
  modelOverride: string | undefined,
) {
  expect(entry.providerOverride).toBe(providerOverride);
  expect(entry.modelOverride).toBe(modelOverride);
}

async function applyMainModelPatch(params: {
  store?: Record<string, SessionEntry>;
  cfg?: OpenClawConfig;
  model: string | null;
  catalogRefs?: string[];
}) {
  return expectPatchOk(
    await runPatch({
      store: params.store,
      cfg: params.cfg,
      patch: { key: MAIN_SESSION_KEY, model: params.model },
      loadGatewayModelCatalog:
        params.catalogRefs === undefined ? undefined : loadCatalog(...params.catalogRefs),
    }),
  );
}

async function expectProviderChangeClearsAuthOverride(store: Record<string, SessionEntry>) {
  const entry = await applyMainModelPatch({
    store,
    model: OPENAI_GPT_MODEL,
    catalogRefs: [OPENAI_GPT_MODEL],
  });
  expectModelSelection(entry, "openai", OPENAI_GPT_ID);
  expectAuthOverride(entry, { profile: undefined });
}

function expectAuthOverride(
  entry: SessionEntry,
  expected: {
    profile: string | undefined;
    source?: string;
    compactionCount?: number;
  },
) {
  expect(entry.authProfileOverride).toBe(expected.profile);
  if (expected.profile === undefined) {
    expect(entry.authProfileOverrideSource).toBeUndefined();
    expect(entry.authProfileOverrideCompactionCount).toBeUndefined();
    return;
  }
  expect(entry.authProfileOverrideSource).toBe(expected.source ?? "user");
  if (expected.compactionCount === undefined) {
    expect(entry.authProfileOverrideCompactionCount).toBeUndefined();
  } else {
    expect(entry.authProfileOverrideCompactionCount).toBe(expected.compactionCount);
  }
}

async function applySubagentModelPatch(cfg: OpenClawConfig) {
  return expectPatchOk(
    await runPatch({
      cfg,
      storeKey: KIMI_SUBAGENT_KEY,
      patch: {
        key: KIMI_SUBAGENT_KEY,
        model: SUBAGENT_MODEL,
      },
      loadGatewayModelCatalog: async () => [
        { provider: "anthropic", id: ANTHROPIC_SONNET_ID, name: "sonnet" },
        { provider: "synthetic", id: "hf:moonshotai/Kimi-K2.5", name: "kimi" },
      ],
    }),
  );
}

function makeKimiSubagentCfg(params: {
  agentPrimaryModel?: string;
  agentSubagentModel?: string;
  defaultsSubagentModel?: string;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-6" },
        subagents: params.defaultsSubagentModel
          ? { model: params.defaultsSubagentModel }
          : undefined,
        models: {
          "anthropic/claude-sonnet-4-6": { alias: "default" },
        },
      },
      list: [
        {
          id: "kimi",
          model: params.agentPrimaryModel ? { primary: params.agentPrimaryModel } : undefined,
          subagents: params.agentSubagentModel ? { model: params.agentSubagentModel } : undefined,
        },
      ],
    },
  } as OpenClawConfig;
}

function createAllowlistedAnthropicModelCfg(): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: OPENAI_GPT_MODEL },
        models: {
          [ANTHROPIC_SONNET_MODEL]: { alias: "sonnet" },
        },
      },
    },
  } as OpenClawConfig;
}

describe("gateway sessions patch", () => {
  afterEach(() => {
    acpSessionMetaMocks.readAcpSessionMetaForEntry.mockReset();
    resetProviderAuthAliasMapCacheForTest();
    resetPluginRuntimeStateForTest();
  });

  test("rejects creating a missing agent harness session through patch", async () => {
    const key = "agent:main:harness:codex:supervision:missing";
    const store: Record<string, SessionEntry> = {};

    expectPatchError(
      await runPatch({
        store,
        storeKey: key,
        patch: { key, label: "squat" },
      }),
      AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE,
    );
    expect(store[key]).toBeUndefined();
  });

  test("allows patching an existing agent harness session", async () => {
    const key = "agent:main:harness:codex:supervision:existing";
    const store: Record<string, SessionEntry> = {
      [key]: {
        sessionId: "harness-session",
        updatedAt: 1,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    };

    const entry = expectPatchOk(
      await runPatch({
        store,
        storeKey: key,
        patch: { key, label: "kept" },
      }),
    );
    expect(entry.label).toBe("kept");
    expect(store[key]).toMatchObject({
      sessionId: "harness-session",
      label: "kept",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });
  });

  test("archives and restores sessions without retaining a pin", async () => {
    const archived = expectPatchOk(
      await runPatch({
        store: mainStoreEntry({ pinnedAt: 10 }),
        patch: { key: MAIN_SESSION_KEY, archived: true },
      }),
    );
    expect(archived.archivedAt).toEqual(expect.any(Number));
    expect(archived.pinnedAt).toBeUndefined();

    const restored = expectPatchOk(
      await runPatch({
        store: mainStoreEntry({ archivedAt: archived.archivedAt }),
        patch: { key: MAIN_SESSION_KEY, archived: false },
      }),
    );
    expect(restored.archivedAt).toBeUndefined();
  });

  test("pins active sessions and rejects pinned archived sessions", async () => {
    const pinned = expectPatchOk(
      await runPatch({ patch: { key: MAIN_SESSION_KEY, pinned: true } }),
    );
    expect(pinned.pinnedAt).toEqual(expect.any(Number));

    expectPatchError(
      await runPatch({
        store: mainStoreEntry({ archivedAt: 10 }),
        patch: { key: MAIN_SESSION_KEY, pinned: true },
      }),
      "restore it first",
    );
  });

  test("marks archived sessions unread and clears the marker when read", async () => {
    const store = mainStoreEntry({ archivedAt: 10, lastReadAt: 20 });
    const unread = expectPatchOk(
      await runPatch({ store, patch: { key: MAIN_SESSION_KEY, unread: true } }),
    );
    expect(unread.archivedAt).toBe(10);
    expect(unread.lastReadAt).toBe(20);
    expect(unread.markedUnreadAt).toEqual(expect.any(Number));

    const read = expectPatchOk(
      await runPatch({ store, patch: { key: MAIN_SESSION_KEY, unread: false } }),
    );
    expect(read.archivedAt).toBe(10);
    expect(read.lastReadAt).toEqual(expect.any(Number));
    expect(read.lastReadAt).toBeGreaterThanOrEqual(unread.markedUnreadAt ?? 0);
    expect(read.markedUnreadAt).toBeUndefined();
  });

  test("persists thinkingLevel=off (does not clear)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, thinkingLevel: "off" },
      }),
    );
    expect(entry.thinkingLevel).toBe("off");
  });

  test("clears thinkingLevel when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: { thinkingLevel: "low" } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, thinkingLevel: null },
      }),
    );
    expect(entry.thinkingLevel).toBeUndefined();
  });

  test("persists responseUsage=off (does not clear)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, responseUsage: "off" },
      }),
    );
    // Explicit off must persist so a configured messages.responseUsage default
    // cannot re-enable the footer the user turned off.
    expect(entry.responseUsage).toBe("off");
  });

  test("clears responseUsage when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: { responseUsage: "tokens" } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, responseUsage: null },
      }),
    );
    expect(entry.responseUsage).toBeUndefined();
  });

  test("persists reasoningLevel=off (does not clear)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, reasoningLevel: "off" },
      }),
    );
    expect(entry.reasoningLevel).toBe("off");
  });

  test("clears reasoningLevel when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: { reasoningLevel: "stream" } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, reasoningLevel: null },
      }),
    );
    expect(entry.reasoningLevel).toBeUndefined();
  });

  test("persists fastMode=false (does not clear)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, fastMode: false },
      }),
    );
    expect(entry.fastMode).toBe(false);
  });

  test("persists fastMode=true", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, fastMode: true },
      }),
    );
    expect(entry.fastMode).toBe(true);
  });

  test("recreates partial rows without dropping session settings", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        updatedAt: 1,
        sessionFile: "stale.jsonl",
        label: "Stale Session",
        sendPolicy: "deny",
        modelOverride: OPENAI_GPT_ID,
        responseUsage: "tokens",
        parentSessionKey: "agent:main:main",
      } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, fastMode: true },
      }),
    );

    expect(entry.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(entry.sessionFile).toBeUndefined();
    expect(entry.label).toBeUndefined();
    expect(entry.sendPolicy).toBe("deny");
    expect(entry.modelOverride).toBe(OPENAI_GPT_ID);
    expect(entry.responseUsage).toBe("tokens");
    expect(entry.parentSessionKey).toBe("agent:main:main");
    expect(entry.fastMode).toBe(true);
  });

  test("persists, trims, and clears category", async () => {
    const store = mainStoreEntry({});
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, category: "  Research  " },
      }),
    );
    expect(entry.category).toBe("Research");

    const cleared = expectPatchOk(
      await runPatch({
        store: mainStoreEntry({ category: "Research" }),
        patch: { key: MAIN_SESSION_KEY, category: null },
      }),
    );
    expect(cleared.category).toBeUndefined();
  });

  test("allows duplicate categories across sessions", async () => {
    const store: Record<string, SessionEntry> = {
      ...mainStoreEntry({}),
      "agent:main:discord:channel:123": {
        sessionId: "other",
        updatedAt: 1,
        category: "Research",
      } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, category: "Research" },
      }),
    );
    expect(entry.category).toBe("Research");
  });

  test("rejects empty category", async () => {
    expectPatchError(
      await runPatch({
        store: mainStoreEntry({}),
        patch: { key: MAIN_SESSION_KEY, category: "   " },
      }),
      "invalid category: empty",
    );
  });

  test("clears fastMode when patch sets null", async () => {
    const store = mainStoreEntry({ fastMode: true });
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, fastMode: null },
      }),
    );
    expect(entry.fastMode).toBeUndefined();
  });

  test("sets fastMode to auto", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {} as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, fastMode: "auto" },
      }),
    );

    expect(entry.fastMode).toBe("auto");
  });

  test("persists verboseLevel=full", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, verboseLevel: "full" },
      }),
    );
    expect(entry.verboseLevel).toBe("full");
  });

  test("rejects invalid verboseLevel values with all valid choices in the error", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, verboseLevel: "maybe" },
    });
    expectPatchError(result, 'invalid verboseLevel (use "on"|"off"|"full")');
  });

  test("persists elevatedLevel=off (does not clear)", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, elevatedLevel: "off" },
      }),
    );
    expect(entry.elevatedLevel).toBe("off");
  });

  test("persists elevatedLevel=on", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: { key: MAIN_SESSION_KEY, elevatedLevel: "on" },
      }),
    );
    expect(entry.elevatedLevel).toBe("on");
  });

  test("clears elevatedLevel when patch sets null", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: { elevatedLevel: "off" } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({
        store,
        patch: { key: MAIN_SESSION_KEY, elevatedLevel: null },
      }),
    );
    expect(entry.elevatedLevel).toBeUndefined();
  });

  test("rejects invalid elevatedLevel values", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, elevatedLevel: "maybe" },
    });
    expectPatchError(result, "invalid elevatedLevel");
  });

  test("preserves same-provider auth overrides when model patch changes", async () => {
    const store = mainAuthOverrideStore({
      authProfileOverride: "anthropic:default",
      authProfileOverrideCompactionCount: 3,
    });
    const entry = await applyMainModelPatch({
      store,
      model: ANTHROPIC_SONNET_MODEL,
      catalogRefs: [ANTHROPIC_SONNET_MODEL],
    });
    expectModelSelection(entry, "anthropic", ANTHROPIC_SONNET_ID);
    expectAuthOverride(entry, { profile: "anthropic:default", compactionCount: 3 });
  });

  test("preserves auth overrides for provider-auth aliases when model patch changes", async () => {
    const store = mainStoreEntry({
      sessionId: "sess-alias",
      providerOverride: "byteplus",
      modelOverride: "seedance-1-0-lite-t2v-250428",
      authProfileOverride: "byteplus:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    });
    const entry = await applyMainModelPatch({
      store,
      model: "byteplus-plan/ark-code-latest",
      catalogRefs: ["byteplus-plan/ark-code-latest"],
    });
    expectModelSelection(entry, "byteplus-plan", "ark-code-latest");
    expectAuthOverride(entry, { profile: "byteplus:work", compactionCount: 2 });
  });

  test("preserves unprefixed auth overrides when existing provider matches model patch", async () => {
    const store = mainAuthOverrideStore({
      sessionId: "sess-unprefixed-same-provider",
      authProfileOverride: "work",
      authProfileOverrideCompactionCount: 4,
    });
    const entry = await applyMainModelPatch({
      store,
      model: ANTHROPIC_SONNET_MODEL,
      catalogRefs: [ANTHROPIC_SONNET_MODEL],
    });
    expectModelSelection(entry, "anthropic", ANTHROPIC_SONNET_ID);
    expectAuthOverride(entry, { profile: "work", compactionCount: 4 });
  });

  test("preserves unprefixed auth overrides when existing provider is the default", async () => {
    const store = mainStoreEntry({
      sessionId: "sess-unprefixed-default-provider",
      authProfileOverride: "work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 4,
    });
    const entry = await applyMainModelPatch({
      cfg: {
        agents: {
          defaults: {
            model: { primary: `anthropic/${ANTHROPIC_OPUS_ID}` },
          },
        },
      } as OpenClawConfig,
      store,
      model: ANTHROPIC_SONNET_MODEL,
      catalogRefs: [ANTHROPIC_SONNET_MODEL],
    });
    expectModelSelection(entry, "anthropic", ANTHROPIC_SONNET_ID);
    expectAuthOverride(entry, { profile: "work", compactionCount: 4 });
  });

  test("clears unprefixed auth overrides when model patch changes provider", async () => {
    await expectProviderChangeClearsAuthOverride(
      mainAuthOverrideStore({
        sessionId: "sess-unprefixed-provider-change",
        authProfileOverride: "work",
        authProfileOverrideCompactionCount: 4,
      }),
    );
  });

  test("clears provider-prefixed auth overrides when model patch changes provider", async () => {
    await expectProviderChangeClearsAuthOverride(
      mainAuthOverrideStore({
        sessionId: "sess-provider-change",
        authProfileOverride: "anthropic:default",
        authProfileOverrideCompactionCount: 3,
      }),
    );
  });

  test.each([
    { name: "change", model: ANTHROPIC_SONNET_MODEL },
    { name: "reset", model: null },
  ])("rejects locked model $name patches before catalog loading", async ({ model }) => {
    const store = mainStoreEntry({
      sessionId: "sess-model-locked",
      providerOverride: "openai",
      modelOverride: OPENAI_GPT_ID,
      modelSelectionLocked: true,
    });
    const before = { ...store[MAIN_SESSION_KEY] };
    const loadGatewayModelCatalog = vi.fn(loadCatalog(ANTHROPIC_SONNET_MODEL));

    const result = await runPatch({
      store,
      cfg: createAllowlistedAnthropicModelCfg(),
      patch: { key: MAIN_SESSION_KEY, model },
      loadGatewayModelCatalog,
    });

    expectPatchError(result, MODEL_SELECTION_LOCKED_MESSAGE);
    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
    expect(store[MAIN_SESSION_KEY]).toEqual(before);
  });

  test("allows non-model metadata patches for model-locked sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        store: mainStoreEntry({ modelSelectionLocked: true }),
        patch: { key: MAIN_SESSION_KEY, label: "Remote Codex task" },
      }),
    );

    expect(entry.modelSelectionLocked).toBe(true);
    expect(entry.label).toBe("Remote Codex task");
  });

  test("marks explicit model patches as pending live model switches", async () => {
    const store = mainStoreEntry({
      sessionId: "sess-live",
      providerOverride: "openai",
      modelOverride: OPENAI_GPT_ID,
    });
    const entry = await applyMainModelPatch({
      store,
      cfg: createAllowlistedAnthropicModelCfg(),
      model: ANTHROPIC_SONNET_MODEL,
      catalogRefs: [OPENAI_GPT_MODEL, ANTHROPIC_SONNET_MODEL],
    });

    expectModelSelection(entry, "anthropic", ANTHROPIC_SONNET_ID);
    expect(entry.liveModelSwitchPending).toBe(true);
  });

  test("clears an agent model rollback marker on explicit model patches", async () => {
    const store = mainStoreEntry({
      sessionId: "sess-agent-model-patch",
      modelFallback: {
        prevModel: OPENAI_GPT_ID,
        prevProvider: "openai",
        ts: 1,
        source: "agent-patch",
      },
    });
    const entry = await applyMainModelPatch({
      store,
      cfg: createAllowlistedAnthropicModelCfg(),
      model: ANTHROPIC_SONNET_MODEL,
      catalogRefs: [OPENAI_GPT_MODEL, ANTHROPIC_SONNET_MODEL],
    });

    expect(entry.modelFallback).toBeUndefined();
  });

  test("atomically snapshots prior selection for agent model patches", async () => {
    const store = mainStoreEntry({
      providerOverride: "openai",
      modelOverride: OPENAI_GPT_ID,
      modelOverrideSource: "auto",
      modelOverrideFallbackOriginProvider: "openai",
      modelOverrideFallbackOriginModel: "gpt-primary",
      authProfileOverride: "openai:good",
      authProfileOverrideSource: "user",
      thinkingLevel: "high",
    });
    const entry = await withAgentSessionModelPatchOrigin(
      async () =>
        await applyMainModelPatch({
          store,
          cfg: createAllowlistedAnthropicModelCfg(),
          model: ANTHROPIC_SONNET_MODEL,
          catalogRefs: [OPENAI_GPT_MODEL, ANTHROPIC_SONNET_MODEL],
        }),
    );

    expect(entry.modelFallback).toMatchObject({
      prevModel: OPENAI_GPT_ID,
      prevProvider: "openai",
      prevModelOverrideSource: "auto",
      prevModelOverrideFallbackOriginProvider: "openai",
      prevModelOverrideFallbackOriginModel: "gpt-primary",
      prevAuthProfileOverride: "openai:good",
      prevThinkingLevel: "high",
      source: "agent-patch",
    });
  });

  test("keeps the last validated model across consecutive agent patches", async () => {
    const cfg = createAllowlistedAnthropicModelCfg();
    cfg.agents!.defaults!.models![ANTHROPIC_OPUS_MODEL] = { alias: "opus" };
    const first = await withAgentSessionModelPatchOrigin(
      async () =>
        await applyMainModelPatch({
          store: mainStoreEntry({
            providerOverride: "openai",
            modelOverride: OPENAI_GPT_ID,
          }),
          cfg,
          model: ANTHROPIC_SONNET_MODEL,
          catalogRefs: [OPENAI_GPT_MODEL, ANTHROPIC_SONNET_MODEL],
        }),
    );
    const firstMarker = first.modelFallback;
    expect(firstMarker).toMatchObject({
      prevModel: OPENAI_GPT_ID,
      prevProvider: "openai",
    });

    const second = await withAgentSessionModelPatchOrigin(
      async () =>
        await applyMainModelPatch({
          store: { [MAIN_SESSION_KEY]: first },
          cfg,
          model: ANTHROPIC_OPUS_MODEL,
          catalogRefs: [OPENAI_GPT_MODEL, ANTHROPIC_SONNET_MODEL, ANTHROPIC_OPUS_MODEL],
        }),
    );

    expect(second.modelFallback).toMatchObject({
      prevModel: OPENAI_GPT_ID,
      prevProvider: "openai",
    });
    expect(second.modelFallback?.ts).toBeGreaterThan(firstMarker?.ts ?? 0);
  });

  test("realigns the model-revert marker with an independent thinkingLevel change", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        thinkingLevel: "high",
        modelOverride: ANTHROPIC_SONNET_ID,
        providerOverride: "anthropic",
        modelFallback: {
          prevModel: OPENAI_GPT_ID,
          prevProvider: "openai",
          prevThinkingLevel: "high",
          ts: 1,
          source: "agent-patch",
        },
      } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({ store, patch: { key: MAIN_SESSION_KEY, thinkingLevel: "low" } }),
    );
    // The model-revert target still points at the pre-switch model, but its
    // thinkingLevel restore now honors the user's newer choice instead of "high".
    expect(entry.thinkingLevel).toBe("low");
    expect(entry.modelFallback).toMatchObject({
      prevModel: OPENAI_GPT_ID,
      prevProvider: "openai",
      prevThinkingLevel: "low",
      ts: 1,
      source: "agent-patch",
    });
  });

  test("clears the marker thinkingLevel restore when the user clears thinkingLevel", async () => {
    const store: Record<string, SessionEntry> = {
      [MAIN_SESSION_KEY]: {
        thinkingLevel: "high",
        modelFallback: {
          prevModel: OPENAI_GPT_ID,
          prevProvider: "openai",
          prevThinkingLevel: "high",
          ts: 1,
          source: "agent-patch",
        },
      } as SessionEntry,
    };
    const entry = expectPatchOk(
      await runPatch({ store, patch: { key: MAIN_SESSION_KEY, thinkingLevel: null } }),
    );
    expect(entry.thinkingLevel).toBeUndefined();
    expect(entry.modelFallback?.prevThinkingLevel).toBeUndefined();
    expect(entry.modelFallback?.prevModel).toBe(OPENAI_GPT_ID);
  });

  test("clears pending live model switches for model reset patches", async () => {
    const store = mainStoreEntry({
      sessionId: "sess-live-reset",
      providerOverride: "anthropic",
      modelOverride: ANTHROPIC_SONNET_ID,
      modelOverrideSource: "user",
      liveModelSwitchPending: true,
    });
    const entry = await applyMainModelPatch({
      store,
      cfg: createAllowlistedAnthropicModelCfg(),
      model: null,
    });

    expectModelSelection(entry, undefined, undefined);
    expect(entry.modelOverrideSource).toBeUndefined();
    expect(entry.liveModelSwitchPending).toBeUndefined();
  });

  test.each([
    {
      name: "accepts explicit allowlisted provider/model refs from sessions.patch",
      catalog: [
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.5" },
      ],
    },
    {
      name: "accepts explicit allowlisted refs absent from bundled catalog",
      catalog: [
        { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.5" },
        { provider: "openai", id: "gpt-5.4", name: "GPT-5.2" },
      ],
    },
  ])("$name", async ({ catalog }) => {
    const entry = expectPatchOk(
      await runPatch({
        cfg: createAllowlistedAnthropicModelCfg(),
        patch: { key: MAIN_SESSION_KEY, model: ANTHROPIC_SONNET_MODEL },
        loadGatewayModelCatalog: async () => catalog,
      }),
    );
    expectModelSelection(entry, "anthropic", ANTHROPIC_SONNET_ID);
  });

  test("persists provider-qualified aliases without cross-provider collisions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        cfg: {
          agents: {
            defaults: {
              model: { primary: OPENAI_GPT_MODEL },
              models: {
                "lmstudio-moe/qwen3.6-35b-a3b": { alias: "Local" },
                "lmstudio-dense/qwen3.6-27b": { alias: "Local" },
              },
            },
          },
        } as OpenClawConfig,
        patch: { key: MAIN_SESSION_KEY, model: "lmstudio-moe/Local" },
        loadGatewayModelCatalog: loadCatalog(
          "lmstudio-moe/qwen3.6-35b-a3b",
          "lmstudio-dense/qwen3.6-27b",
        ),
      }),
    );

    expectModelSelection(entry, "lmstudio-moe", "qwen3.6-35b-a3b");
    expect(entry.modelOverrideSource).toBe("user");
  });

  test("sets spawnDepth for subagent sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        storeKey: "agent:main:subagent:child",
        patch: { key: "agent:main:subagent:child", spawnDepth: 2 },
      }),
    );
    expect(entry.spawnDepth).toBe(2);
  });

  test("validates thinking patches with live catalog reasoning metadata", async () => {
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "ollama",
      source: "test",
      provider: {
        id: "ollama",
        label: "Ollama",
        auth: [],
        resolveThinkingProfile: ({ reasoning }) => ({
          levels:
            reasoning === true
              ? [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "high" }, { id: "max" }]
              : [{ id: "off" }],
          defaultLevel: "off",
        }),
      },
    });
    setActivePluginRegistry(registry);

    const entry = expectPatchOk(
      await runPatch({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "ollama/qwen3:0.6b" },
            },
          },
        } as OpenClawConfig,
        patch: {
          key: MAIN_SESSION_KEY,
          thinkingLevel: "medium",
        },
        loadGatewayModelCatalog: async () => [
          {
            provider: "ollama",
            id: "qwen3:0.6b",
            name: "qwen3:0.6b",
            reasoning: true,
          },
        ],
      }),
    );

    expect(entry.thinkingLevel).toBe("medium");
  });

  test("accepts xhigh thinking patches from configured catalog compat", async () => {
    const entry = expectPatchOk(
      await runPatch({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "gmn/gpt-5.4" },
            },
          },
        } as OpenClawConfig,
        patch: {
          key: MAIN_SESSION_KEY,
          thinkingLevel: "xhigh",
        },
        loadGatewayModelCatalog: async () => [
          {
            provider: "gmn",
            id: "gpt-5.4",
            name: "GPT 5.4 via GMN",
            reasoning: true,
            compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
          },
        ],
      }),
    );

    expect(entry.thinkingLevel).toBe("xhigh");
  });

  test("validates global patches against the selected agent", async () => {
    const entry = expectPatchOk(
      await runPatch({
        cfg: {
          agents: {
            list: [
              {
                id: "main",
                default: true,
                model: { primary: "gmn/gpt-5.4" },
              },
              {
                id: "work",
                model: { primary: "openai/gpt-5.5" },
              },
            ],
          },
        } as OpenClawConfig,
        storeKey: "global",
        agentId: "work",
        patch: {
          key: "global",
          thinkingLevel: "xhigh",
        },
        loadGatewayModelCatalog: async () => [],
      }),
    );

    expect(entry.thinkingLevel).toBe("xhigh");
  });

  test("accepts xhigh thinking patches from bundled startup-lazy provider policy without catalog", async () => {
    const entry = expectPatchOk(
      await runPatch({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.5" },
            },
          },
        } as OpenClawConfig,
        patch: {
          key: MAIN_SESSION_KEY,
          thinkingLevel: "xhigh",
        },
        loadGatewayModelCatalog: async () => [],
      }),
    );

    expect(entry.thinkingLevel).toBe("xhigh");
  });

  test("persists OpenClaw Luna Ultra through the runtime-aware provider profile", async () => {
    const entry = expectPatchOk(
      await runPatch({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.6-luna" },
              models: {
                "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
        } as OpenClawConfig,
        patch: { key: MAIN_SESSION_KEY, thinkingLevel: "ultra" },
        loadGatewayModelCatalog: async () => [],
      }),
    );

    expect(entry.thinkingLevel).toBe("ultra");
  });

  test("remaps stored Ultra to Max when a model patch selects Codex Luna", async () => {
    const entry = expectPatchOk(
      await runPatch({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.6-sol" },
              models: {
                "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
              },
            },
          },
        } as OpenClawConfig,
        store: mainStoreEntry({ thinkingLevel: "ultra" }),
        patch: { key: MAIN_SESSION_KEY, model: "openai/gpt-5.6-luna" },
        loadGatewayModelCatalog: loadCatalog("openai/gpt-5.6-sol", "openai/gpt-5.6-luna"),
      }),
    );

    expect(entry.thinkingLevel).toBe("max");
  });

  test("honors an explicit OpenClaw session runtime override for Luna Ultra", async () => {
    const entry = expectPatchOk(
      await runPatch({
        cfg: {
          agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
        } as OpenClawConfig,
        store: mainStoreEntry({
          agentRuntimeOverride: "openclaw",
          agentHarnessId: "codex",
        }),
        patch: { key: MAIN_SESSION_KEY, thinkingLevel: "ultra" },
        loadGatewayModelCatalog: async () => [],
      }),
    );

    expect(entry.thinkingLevel).toBe("ultra");
  });

  test("uses ACP backend metadata on canonical agent keys for thinking validation", async () => {
    acpSessionMetaMocks.readAcpSessionMetaForEntry.mockReturnValue({
      backend: "codex",
      agent: "main",
      runtimeSessionName: MAIN_SESSION_KEY,
      mode: "persistent",
      state: "idle",
      lastActivityAt: 1,
    });

    const result = await runPatch({
      cfg: {
        agents: {
          defaults: {
            model: { primary: "openai/gpt-5.6-luna" },
            models: {
              "openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
      } as OpenClawConfig,
      store: mainStoreEntry({}),
      patch: { key: MAIN_SESSION_KEY, thinkingLevel: "ultra" },
      loadGatewayModelCatalog: async () => [],
    });

    expectPatchError(result, 'thinkingLevel "ultra" is not supported');
    expect(acpSessionMetaMocks.readAcpSessionMetaForEntry).toHaveBeenCalledWith({
      sessionKey: MAIN_SESSION_KEY,
      entry: expect.objectContaining({ sessionId: "sess" }),
    });
  });

  test("treats the persisted harness id as observational when validating Luna Ultra", async () => {
    const result = await runPatch({
      cfg: {
        agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
      } as OpenClawConfig,
      store: mainStoreEntry({ agentHarnessId: "openclaw" }),
      patch: { key: MAIN_SESSION_KEY, thinkingLevel: "ultra" },
      loadGatewayModelCatalog: async () => [],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("not supported");
    }
  });

  test("preserves an incompatible stored thinkingLevel without loading the catalog for unrelated patches", async () => {
    const loadGatewayModelCatalog = vi.fn(async () => [
      { provider: "synthetic", id: "plain", name: "plain", reasoning: false },
    ]);
    const entry = expectPatchOk(
      await runPatch({
        cfg: {
          agents: { defaults: { model: { primary: "synthetic/plain" } } },
        } as OpenClawConfig,
        store: mainStoreEntry({ thinkingLevel: "max" }),
        patch: { key: MAIN_SESSION_KEY, label: "new label" },
        loadGatewayModelCatalog,
      }),
    );

    expect(loadGatewayModelCatalog).not.toHaveBeenCalled();
    expect(entry).toMatchObject({ label: "new label", thinkingLevel: "max" });
  });

  test("sets spawnedBy for ACP sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        storeKey: "agent:main:acp:child",
        patch: {
          key: "agent:main:acp:child",
          spawnedBy: "agent:main:main",
        },
      }),
    );
    expect(entry.spawnedBy).toBe("agent:main:main");
  });

  test("sets spawnedWorkspaceDir for subagent sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        storeKey: "agent:main:subagent:child",
        patch: {
          key: "agent:main:subagent:child",
          spawnedWorkspaceDir: "/tmp/subagent-workspace",
        },
      }),
    );
    expect(entry.spawnedWorkspaceDir).toBe("/tmp/subagent-workspace");
  });

  test("sets spawnDepth for ACP sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        storeKey: "agent:main:acp:child",
        patch: { key: "agent:main:acp:child", spawnDepth: 2 },
      }),
    );
    expect(entry.spawnDepth).toBe(2);
  });

  test("sets inheritedToolDeny for ACP sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        storeKey: "agent:main:acp:child",
        patch: { key: "agent:main:acp:child", inheritedToolDeny: ["bash", "read", "bash"] },
      }),
    );
    expect(entry.inheritedToolDeny).toEqual(["exec", "read"]);
  });

  test("sets inheritedToolAllow for ACP sessions", async () => {
    const entry = expectPatchOk(
      await runPatch({
        storeKey: "agent:main:acp:child",
        patch: {
          key: "agent:main:acp:child",
          inheritedToolAllow: ["sessions_spawn", "read", "sessions_spawn"],
        },
      }),
    );
    expect(entry.inheritedToolAllow).toEqual(["sessions_spawn", "read"]);
  });

  test("preserves inheritedToolDeny entries beyond large configured lists", async () => {
    const configuredDeny = Array.from({ length: 150 }, (_, index) => `custom_${index}`);
    const entry = expectPatchOk(
      await runPatch({
        storeKey: "agent:main:subagent:child",
        patch: {
          key: "agent:main:subagent:child",
          inheritedToolDeny: [...configuredDeny, "exec"],
        },
      }),
    );
    expect(entry.inheritedToolDeny).toHaveLength(151);
    expect(entry.inheritedToolDeny?.at(-1)).toBe("exec");
  });

  test("rejects spawnDepth on non-subagent sessions", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, spawnDepth: 1 },
    });
    expectPatchError(result, "spawnDepth is only supported");
  });

  test("rejects spawnedWorkspaceDir on non-subagent sessions", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, spawnedWorkspaceDir: "/tmp/nope" },
    });
    expectPatchError(result, "spawnedWorkspaceDir is only supported");
  });

  test("rejects inheritedToolDeny on non-subagent sessions", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, inheritedToolDeny: ["exec"] },
    });
    expectPatchError(result, "inheritedToolDeny is only supported");
  });

  test("rejects inheritedToolAllow on non-subagent sessions", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, inheritedToolAllow: ["read"] },
    });
    expectPatchError(result, "inheritedToolAllow is only supported");
  });

  test("normalizes exec/send/group patches", async () => {
    const entry = expectPatchOk(
      await runPatch({
        patch: {
          key: MAIN_SESSION_KEY,
          execHost: " AUTO ",
          execSecurity: " ALLOWLIST ",
          execAsk: " ON-MISS ",
          execNode: " worker-1 ",
          sendPolicy: "DENY" as unknown as "allow",
          groupActivation: "Always" as unknown as "mention",
        },
      }),
    );
    expect(entry.execHost).toBe("auto");
    expect(entry.execSecurity).toBe("allowlist");
    expect(entry.execAsk).toBe("on-miss");
    expect(entry.execNode).toBe("worker-1");
    expect(entry.sendPolicy).toBe("deny");
    expect(entry.groupActivation).toBe("always");
  });

  test("clears a node cwd when changing or clearing the node binding", async () => {
    const store = mainStoreEntry({
      execHost: "node",
      execNode: "worker-1",
      execCwd: "/workspace/on-worker-1",
    });
    const changed = expectPatchOk(
      await runPatch({ store, patch: { key: MAIN_SESSION_KEY, execNode: "worker-2" } }),
    );
    expect(changed.execNode).toBe("worker-2");
    expect(changed.execCwd).toBeUndefined();

    const cleared = expectPatchOk(
      await runPatch({
        store: mainStoreEntry({
          execHost: "node",
          execNode: "worker-1",
          execCwd: "/workspace/on-worker-1",
        }),
        patch: { key: MAIN_SESSION_KEY, execNode: null },
      }),
    );
    expect(cleared.execNode).toBeUndefined();
    expect(cleared.execCwd).toBeUndefined();
  });

  test("rejects invalid execHost values", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, execHost: "edge" },
    });
    expectPatchError(result, "invalid execHost");
  });

  test("rejects invalid sendPolicy values", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, sendPolicy: "ask" as unknown as "allow" },
    });
    expectPatchError(result, "invalid sendPolicy");
  });

  test("rejects invalid groupActivation values", async () => {
    const result = await runPatch({
      patch: { key: MAIN_SESSION_KEY, groupActivation: "never" as unknown as "mention" },
    });
    expectPatchError(result, "invalid groupActivation");
  });

  test("allows target agent own model for subagent session even when missing from global allowlist", async () => {
    const cfg = makeKimiSubagentCfg({
      agentPrimaryModel: SUBAGENT_MODEL,
    });

    const entry = await applySubagentModelPatch(cfg);
    // Selected model matches the target agent default, so no override is stored.
    expect(entry.providerOverride).toBeUndefined();
    expect(entry.modelOverride).toBeUndefined();
  });

  test("allows target agent subagents.model for subagent session even when missing from global allowlist", async () => {
    const cfg = makeKimiSubagentCfg({
      agentPrimaryModel: ANTHROPIC_SONNET_MODEL,
      agentSubagentModel: SUBAGENT_MODEL,
    });

    const entry = await applySubagentModelPatch(cfg);
    expectModelSelection(entry, "synthetic", "hf:moonshotai/Kimi-K2.5");
  });

  test("allows global defaults.subagents.model for subagent session even when missing from global allowlist", async () => {
    const cfg = makeKimiSubagentCfg({
      defaultsSubagentModel: SUBAGENT_MODEL,
    });

    const entry = await applySubagentModelPatch(cfg);
    expectModelSelection(entry, "synthetic", "hf:moonshotai/Kimi-K2.5");
  });

  test("persists trailing @profile suffix as authProfileOverride on model patch", async () => {
    const entry = await applyMainModelPatch({
      cfg: createAllowlistedAnthropicModelCfg(),
      model: `${ANTHROPIC_SONNET_MODEL}@myprofile`,
      catalogRefs: [ANTHROPIC_SONNET_MODEL],
    });
    expectModelSelection(entry, "anthropic", ANTHROPIC_SONNET_ID);
    expectAuthOverride(entry, { profile: "myprofile" });
    expect(entry.liveModelSwitchPending).toBe(true);
  });

  test("marks same-model @profile patches as pending live model switches", async () => {
    const store = mainStoreEntry({
      sessionId: "sess-live-profile-only",
      providerOverride: "anthropic",
      modelOverride: ANTHROPIC_SONNET_ID,
      authProfileOverride: "oldprofile",
      authProfileOverrideSource: "user",
    });
    const entry = await applyMainModelPatch({
      store,
      cfg: createAllowlistedAnthropicModelCfg(),
      model: `${ANTHROPIC_SONNET_MODEL}@newprofile`,
      catalogRefs: [ANTHROPIC_SONNET_MODEL],
    });
    expectModelSelection(entry, "anthropic", ANTHROPIC_SONNET_ID);
    expectAuthOverride(entry, { profile: "newprofile" });
    expect(entry.liveModelSwitchPending).toBe(true);
  });

  test("does not set authProfileOverride when profile suffix is missing", async () => {
    const entry = await applyMainModelPatch({
      cfg: createAllowlistedAnthropicModelCfg(),
      model: ANTHROPIC_SONNET_MODEL,
      catalogRefs: [ANTHROPIC_SONNET_MODEL],
    });
    expectModelSelection(entry, "anthropic", ANTHROPIC_SONNET_ID);
    expectAuthOverride(entry, { profile: undefined });
  });

  test("persists full provider:profile authProfileOverride on model patch", async () => {
    const entry = await applyMainModelPatch({
      cfg: createAllowlistedAnthropicModelCfg(),
      model: `${ANTHROPIC_SONNET_MODEL}@openai:user@example.com`,
      catalogRefs: [ANTHROPIC_SONNET_MODEL],
    });
    expectModelSelection(entry, "anthropic", ANTHROPIC_SONNET_ID);
    expectAuthOverride(entry, { profile: "openai:user@example.com" });
  });

  test("resolves bare allowlisted model ids before persisting @profile suffix", async () => {
    const entry = expectPatchOk(
      await runPatch({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.4" },
              models: {
                "opencode-go/kimi-k2.6": {},
              },
            },
          },
        } as OpenClawConfig,
        patch: { key: MAIN_SESSION_KEY, model: "kimi-k2.6@work" },
        loadGatewayModelCatalog: async () => [
          { provider: "openai", id: "gpt-5.4", name: "gpt-5.4" },
          { provider: "opencode-go", id: "kimi-k2.6", name: "kimi-k2.6" },
        ],
      }),
    );
    expect(entry.providerOverride).toBe("opencode-go");
    expect(entry.modelOverride).toBe("kimi-k2.6");
    expect(entry.authProfileOverride).toBe("work");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
