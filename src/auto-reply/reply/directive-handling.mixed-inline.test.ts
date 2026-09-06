// Tests mixed directives through the real reply admission and transaction boundary.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import * as authProfileStore from "../../agents/auth-profiles/store.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import { loadProviderScopedThinkingCatalog } from "../../agents/model-catalog.runtime.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import { resolveThinkingDefault } from "../../agents/model-thinking-default.js";
import { persistStickyModelSelectionBestEffort } from "../../agents/sticky-model-selection.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { triggerSessionPatchHook } from "../../gateway/session-patch-hooks.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../../sessions/model-overrides.js";
import {
  onSessionLifecycleEvent,
  type SessionLifecycleEvent,
} from "../../sessions/session-lifecycle-events.js";
import {
  applyMixedDirectives,
  createSessionEntry,
} from "./directive-handling.mixed-inline.test-helpers.js";
import { resolveReplyDirectiveRouting } from "./get-reply-directives-routing.js";
import { resolveReplyExecOverrides } from "./get-reply-exec-overrides.js";
import { refreshQueuedFollowupSession } from "./queue.js";
import { buildTestCtx } from "./test-ctx.js";

type PersistenceResult =
  | { status: "current"; entry: SessionEntry }
  | { status: "model-selection-locked"; entry: SessionEntry }
  | { status: "lifecycle-invalidated"; error: string; entry?: SessionEntry };

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
}));

const persistenceMocks = vi.hoisted(() => ({
  persist: vi.fn<(params: { entry: SessionEntry }) => Promise<PersistenceResult>>(),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  listAgentEntries: vi.fn(() => []),
  resolveAgentConfig: vi.fn(() => ({})),
  resolveAgentModelFallbacksOverride: vi.fn(() => undefined),
  resolveAgentDir: vi.fn(() => "/tmp/agent"),
  resolveSessionAgentIds: vi.fn(() => ({ requestedAgentId: "main", sessionAgentId: "main" })),
  resolveSessionAgentId: vi.fn(() => "main"),
  resolveDefaultAgentId: vi.fn(() => "main"),
}));

vi.mock("../../agents/sandbox.js", () => ({
  resolveSandboxRuntimeStatus: vi.fn(() => ({ sandboxed: false })),
}));

vi.mock("../../agents/sticky-model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/sticky-model-selection.js")>()),
  persistStickyModelSelectionBestEffort: vi.fn(),
}));

vi.mock("../../gateway/session-patch-hooks.js", () => ({
  triggerSessionPatchHook: vi.fn(),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("./queue.js", () => ({
  refreshQueuedFollowupSession: vi.fn(),
}));

vi.mock("./session-entry-persistence.js", () => ({
  persistReplySessionEntry: (params: { entry: SessionEntry }) => persistenceMocks.persist(params),
}));

describe("mixed inline directives", () => {
  let lifecycleEvents: SessionLifecycleEvent[];
  let unsubscribeLifecycle: () => void;

  beforeEach(() => {
    lifecycleEvents = [];
    unsubscribeLifecycle = onSessionLifecycleEvent((event) => lifecycleEvents.push(event));
    vi.clearAllMocks();
    vi.mocked(loadProviderScopedThinkingCatalog).mockReset().mockResolvedValue([]);
    vi.mocked(persistStickyModelSelectionBestEffort).mockReturnValue("requested");
    persistenceMocks.persist.mockImplementation(async ({ entry }) => ({
      status: "current",
      entry: { ...entry },
    }));
  });

  it("continues mixed content with the selected route's context and thinking metadata", async () => {
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
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply /model fixture-route/reasoner -s",
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
      allowedModels: [
        { provider: "anthropic", id: "claude-opus-4-6", name: "Opus", reasoning: false },
      ],
      sessionEntry: createSessionEntry({ thinkingLevel: "max" }),
    });
    expect(result).toMatchObject({
      kind: "continue",
      provider: selected.provider,
      model: selected.id,
      contextTokens: 24_000,
    });
    expect(sessionEntry.thinkingLevel).toBe("max");
    expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({
        nextThinking: expect.objectContaining({
          level: "max",
          catalog: expect.arrayContaining([selected]),
        }),
      }),
    );
  });

  it.each(["", "please reply "])(
    "rejects a restricted explicit model with prefix %j without persistence",
    async (prefix) => {
      const sessionEntry = createSessionEntry({ thinkingLevel: "high" });
      const initial = { ...sessionEntry };
      const { result } = await applyMixedDirectives({
        body: `${prefix}/model openai/gpt-5.6-luna -s`,
        cfg: { agents: { defaults: { modelPolicy: { allow: ["anthropic/*"] } } } },
        sessionEntry,
        allowedModels: [{ provider: "anthropic", id: "claude-opus-4-6", name: "Opus" }],
      });
      expect(result).toMatchObject({
        kind: "reply",
        reply: { isError: true, text: expect.stringContaining("is not allowed") },
      });
      expect(sessionEntry).toEqual(initial);
      expect(persistenceMocks.persist).not.toHaveBeenCalled();
      expect(triggerSessionPatchHook).not.toHaveBeenCalled();
      expect(loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
    },
  );

  describe.each(["", "please reply "])("off-catalog selection with prefix %j", (prefix) => {
    it.each([undefined, {}, { allow: [] }])(
      "uses policy %j independently of inventory",
      async (modelPolicy) => {
        const { result, sessionEntry } = await applyMixedDirectives({
          body: `${prefix}/model openai/gpt-5.6-luna -s`,
          cfg: { agents: { defaults: { modelPolicy } } },
          allowedModels: [{ provider: "anthropic", id: "claude-opus-4-6", name: "Opus" }],
          sessionEntry: createSessionEntry({ thinkingLevel: "high" }),
        });
        expect(result).toMatchObject(
          prefix
            ? { kind: "continue", provider: "openai", model: "gpt-5.6-luna" }
            : {
                kind: "reply",
                reply: { text: expect.stringContaining("Model set to openai/gpt-5.6-luna") },
              },
        );
        expect(sessionEntry).toMatchObject({
          providerOverride: "openai",
          modelOverride: "gpt-5.6-luna",
          thinkingLevel: "high",
        });
        expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
      },
    );
  });

  afterEach(() => {
    unsubscribeLifecycle();
    vi.restoreAllMocks();
  });

  it("publishes a mixed profile-only selection only after persistence settles", async () => {
    const persistence = createDeferred<PersistenceResult>();
    const persistenceStarted = createDeferred<SessionEntry>();
    persistenceMocks.persist.mockImplementationOnce(({ entry }) => {
      persistenceStarted.resolve({ ...entry });
      return persistence.promise;
    });
    vi.spyOn(authProfileStore, "findPersistedAuthProfileCredential").mockReturnValue({
      type: "api_key",
      provider: "openai",
      key: "test-key",
    });
    const sessionEntry = createSessionEntry({
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "auto",
    });
    const pending = applyMixedDirectives({
      body: "please reply /model openai/gpt-5.6-luna@openai:work -s",
      provider: "openai",
      model: "gpt-5.6-luna",
      sessionEntry,
      storePath: "/tmp/sessions.json",
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "Luna" }],
    });

    const persisted = await Promise.race([
      persistenceStarted.promise,
      pending.then(({ result }) => {
        throw new Error(`Selection completed before persistence: ${JSON.stringify(result)}`);
      }),
    ]);
    expect(persistenceMocks.persist).toHaveBeenCalledOnce();
    expect(lifecycleEvents).toEqual([]);
    expect(persisted.authProfileOverrideSource).toBe("user");
    persistence.resolve({ status: "current", entry: persisted });
    const { result } = await pending;

    expect(result).toMatchObject({ kind: "continue", provider: "openai", model: "gpt-5.6-luna" });
    expect(lifecycleEvents).toEqual([
      { sessionKey: "agent:main:dm:1", agentId: "main", reason: "patch" },
    ]);
    expect(sessionEntry.authProfileOverrideSource).toBe("user");
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    await applyMixedDirectives({
      body: "please reply /model openai/gpt-5.6-luna@openai:work -s",
      provider: "openai",
      model: "gpt-5.6-luna",
      sessionEntry,
      storePath: "/tmp/sessions.json",
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "Luna" }],
    });
    expect(lifecycleEvents).toHaveLength(1);
  });

  describe.each(["", "please reply "])("model scope with prefix %j", (prefix) => {
    it.each([
      { scope: undefined, flag: "", owner: true, target: undefined, writes: false },
      { scope: "session", flag: "", owner: true, target: undefined, writes: false },
      { scope: "agent", flag: "", owner: true, target: "agent", writes: true },
      { scope: "global", flag: "", owner: true, target: "defaults", writes: true },
      { scope: "global", flag: " --session", owner: true, target: undefined, writes: false },
      { scope: "session", flag: " --agent", owner: true, target: "agent", writes: true },
      { scope: "agent", flag: " --global", owner: true, target: "defaults", writes: true },
      { scope: "agent", flag: "", owner: false, target: undefined, writes: false },
      { scope: "global", flag: "", owner: false, target: undefined, writes: false },
    ] as const)(
      "resolves scope=$scope flag=$flag owner=$owner without widening authority",
      async ({ scope, flag, owner, target, writes }) => {
        const { result, sessionEntry } = await applyMixedDirectives({
          body: `${prefix}/model openai/gpt-5.6-luna${flag}`,
          cfg: { agents: { defaults: { modelSelectionScope: scope } } },
          senderIsOwner: owner,
          allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
        });

        expect(sessionEntry).toMatchObject({
          providerOverride: "openai",
          modelOverride: "gpt-5.6-luna",
          modelOverrideSource: "user",
        });
        const acknowledgement = {
          text: expect.stringContaining(writes ? "update requested" : "default unchanged"),
        };
        expect(result).toMatchObject(
          prefix
            ? { kind: "continue", directiveAck: acknowledgement }
            : { kind: "reply", reply: acknowledgement },
        );
        if (writes) {
          expect(persistStickyModelSelectionBestEffort).toHaveBeenCalledExactlyOnceWith({
            agentId: "main",
            model: "openai/gpt-5.6-luna",
            ...(target ? { target } : {}),
          });
        } else {
          expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
        }
      },
    );
  });

  it("applies mixed reasoning without committing or emitting a session transition", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply\n/reasoning on",
      storePath: "/tmp/sessions.json",
    });

    expect(result).toMatchObject({
      kind: "continue",
      directives: { reasoningLevel: "on" },
      directiveAck: { text: "⚙️ Reasoning visibility enabled." },
    });
    expect(sessionEntry.reasoningLevel).toBeUndefined();
    expect(persistenceMocks.persist).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "off", initial: "on", expectedAck: "Reasoning visibility disabled." },
    { mode: "stream", initial: undefined, expectedAck: "Reasoning stream enabled." },
  ])(
    "applies reasoning $mode only to this turn with a channel-neutral acknowledgement",
    async ({ mode, initial, expectedAck }) => {
      const { result, sessionEntry } = await applyMixedDirectives({
        body: `please reply\n/reasoning ${mode}`,
        sessionEntry: createSessionEntry({ reasoningLevel: initial }),
        channel: "discord",
      });

      expect(result).toMatchObject({
        kind: "continue",
        directives: { reasoningLevel: mode },
        directiveAck: { text: `⚙️ ${expectedAck}` },
      });
      expect(sessionEntry.reasoningLevel).toBe(initial);
    },
  );

  it.each([
    { hint: "", stored: true },
    { hint: " /think high", stored: true },
    { hint: "", stored: false },
    { hint: " /think high", stored: false },
  ])(
    "commits a model switch with stored thinking=$stored and hint $hint",
    async ({ hint, stored }) => {
      const cfg = {
        commands: { text: true },
        agents: {
          defaults: {
            thinkingDefault: "ultra",
            models: { "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } } },
          },
        },
      } as OpenClawConfig;
      const { result, sessionEntry } = await applyMixedDirectives({
        body: `please reply /model openai/gpt-5.6-luna${hint}`,
        cfg,
        sessionEntry: createSessionEntry(stored ? { thinkingLevel: "ultra" } : {}),
        resolveDefaultThinkingLevel: async () =>
          resolveThinkingDefault({ cfg, provider: "openai", model: "gpt-5.6-sol" }),
        storePath: "/tmp/sessions.json",
        provider: "openai",
        model: "gpt-5.6-sol",
        allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
        senderIsOwner: true,
      });

      expect(result).toMatchObject({ kind: "continue", provider: "openai", model: "gpt-5.6-luna" });
      expect(sessionEntry.thinkingLevel).toBe(stored ? "max" : undefined);
      if (hint) {
        expect(result).toMatchObject({ kind: "continue", directives: { thinkLevel: "high" } });
      }
      if (result.kind !== "continue") {
        throw new Error("Expected the model switch to continue the task");
      }
      expect(result.directiveAck?.text).toContain("Model set to openai/gpt-5.6-luna");
      expect(
        result.directiveAck?.text?.includes("Thinking level set to max (ultra not supported"),
      ).toBe(stored);
      expect(persistenceMocks.persist).toHaveBeenCalledOnce();
      expect(persistenceMocks.persist.mock.calls[0]?.[0].entry.thinkingLevel).toBe(
        stored ? "max" : undefined,
      );
      expect(triggerSessionPatchHook).toHaveBeenCalledOnce();
      expect(refreshQueuedFollowupSession).toHaveBeenCalledOnce();
      expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).toHaveBeenCalledOnce();
      expect(enqueueSystemEvent).toHaveBeenCalledWith("Model switched to openai/gpt-5.6-luna.", {
        sessionKey: "agent:main:dm:1",
        contextKey: "model:openai/gpt-5.6-luna",
      });
      expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
        expect.objectContaining({
          key: "agent:main:dm:1",
          nextProvider: "openai",
          nextModel: "gpt-5.6-luna",
          nextThinking: expect.objectContaining({
            level: stored ? "max" : undefined,
            agentRuntime: "codex",
          }),
        }),
      );
    },
  );

  it.each([
    { label: "bare", body: "please reply /model" },
    { label: "list", body: "please reply /model list" },
    { label: "status", body: "please reply /model status" },
  ])("does not acknowledge or mutate a mixed $label model info directive", async ({ body }) => {
    const cfg = { commands: { text: true }, agents: { defaults: {} } } as OpenClawConfig;
    const directives = resolveReplyDirectiveRouting({
      commandText: body,
      agentText: body,
      modelAliases: [],
      canInterpretTextDirectives: true,
      isAuthorizedSender: true,
      isGroup: false,
      wasMentioned: false,
      ctx: buildTestCtx({ Body: body, CommandAuthorized: true }),
      cfg,
      agentId: "main",
      resetTriggered: false,
    }).directives;
    const { result, sessionEntry } = await applyMixedDirectives({
      body,
      cfg,
      directives,
    });

    expect(result).toMatchObject({
      kind: "continue",
      directives: { cleaned: "please reply", hasModelDirective: false },
    });
    expect(result).not.toHaveProperty("directiveAck");
    expect(sessionEntry).toEqual(createSessionEntry());
    expect(persistenceMocks.persist).not.toHaveBeenCalled();
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it.each([
    { name: "directive-only", body: "/model openai/gpt-5.6-luna -s" },
    { name: "mixed-content", body: "please reply /model openai/gpt-5.6-luna -s" },
  ])("keeps an owner $name selection session-only", async ({ body }) => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body,
      senderIsOwner: true,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(result).toMatchObject(
      body.startsWith("/model")
        ? {
            kind: "reply",
            reply: {
              text: "Model set to openai/gpt-5.6-luna for this session only; configured default unchanged.",
            },
          }
        : {
            kind: "continue",
            provider: "openai",
            model: "gpt-5.6-luna",
            directiveAck: {
              text: "Model set to openai/gpt-5.6-luna for this session only; configured default unchanged.",
            },
          },
    );
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
    });
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it.each([
    { name: "legacy user", marker: undefined, expectedSource: "user" as const },
    { name: "marker-backed auto", marker: 0, expectedSource: "auto" as const },
  ])(
    "forwards a source-less $name auth profile canonically after /model",
    async ({ marker, expectedSource }) => {
      const sessionEntry = createSessionEntry({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        authProfileOverride: "openai:work",
        ...(marker === undefined ? {} : { authProfileOverrideCompactionCount: marker }),
      });

      await applyMixedDirectives({
        body: "/model openai/gpt-5.6-luna -s",
        senderIsOwner: true,
        provider: "openai",
        model: "gpt-5.6-sol",
        sessionEntry,
        allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      });

      expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
      expect(sessionEntry.authProfileOverrideCompactionCount).toBe(marker);
      expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
        expect.objectContaining({
          nextAuthProfileId: "openai:work",
          nextAuthProfileIdSource: expectedSource,
        }),
      );
    },
  );

  it("applies an owner alias session scope without continuing to the model", async () => {
    const aliasIndex: ModelAliasIndex = {
      byAlias: new Map([
        [
          "luna",
          {
            alias: "luna",
            ref: { provider: "openai", model: "gpt-5.6-luna" },
          },
        ],
      ]),
      byKey: new Map([["openai/gpt-5.6-luna", ["luna"]]]),
    };
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "/luna -s",
      modelAliases: ["luna"],
      aliasIndex,
      senderIsOwner: true,
      storePath: "/tmp/sessions.json",
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(result).toEqual({
      kind: "reply",
      reply: {
        text: "Model set to luna (openai/gpt-5.6-luna) for this session only; configured default unchanged.",
      },
    });
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
    });
    expect(persistenceMocks.persist).toHaveBeenCalledOnce();
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it("preserves a mixed alias named list as a model selection", async () => {
    const body = "please reply /list -s";
    const cfg = { commands: { text: true }, agents: { defaults: {} } } as OpenClawConfig;
    const aliasIndex: ModelAliasIndex = {
      byAlias: new Map([
        [
          "list",
          {
            alias: "list",
            ref: { provider: "openai", model: "gpt-5.6-luna" },
          },
        ],
      ]),
      byKey: new Map([["openai/gpt-5.6-luna", ["list"]]]),
    };
    const directives = resolveReplyDirectiveRouting({
      commandText: body,
      agentText: body,
      modelAliases: ["list"],
      canInterpretTextDirectives: true,
      isAuthorizedSender: true,
      isGroup: false,
      wasMentioned: false,
      ctx: buildTestCtx({ Body: body, CommandAuthorized: true }),
      cfg,
      agentId: "main",
      resetTriggered: false,
    }).directives;
    const { result, sessionEntry } = await applyMixedDirectives({
      body,
      cfg,
      directives,
      modelAliases: ["list"],
      aliasIndex,
      senderIsOwner: true,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(directives).toMatchObject({
      cleaned: "please reply",
      hasModelDirective: true,
      modelDirectiveSource: "alias",
      rawModelDirective: "list",
    });
    expect(result).toMatchObject({
      kind: "continue",
      provider: "openai",
      model: "gpt-5.6-luna",
    });
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
    });
  });

  it.each(["--runtime codex -s", "-s --runtime codex"])(
    "applies mixed-content /model runtime and session options from %s",
    async (options) => {
      const { result, sessionEntry } = await applyMixedDirectives({
        body: `please reply /model openai/gpt-5.6-luna ${options}`,
        senderIsOwner: true,
        allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      });

      expect(result).toMatchObject({
        kind: "continue",
        provider: "openai",
        model: "gpt-5.6-luna",
        directiveAck: {
          text: expect.stringContaining(
            "Model set to openai/gpt-5.6-luna for this session only; configured default unchanged.",
          ),
        },
      });
      expect(sessionEntry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-luna",
        agentRuntimeOverride: "codex",
      });
      expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
    },
  );

  it.each([
    { name: "directive-only", body: "/model openai/gpt-5.6-luna -a" },
    { name: "mixed-content", body: "please reply /model openai/gpt-5.6-luna -a" },
  ])("reports immutable config for an owner $name agent-default selection", async ({ body }) => {
    vi.mocked(persistStickyModelSelectionBestEffort).mockReturnValueOnce("skipped-immutable");

    const { result } = await applyMixedDirectives({
      body,
      senderIsOwner: true,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    const expectedText =
      "Model set to openai/gpt-5.6-luna for this session. Agent default unchanged because configuration is immutable.";
    expect(result).toMatchObject(
      body.startsWith("/model")
        ? { kind: "reply", reply: { text: expectedText } }
        : { kind: "continue", directiveAck: { text: expectedText } },
    );
  });

  it("keeps a partial scope option as text without overriding the configured scope", async () => {
    const { result } = await applyMixedDirectives({
      body: "please reply /model openai/gpt-5.6-luna -slow",
      cfg: { agents: { defaults: { modelSelectionScope: "session" } } },
      senderIsOwner: true,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(result).toMatchObject({
      kind: "continue",
      provider: "openai",
      model: "gpt-5.6-luna",
      directiveAck: {
        text: "Model set to openai/gpt-5.6-luna for this session only; configured default unchanged.",
      },
    });
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it("clears an incompatible auth pin with a cross-provider /model default -s", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    });
    const { result } = await applyMixedDirectives({
      body: "/model default -s",
      senderIsOwner: true,
      sessionEntry,
      allowedModels: [{ provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus" }],
    });

    expect(result).toMatchObject({
      kind: "reply",
      reply: {
        text: "Session model reset to configured default (anthropic/claude-opus-4-6).",
      },
    });
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionEntry.modelOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
    expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({ nextModelOverrideSource: undefined }),
    );
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it("preserves a compatible auth pin with a same-provider /model default -s", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-sol",
      modelOverrideSource: "user",
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    });
    const { result } = await applyMixedDirectives({
      body: "/model default -s",
      senderIsOwner: true,
      provider: "openai",
      model: "gpt-5.6-sol",
      defaultProvider: "openai",
      defaultModel: "gpt-5.6-luna",
      sessionEntry,
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(result).toMatchObject({
      kind: "reply",
      reply: {
        text: "Session model reset to configured default (openai/gpt-5.6-luna).",
      },
    });
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionEntry.modelOverrideSource).toBeUndefined();
    expect(sessionEntry).toMatchObject({
      authProfileOverride: "openai:work",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    });
    expect(refreshQueuedFollowupSession).toHaveBeenCalledWith(
      expect.objectContaining({ nextModelOverrideSource: undefined }),
    );
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it("keeps an operator.admin selection session-only", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "/model openai/gpt-5.6-luna --session",
      gatewayClientScopes: ["operator.admin"],
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
    });

    expect(result).toMatchObject({
      kind: "reply",
      reply: {
        text: "Model set to openai/gpt-5.6-luna for this session only; configured default unchanged.",
      },
    });
    expect(sessionEntry).toMatchObject({
      providerOverride: "openai",
      modelOverride: "gpt-5.6-luna",
      modelOverrideSource: "user",
    });
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
  });

  it("routes a mixed default reset to the actual default after clearing override fields", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply /model default",
      provider: "openai",
      model: "gpt-5.6-sol",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      sessionEntry: createSessionEntry({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        modelOverrideSource: "user",
      }),
      allowedModels: [
        {
          provider: "anthropic",
          id: "claude-opus-4-6",
          name: "Claude Opus",
          contextTokens: 90_000,
        },
      ],
    });

    expect(result).toMatchObject({
      kind: "continue",
      provider: "anthropic",
      model: "claude-opus-4-6",
      contextTokens: 1_000_000,
      directiveAck: {
        text: "Session model reset to configured default (anthropic/claude-opus-4-6).",
      },
    });
    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
  });

  it("keeps mixed queue options on the current message", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply\n/queue collect debounce:1500 cap:4 drop:old",
      storePath: "/tmp/sessions.json",
    });

    expect(result).toMatchObject({
      kind: "continue",
      perMessageQueueMode: "collect",
      perMessageQueueOptions: { debounceMs: 1500, cap: 4, dropPolicy: "old" },
    });
    expect(sessionEntry).toEqual(createSessionEntry());
    expect(persistenceMocks.persist).not.toHaveBeenCalled();
  });

  it("keeps routed exec policy on its message without changing session placement", async () => {
    const cfg = { commands: { text: true }, agents: { defaults: {} } } as OpenClawConfig;
    const sessionEntry = createSessionEntry({ execHost: "node", execNode: "worker-1" });
    const initialEntry = { ...sessionEntry };
    for (const [body, security, ask] of [
      ["please reply /exec host=gateway node=other security=deny ask=always", "deny", "always"],
      ["please reply again", undefined, undefined],
    ] as const) {
      const { directives } = resolveReplyDirectiveRouting({
        commandText: body,
        agentText: body,
        modelAliases: [],
        canInterpretTextDirectives: true,
        isAuthorizedSender: true,
        isGroup: false,
        wasMentioned: false,
        ctx: buildTestCtx({ Body: body, CommandAuthorized: true }),
        cfg,
        agentId: "main",
        resetTriggered: false,
      });
      const { result } = await applyMixedDirectives({ body, cfg, directives, sessionEntry });
      if (result.kind !== "continue") {
        throw new Error("Expected the message to continue to the agent");
      }
      expect(resolveReplyExecOverrides({ directives: result.directives, sessionEntry })).toEqual({
        host: "node",
        node: "worker-1",
        security,
        ask,
      });
      if (security) {
        expect(result.directiveAck?.text).toContain(
          "Exec policy for this run only (security=deny, ask=always).",
        );
      } else {
        expect(result.directiveAck).toBeUndefined();
      }
      expect(sessionEntry).toEqual(initialEntry);
    }
    expect(persistenceMocks.persist).not.toHaveBeenCalled();
  });

  it("does not persist fast-mode or exec placement from mixed transactions", async () => {
    const fast = await applyMixedDirectives({ body: "please reply\n/fast on" });
    expect(fast.result).toMatchObject({ kind: "continue", directives: { fastMode: true } });
    expect(fast.sessionEntry.fastMode).toBeUndefined();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();

    const exec = await applyMixedDirectives({
      body: "please reply\n/exec host=node security=allowlist ask=always node=worker-1",
      gatewayClientScopes: [],
    });
    expect(exec.result).toMatchObject({
      kind: "continue",
      directiveAck: { text: expect.stringContaining("Exec defaults set") },
    });
    expect(exec.sessionEntry).toEqual(createSessionEntry());
    expect(persistenceMocks.persist).not.toHaveBeenCalled();
  });

  it("does not persist trace directives for unauthorized mixed messages", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply\n/trace raw",
      sessionEntry: createSessionEntry({ traceLevel: "off" }),
      gatewayClientScopes: [],
    });

    expect(result).toMatchObject({ kind: "continue" });
    expect(sessionEntry.traceLevel).toBe("off");
    expect(persistenceMocks.persist).not.toHaveBeenCalled();
  });

  it.each([
    {
      ignored: "/trace raw",
      expectedAck: "/trace is restricted to owners",
    },
    {
      ignored: "/verbose nonsense",
      expectedAck: "Current verbose level:",
    },
    {
      ignored: "/fast status",
      expectedAck: "Current fast mode:",
    },
  ])(
    "applies valid sibling settings despite an ignored $ignored directive",
    async ({ ignored, expectedAck }) => {
      const { result, sessionEntry } = await applyMixedDirectives({
        body: `please reply\n${ignored}\n/reasoning on`,
        storePath: "/tmp/sessions.json",
        gatewayClientScopes: [],
      });

      expect(result).toMatchObject({
        kind: "continue",
        directives: { reasoningLevel: "on" },
        directiveAck: { text: expect.stringContaining(expectedAck) },
      });
      expect(sessionEntry.reasoningLevel).toBeUndefined();
      expect(sessionEntry.traceLevel).toBeUndefined();
      expect(persistenceMocks.persist).not.toHaveBeenCalled();
    },
  );

  it.each(["", "/verbose", "/fast status", "/trace raw"])(
    "validates unsupported thinking despite an informational sibling %j",
    async (sibling) => {
      const { result, sessionEntry } = await applyMixedDirectives({
        body: `please reply ${sibling} /think high`,
        provider: "fixture-route",
        model: "reasoner",
        allowedModels: [
          {
            provider: "fixture-route",
            id: "reasoner",
            name: "Reasoner",
            reasoning: false,
          },
        ],
        gatewayClientScopes: [],
      });
      expect(result).toMatchObject({
        kind: "reply",
        reply: {
          isError: true,
          text: expect.stringContaining('Thinking level "high" is not supported'),
        },
      });
      expect(sessionEntry).toEqual(createSessionEntry());
      expect(persistenceMocks.persist).not.toHaveBeenCalled();
      expect(enqueueSystemEvent).not.toHaveBeenCalled();
    },
  );

  it("keeps valid turn hints when a sibling exec option is invalid", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply\n/exec host=node security=bogus\n/reasoning on",
      storePath: "/tmp/sessions.json",
    });

    expect(result).toMatchObject({
      kind: "continue",
      directives: { reasoningLevel: "on" },
      directiveAck: { text: expect.stringContaining('Unrecognized exec security "bogus"') },
    });
    expect(sessionEntry).toEqual(createSessionEntry());
    expect(persistenceMocks.persist).not.toHaveBeenCalled();
  });

  it("keeps informational and unauthorized siblings from persisting turn hints", async () => {
    const { result, sessionEntry } = await applyMixedDirectives({
      body: "please reply\n/trace raw\n/verbose nonsense\n/reasoning on",
      storePath: "/tmp/sessions.json",
      gatewayClientScopes: [],
    });

    expect(result).toMatchObject({
      kind: "continue",
      directives: { reasoningLevel: "on" },
      directiveAck: { text: expect.stringContaining("/trace is restricted to owners") },
    });
    expect(sessionEntry.reasoningLevel).toBeUndefined();
    expect(sessionEntry.traceLevel).toBeUndefined();
    expect(persistenceMocks.persist).not.toHaveBeenCalled();
  });

  it("does not announce unchanged elevated mode as a transition", async () => {
    const { result } = await applyMixedDirectives({
      body: "please reply\n/elevated full",
      sessionEntry: createSessionEntry({ elevatedLevel: "full" }),
      storePath: "/tmp/sessions.json",
    });

    expect(result).toMatchObject({ kind: "continue" });
    expect(persistenceMocks.persist).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("adopts an authoritative model lock and emits no losing side effects", async () => {
    const sessionEntry = createSessionEntry({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-6",
      modelOverrideSource: "user",
    });
    const lockedEntry = { ...sessionEntry, updatedAt: 2, modelSelectionLocked: true };
    persistenceMocks.persist.mockResolvedValueOnce({
      status: "model-selection-locked",
      entry: lockedEntry,
    });

    const { result, sessionStore } = await applyMixedDirectives({
      body: "please reply /model openai/gpt-5.6-luna",
      sessionEntry,
      storePath: "/tmp/sessions.json",
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      senderIsOwner: true,
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: MODEL_SELECTION_LOCKED_MESSAGE, isError: true },
    });
    expect(persistenceMocks.persist).toHaveBeenCalledWith(
      expect.objectContaining({ requireModelSelectionUnlocked: true }),
    );
    expect(sessionEntry).toEqual(lockedEntry);
    expect(sessionStore["agent:main:dm:1"]).toEqual(lockedEntry);
    expect(lifecycleEvents).toEqual([]);
    expect(triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(persistStickyModelSelectionBestEffort).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("reports a locked valid model instead of an ignored unauthorized sibling", async () => {
    const sessionEntry = createSessionEntry();
    const lockedEntry = { ...sessionEntry, updatedAt: 2, modelSelectionLocked: true };
    persistenceMocks.persist.mockResolvedValueOnce({
      status: "model-selection-locked",
      entry: lockedEntry,
    });

    const { result } = await applyMixedDirectives({
      body: "please reply\n/trace raw\n/model openai/gpt-5.6-luna",
      sessionEntry,
      storePath: "/tmp/sessions.json",
      allowedModels: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" }],
      gatewayClientScopes: [],
    });

    expect(result).toEqual({
      kind: "reply",
      reply: { text: MODEL_SELECTION_LOCKED_MESSAGE, isError: true },
    });
    expect(sessionEntry).toEqual(lockedEntry);
    expect(persistenceMocks.persist).toHaveBeenCalledOnce();
    expect(triggerSessionPatchHook).not.toHaveBeenCalled();
    expect(refreshQueuedFollowupSession).not.toHaveBeenCalled();
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
  });
});
