// Codex tests cover index plugin behavior.
import fs from "node:fs";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import plugin from "./index.js";
import {
  createCodexAppServerBindingStore,
  sessionBindingIdentity,
} from "./src/app-server/session-binding.js";
import {
  createCodexTestBindingStateStore,
  testCodexAppServerBindingStore,
} from "./src/app-server/session-binding.test-helpers.js";
import { CODEX_SUPERVISION_COMPAT_TOOL_NAMES } from "./src/supervision-tools.js";

const runCodexAppServerAttemptMock = vi.hoisted(() => vi.fn());
const runCodexAppServerSideQuestionMock = vi.hoisted(() => vi.fn());

function createCodexTestRuntime(
  current?: () => unknown,
  stateStore = createCodexTestBindingStateStore(),
) {
  return {
    ...(current ? { config: { current } } : {}),
    state: {
      openSyncKeyedStore: () => stateStore,
    },
  } as never;
}

vi.mock("./src/app-server/run-attempt.js", () => ({
  runCodexAppServerAttempt: runCodexAppServerAttemptMock,
}));
vi.mock("./src/app-server/side-question.js", () => ({
  runCodexAppServerSideQuestion: runCodexAppServerSideQuestionMock,
}));

function mockCall(mock: { mock: { calls: unknown[][] } }, index = 0) {
  return mock.mock.calls.at(index);
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, index = 0, argIndex = 0) {
  return mockCall(mock, index)?.at(argIndex);
}

describe("codex plugin", () => {
  it("is opt-in by default", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { enabledByDefault?: unknown };

    expect(manifest.enabledByDefault).toBeUndefined();
  });

  it("registers the codex provider, agent harness, native thread tool, and hosted web search", () => {
    const registerAgentHarness = vi.fn();
    const registerCommand = vi.fn();
    const registerMediaUnderstandingProvider = vi.fn();
    const registerMigrationProvider = vi.fn();
    const registerProvider = vi.fn();
    const registerTool = vi.fn();
    const registerToolMetadata = vi.fn();
    const registerWebSearchProvider = vi.fn();
    const on = vi.fn();
    const onConversationBindingResolved = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: createCodexTestRuntime(),
        registerAgentHarness,
        registerCommand,
        registerMediaUnderstandingProvider,
        registerMigrationProvider,
        registerProvider,
        registerTool,
        registerToolMetadata,
        registerWebSearchProvider,
        on,
        onConversationBindingResolved,
      }),
    );

    const providerRegistration = mockCallArg(registerProvider) as Record<string, unknown>;
    const agentHarnessRegistration = mockCallArg(registerAgentHarness) as Record<string, unknown>;
    const mediaProviderRegistration = mockCallArg(registerMediaUnderstandingProvider) as
      | Record<string, unknown>
      | undefined;
    const inboundClaimRegistration = mockCall(on) as [unknown, unknown] | undefined;
    const bindingResolvedRegistration = mockCall(onConversationBindingResolved) as
      | [unknown]
      | undefined;

    expect(providerRegistration.id).toBe("codex");
    expect(providerRegistration.label).toBe("Codex");
    expect(agentHarnessRegistration.id).toBe("codex");
    expect(agentHarnessRegistration.label).toBe("Codex agent harness");
    expect(agentHarnessRegistration.deliveryDefaults).toEqual({
      sourceVisibleReplies: "message_tool",
    });
    expect(typeof agentHarnessRegistration.dispose).toBe("function");
    expect(mediaProviderRegistration?.id).toBe("codex");
    expect(mediaProviderRegistration?.capabilities).toEqual(["image"]);
    expect(mediaProviderRegistration?.defaultModels).toEqual({ image: "gpt-5.6-sol" });
    expect(typeof mediaProviderRegistration?.describeImage).toBe("function");
    expect(typeof mediaProviderRegistration?.describeImages).toBe("function");
    const webSearchRegistration = mockCallArg(registerWebSearchProvider) as
      | Record<string, unknown>
      | undefined;
    expect(webSearchRegistration?.id).toBe("codex");
    expect(webSearchRegistration?.label).toBe("Codex Hosted Search");
    expect(webSearchRegistration?.requiresCredential).toBe(false);
    expect(typeof webSearchRegistration?.createTool).toBe("function");
    const commandRegistration = mockCallArg(registerCommand) as Record<string, unknown> | undefined;
    expect(commandRegistration?.name).toBe("codex");
    expect(commandRegistration?.description).toBe(
      "Inspect and control the Codex app-server harness",
    );
    const migrationRegistration = mockCallArg(registerMigrationProvider) as
      | Record<string, unknown>
      | undefined;
    expect(migrationRegistration?.id).toBe("codex");
    expect(migrationRegistration?.label).toBe("Codex");
    expect(registerTool).toHaveBeenCalledWith(expect.any(Function), { name: "codex_threads" });
    expect(registerTool).not.toHaveBeenCalledWith(expect.any(Function), {
      names: [...CODEX_SUPERVISION_COMPAT_TOOL_NAMES],
    });
    expect(registerToolMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "codex_threads", risk: "high" }),
    );
    expect(inboundClaimRegistration?.[0]).toBe("inbound_claim");
    expect(typeof inboundClaimRegistration?.[1]).toBe("function");
    expect(typeof bindingResolvedRegistration?.[0]).toBe("function");
  });

  it("registers the five shipped supervision tools only when supervision is enabled", () => {
    const registerTool = vi.fn();
    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: { supervision: { enabled: true } },
        runtime: createCodexTestRuntime(),
        registerAgentHarness: vi.fn(),
        registerCommand: vi.fn(),
        registerMediaUnderstandingProvider: vi.fn(),
        registerMigrationProvider: vi.fn(),
        registerProvider: vi.fn(),
        registerTool,
        on: vi.fn(),
      }),
    );

    const registration = registerTool.mock.calls.find(([, options]) =>
      Array.isArray(options?.names),
    ) as
      | [(context: { senderIsOwner?: boolean }) => Array<{ name: string }>, { names: string[] }]
      | undefined;
    expect(registration?.[1]).toEqual({ names: [...CODEX_SUPERVISION_COMPAT_TOOL_NAMES] });
    expect(registration?.[0]({ senderIsOwner: true }).map((tool) => tool.name)).toEqual([
      ...CODEX_SUPERVISION_COMPAT_TOOL_NAMES,
    ]);
    expect(registration?.[0]({ senderIsOwner: false })).toEqual([]);
    expect(registration?.[0]({})).toEqual([]);
  });

  it("activates from live supervision config through a normalized Codex entry id", () => {
    const registerTool = vi.fn();
    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: createCodexTestRuntime(() => ({
          plugins: {
            entries: {
              " CODEX ": {
                config: { supervision: { enabled: true } },
              },
            },
          },
        })),
        registerAgentHarness: vi.fn(),
        registerCommand: vi.fn(),
        registerMediaUnderstandingProvider: vi.fn(),
        registerMigrationProvider: vi.fn(),
        registerProvider: vi.fn(),
        registerTool,
        on: vi.fn(),
      }),
    );

    expect(registerTool.mock.calls.some(([, options]) => Array.isArray(options?.names))).toBe(true);
  });

  it.each([
    ["plugin entry is removed", { plugins: { entries: {} } }],
    [
      "plugin entry is disabled",
      {
        plugins: {
          entries: {
            codex: { enabled: false, config: { supervision: { enabled: true } } },
          },
        },
      },
    ],
    [
      "global plugin loading is disabled",
      {
        plugins: {
          enabled: false,
          entries: {
            codex: { enabled: true, config: { supervision: { enabled: true } } },
          },
        },
      },
    ],
    [
      "a restrictive allowlist omits Codex",
      {
        plugins: {
          allow: ["other-plugin"],
          entries: {
            codex: { enabled: true, config: { supervision: { enabled: true } } },
          },
        },
      },
    ],
    [
      "the denylist blocks Codex",
      {
        plugins: {
          deny: ["codex"],
          entries: {
            codex: { enabled: true, config: { supervision: { enabled: true } } },
          },
        },
      },
    ],
    [
      "supervision is explicitly disabled",
      {
        plugins: {
          entries: {
            codex: { enabled: true, config: { supervision: { enabled: false } } },
          },
        },
      },
    ],
  ] as const)("revokes supervision live when %s", async (_label, revokedConfig) => {
    const registerTool = vi.fn();
    let liveConfig: unknown = {
      plugins: {
        entries: {
          codex: { enabled: true, config: { supervision: { enabled: true } } },
        },
      },
    };
    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: { supervision: { enabled: true } },
        runtime: createCodexTestRuntime(() => liveConfig),
        registerAgentHarness: vi.fn(),
        registerCommand: vi.fn(),
        registerMediaUnderstandingProvider: vi.fn(),
        registerMigrationProvider: vi.fn(),
        registerProvider: vi.fn(),
        registerTool,
        on: vi.fn(),
      }),
    );
    const registration = registerTool.mock.calls.find(([, options]) =>
      Array.isArray(options?.names),
    ) as
      | [
          (context: { senderIsOwner?: boolean }) => Array<{
            name: string;
            execute(callId: string, params: object): Promise<unknown>;
          }>,
          { names: string[] },
        ]
      | undefined;
    const probe = registration?.[0]({ senderIsOwner: true }).find(
      (tool) => tool.name === "codex_endpoint_probe",
    );
    if (!probe) {
      throw new Error("missing Codex endpoint probe tool");
    }

    liveConfig = revokedConfig;

    await expect(probe.execute("probe", {})).rejects.toThrow(
      "Codex supervision is disabled in the codex plugin config.",
    );
  });

  it("registers with capture APIs that do not expose conversation binding hooks yet", () => {
    const registerProvider = vi.fn();
    const api = createTestPluginApi({
      id: "codex",
      name: "Codex",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: createCodexTestRuntime(),
      registerAgentHarness: vi.fn(),
      registerCommand: vi.fn(),
      registerMediaUnderstandingProvider: vi.fn(),
      registerProvider,
      on: vi.fn(),
    });
    delete (api as { onConversationBindingResolved?: unknown }).onConversationBindingResolved;

    plugin.register(api);
    expect(registerProvider).toHaveBeenCalledTimes(1);
    expect((mockCallArg(registerProvider) as { id?: string } | undefined)?.id).toBe("codex");
  });

  it("claims the Codex routing providers by default", () => {
    const harness = createCodexAppServerAgentHarness({
      bindingStore: testCodexAppServerBindingStore,
    });

    expect(harness.deliveryDefaults?.sourceVisibleReplies).toBe("message_tool");
    expect(
      harness.supports({ provider: "codex", modelId: "gpt-5.4", requestedRuntime: "auto" })
        .supported,
    ).toBe(true);
    const openAiCodex = harness.supports({
      provider: "openai",
      modelId: "gpt-5.4",
      requestedRuntime: "auto",
    });
    expect(openAiCodex.supported).toBe(true);
    const unsupported = harness.supports({
      provider: "9router",
      modelId: "gpt-5.4",
      requestedRuntime: "auto",
    });
    expect(unsupported.supported).toBe(false);
  });

  it("retires only ended session binding rows in the owning agent scope", async () => {
    const stateStore = createCodexTestBindingStateStore();
    const bindingStore = createCodexAppServerBindingStore(stateStore);
    const on = vi.fn();
    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: createCodexTestRuntime(undefined, stateStore),
        registerAgentHarness: vi.fn(),
        registerCommand: vi.fn(),
        registerMediaUnderstandingProvider: vi.fn(),
        registerMigrationProvider: vi.fn(),
        registerProvider: vi.fn(),
        on,
      }),
    );
    const sessionEnd = on.mock.calls.find(([name]) => name === "session_end")?.[1] as
      | ((
          event: { sessionId: string; sessionKey?: string; reason?: string },
          ctx: { agentId?: string; sessionId: string; sessionKey?: string },
        ) => Promise<void>)
      | undefined;
    if (!sessionEnd) {
      throw new Error("missing Codex session_end hook");
    }
    const identity = sessionBindingIdentity({
      agentId: "worker",
      sessionId: "session-1",
      sessionKey: "agent:worker:session-1",
    });
    const setBinding = () =>
      bindingStore.mutate(identity, {
        kind: "set",
        binding: { threadId: "thread-1", cwd: "/repo" },
      });

    for (const reason of ["shutdown", "restart", "compaction", "unknown"] as const) {
      await setBinding();
      await sessionEnd(
        { sessionId: "session-1", sessionKey: "agent:worker:session-1", reason },
        { agentId: "worker", sessionId: "session-1" },
      );
      await expect(bindingStore.read(identity)).resolves.toMatchObject({ threadId: "thread-1" });
    }
    for (const reason of ["new", "reset", "idle", "daily", "deleted"] as const) {
      await setBinding();
      await sessionEnd(
        { sessionId: "session-1", sessionKey: "agent:worker:session-1", reason },
        { agentId: "worker", sessionId: "session-1" },
      );
      await expect(bindingStore.read(identity)).resolves.toBeUndefined();
    }
  });

  it("adopts compaction successors before delayed lifecycle cleanup", async () => {
    const stateStore = createCodexTestBindingStateStore();
    const bindingStore = createCodexAppServerBindingStore(stateStore);
    const on = vi.fn();
    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: createCodexTestRuntime(undefined, stateStore),
        registerAgentHarness: vi.fn(),
        registerCommand: vi.fn(),
        registerMediaUnderstandingProvider: vi.fn(),
        registerMigrationProvider: vi.fn(),
        registerProvider: vi.fn(),
        on,
      }),
    );
    const afterCompaction = on.mock.calls.find(([name]) => name === "after_compaction")?.[1] as
      | ((
          event: { previousSessionId?: string },
          ctx: { agentId?: string; sessionId?: string; sessionKey?: string },
        ) => Promise<void>)
      | undefined;
    const sessionEnd = on.mock.calls.find(([name]) => name === "session_end")?.[1] as
      | ((
          event: { sessionId: string; sessionKey?: string; reason?: string },
          ctx: { agentId?: string; sessionId: string; sessionKey?: string },
        ) => Promise<void>)
      | undefined;
    if (!afterCompaction || !sessionEnd) {
      throw new Error("missing Codex compaction lifecycle hooks");
    }
    const sessionKey = "agent:worker:telegram:chat-1";
    const previous = sessionBindingIdentity({
      agentId: "worker",
      sessionId: "session-1",
      sessionKey,
    });
    const successor = sessionBindingIdentity({
      agentId: "worker",
      sessionId: "session-2",
      sessionKey,
    });
    const newest = sessionBindingIdentity({
      agentId: "worker",
      sessionId: "session-3",
      sessionKey,
    });
    await bindingStore.mutate(previous, {
      kind: "set",
      binding: { threadId: "thread-1", cwd: "/repo" },
    });

    await afterCompaction(
      { previousSessionId: "session-1" },
      { agentId: "worker", sessionId: "session-2", sessionKey },
    );
    await expect(bindingStore.read(previous)).resolves.toBeUndefined();
    await expect(bindingStore.read(successor)).resolves.toMatchObject({ threadId: "thread-1" });

    await afterCompaction(
      { previousSessionId: "session-2" },
      { agentId: "worker", sessionId: "session-3", sessionKey },
    );
    await afterCompaction(
      { previousSessionId: "session-1" },
      { agentId: "worker", sessionId: "session-2", sessionKey },
    );
    await expect(bindingStore.read(successor)).resolves.toBeUndefined();
    await expect(bindingStore.read(newest)).resolves.toMatchObject({ threadId: "thread-1" });

    await sessionEnd(
      { sessionId: "session-1", sessionKey, reason: "reset" },
      { agentId: "worker", sessionId: "session-1", sessionKey },
    );
    await sessionEnd(
      { sessionId: "session-2", sessionKey, reason: "compaction" },
      { agentId: "worker", sessionId: "session-2", sessionKey },
    );
    await expect(bindingStore.read(newest)).resolves.toMatchObject({ threadId: "thread-1" });
    expect(stateStore.entries()).toHaveLength(1);
  });

  it("ignores compaction for a session without a Codex binding", async () => {
    const warn = vi.fn();
    const on = vi.fn();
    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
        runtime: createCodexTestRuntime(),
        registerAgentHarness: vi.fn(),
        registerCommand: vi.fn(),
        registerMediaUnderstandingProvider: vi.fn(),
        registerMigrationProvider: vi.fn(),
        registerProvider: vi.fn(),
        on,
      }),
    );
    const afterCompaction = on.mock.calls.find(([name]) => name === "after_compaction")?.[1] as
      | ((event: object, ctx: { sessionId?: string; sessionKey?: string }) => Promise<void>)
      | undefined;
    if (!afterCompaction) {
      throw new Error("missing Codex after_compaction hook");
    }

    await afterCompaction(
      { previousSessionId: "session-1" },
      { sessionId: "session-2", sessionKey: "agent:main:main" },
    );

    expect(warn).not.toHaveBeenCalled();
  });

  it("enables the native hook relay for public Codex app-server attempts", async () => {
    const harness = createCodexAppServerAgentHarness({
      pluginConfig: { appServer: {} },
      bindingStore: testCodexAppServerBindingStore,
    });
    const result = { success: true };
    runCodexAppServerAttemptMock.mockResolvedValueOnce(result);

    await expect(harness.runAttempt({ prompt: "hello" } as never)).resolves.toBe(result);

    expect(runCodexAppServerAttemptMock).toHaveBeenCalledWith(
      { prompt: "hello" },
      {
        bindingStore: testCodexAppServerBindingStore,
        pluginConfig: { appServer: {} },
        nativeHookRelay: { enabled: true },
      },
    );
  });

  it("owns auth bootstrap for forwarded profiles and native Codex sign-in", () => {
    const harness = createCodexAppServerAgentHarness({
      bindingStore: testCodexAppServerBindingStore,
    });

    expect(harness.authBootstrap).toBe("harness");
    expect(typeof harness.authBinding?.fingerprint).toBe("function");
  });

  it("passes live Codex plugin config into public Codex app-server attempts", async () => {
    const registerAgentHarness = vi.fn();
    const liveConfig = {
      plugins: {
        entries: {
          codex: {
            enabled: true,
            config: {
              codexPlugins: {
                enabled: true,
                plugins: {
                  "google-calendar": {
                    marketplaceName: "openai-curated",
                    pluginName: "google-calendar",
                  },
                },
              },
            },
          },
        },
      },
    };
    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: { codexPlugins: { enabled: false } },
        runtime: createCodexTestRuntime(() => liveConfig),
        registerAgentHarness,
        registerCommand: vi.fn(),
        registerMediaUnderstandingProvider: vi.fn(),
        registerMigrationProvider: vi.fn(),
        registerProvider: vi.fn(),
        on: vi.fn(),
      }),
    );
    const harness = mockCallArg(registerAgentHarness) as ReturnType<
      typeof createCodexAppServerAgentHarness
    >;
    const result = { success: true };
    runCodexAppServerAttemptMock.mockResolvedValueOnce(result);

    await expect(harness.runAttempt({ prompt: "calendar" } as never)).resolves.toBe(result);

    expect(runCodexAppServerAttemptMock).toHaveBeenCalledWith(
      { prompt: "calendar" },
      {
        bindingStore: expect.any(Object),
        pluginConfig: liveConfig.plugins.entries.codex.config,
        nativeHookRelay: { enabled: true },
      },
    );
  });

  it("enables the native hook relay for public Codex side questions", async () => {
    const harness = createCodexAppServerAgentHarness({
      pluginConfig: { appServer: {} },
      bindingStore: testCodexAppServerBindingStore,
    });
    const runSideQuestion = harness["runSideQuestion"];
    const result = { text: "ok" };
    runCodexAppServerSideQuestionMock.mockResolvedValueOnce(result);

    if (!runSideQuestion) {
      throw new Error("Expected Codex harness to expose side questions");
    }
    await expect(runSideQuestion({ question: "btw" } as never)).resolves.toBe(result);

    expect(runCodexAppServerSideQuestionMock).toHaveBeenCalledWith(
      { question: "btw" },
      {
        bindingStore: testCodexAppServerBindingStore,
        pluginConfig: { appServer: {} },
        nativeHookRelay: { enabled: true },
      },
    );
  });
});
