// Memory Core tests cover index plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi, OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMemoryFlushPlan } from "./src/flush-plan.js";
import { buildMemoryPromptSection } from "./src/memory-tool-contract.js";
import type { MemoryCoreRuntimeHost } from "./src/memory/runtime-host.js";

const closeMemorySearchManagerMock = vi.hoisted(() => vi.fn(async () => {}));
const getMemorySearchManagerMock = vi.hoisted(() => vi.fn(async () => null));
const authorizeSearchHitsMock = vi.hoisted(() => vi.fn(async ({ hits }) => hits));
const createMemoryRuntimeMock = vi.hoisted(() =>
  vi.fn((_host: MemoryCoreRuntimeHost = {}) => ({
    authorizeSearchHits: authorizeSearchHitsMock,
    closeAllMemorySearchManagers: vi.fn(async () => {}),
    closeMemorySearchManager: closeMemorySearchManagerMock,
    getMemorySearchManager: getMemorySearchManagerMock,
  })),
);

vi.mock("./src/runtime-provider.js", () => ({
  createMemoryRuntime: createMemoryRuntimeMock,
  memoryRuntime: {
    closeAllMemorySearchManagers: vi.fn(async () => {}),
    closeMemorySearchManager: closeMemorySearchManagerMock,
    getMemorySearchManager: getMemorySearchManagerMock,
  },
}));

import plugin from "./index.js";

const hostRuntime = {
  llm: {
    acquireLocalService: async () => undefined,
  },
  state: {
    openKeyedStore: vi.fn(() => ({
      lookup: vi.fn(),
      register: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    })),
  },
} as unknown as OpenClawPluginApi["runtime"];

function hostRuntimeWithConfig(current: () => OpenClawConfig) {
  return createPluginRuntimeMock({
    ...hostRuntime,
    config: { ...hostRuntime.config, current },
  });
}

function registerMemoryCoreRuntime(): MemoryPluginRuntime {
  let runtime: MemoryPluginRuntime | undefined;
  plugin.register(
    createTestPluginApi({
      runtime: hostRuntime,
      registerMemoryCapability(capability) {
        runtime = capability.runtime;
      },
    }),
  );
  if (!runtime) {
    throw new Error("expected memory-core to register a memory runtime");
  }
  return runtime;
}

function captureMemoryModelContract(initialConfig: OpenClawConfig) {
  let promptBuilder:
    | NonNullable<Parameters<OpenClawPluginApi["registerMemoryCapability"]>[0]["promptBuilder"]>
    | undefined;
  const factories = new Map<string, (ctx: unknown) => unknown>();
  plugin.register(
    createTestPluginApi({
      config: initialConfig,
      runtime: hostRuntimeWithConfig(() => initialConfig),
      registerMemoryCapability(capability) {
        promptBuilder = capability.promptBuilder;
      },
      registerTool(factory, options) {
        for (const name of options?.names ?? []) {
          if (typeof factory === "function") {
            factories.set(name, factory as (ctx: unknown) => unknown);
          }
        }
      },
    }),
  );
  const context = {
    agentId: "main",
    config: initialConfig,
    getRuntimeConfig: () => initialConfig,
  };
  const search = factories.get("memory_search")?.(context) as
    | { description: string; parameters: unknown }
    | undefined;
  const get = factories.get("memory_get")?.(context) as
    | { description: string; parameters: unknown }
    | undefined;
  if (!search || !get || !promptBuilder) {
    throw new Error("expected memory model contract");
  }
  return { search, get, promptBuilder };
}

describe("buildPromptSection", () => {
  it("prepares explicitly owned memory tools without resolving unrelated legacy defaults", () => {
    let unrelatedDefaultReads = 0;
    const config: OpenClawConfig = {
      agents: {
        list: [
          { id: "main" },
          {
            id: "unrelated",
            get default() {
              unrelatedDefaultReads += 1;
              return false;
            },
          },
        ],
      },
    };
    const { search, get, promptBuilder } = captureMemoryModelContract(config);
    expect(search.description).toContain("MEMORY.md");
    expect(get.description).toContain("MEMORY.md");
    expect(
      promptBuilder({ availableTools: new Set(["memory_search", "memory_get"]), agentId: "main" }),
    ).toContain("## Memory Recall");
    expect(unrelatedDefaultReads).toBe(0);
  });

  it("returns empty when no memory tools are available", () => {
    expect(buildMemoryPromptSection({ availableTools: new Set() })).toStrictEqual([]);
  });

  it("describes the two-step flow when both memory tools are available", () => {
    const result = buildMemoryPromptSection({
      availableTools: new Set(["memory_search", "memory_get"]),
    });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_search");
    expect(result[1]).toContain("then use memory_get");
    expect(result).toContain(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
    expect(result.at(-1)).toBe("");
  });

  it("limits the guidance to memory_search when only search is available", () => {
    const result = buildMemoryPromptSection({
      availableTools: new Set(["memory_search"]),
    });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_search");
    expect(result[1]).not.toContain("then use memory_get");
  });

  it("limits the guidance to memory_get when only get is available", () => {
    const result = buildMemoryPromptSection({
      availableTools: new Set(["memory_get"]),
    });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_get");
    expect(result[1]).not.toContain("run memory_search");
  });

  it("includes citations-off instruction when citationsMode is off", () => {
    const result = buildMemoryPromptSection({
      availableTools: new Set(["memory_search"]),
      citationsMode: "off",
    });
    expect(result).toContain(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  });

  it.each([
    { label: "base files", extraPaths: [], sessions: false },
    { label: "configured extra paths", extraPaths: ["notes"], sessions: false },
    { label: "session transcripts", extraPaths: [], sessions: true },
    { label: "extra paths and sessions", extraPaths: ["notes"], sessions: true },
  ])("keeps eager, lazy, and prompt contracts aligned for $label", async (sourceCase) => {
    const config = {
      agents: {
        list: [
          {
            id: "main",
            default: true,
            memory: {
              search: {
                sources: sourceCase.sessions ? ["memory", "sessions"] : ["memory"],
                ...(sourceCase.sessions ? { experimental: { sessionMemory: true } } : {}),
              },
            },
          },
        ],
      },
      memory: { search: { provider: "none", extraPaths: sourceCase.extraPaths } },
    } as OpenClawConfig;
    const lazy = captureMemoryModelContract(config);
    const { createMemoryGetTool, createMemorySearchTool } = await import("./src/tools.js");
    const eagerSearch = createMemorySearchTool({ config, agentId: "main" });
    const eagerGet = createMemoryGetTool({ config, agentId: "main" });
    if (!eagerSearch || !eagerGet) {
      throw new Error("expected eager memory tools");
    }
    const prompt = lazy
      .promptBuilder({
        availableTools: new Set(["memory_search", "memory_get"]),
        agentId: "main",
      })
      .join("\n");

    expect(lazy.search.parameters).toStrictEqual(eagerSearch.parameters);
    expect(lazy.get.parameters).toStrictEqual(eagerGet.parameters);
    expect(lazy.search.description).toBe(eagerSearch.description);
    expect(lazy.get.description).toBe(eagerGet.description);
    for (const text of [lazy.search.description, lazy.get.description]) {
      expect(text).toContain("MEMORY.md, USER.md");
      expect(text).toContain("recursively under memory/");
      expect(text.includes("configured extra paths")).toBe(sourceCase.extraPaths.length > 0);
      expect(text.length).toBeLessThan(3_000);
    }
    expect(lazy.search.description.includes("indexed session transcripts")).toBe(
      sourceCase.sessions,
    );
    expect(lazy.get.description).not.toContain("indexed session transcripts");
    expect(lazy.search.description).toContain("Corpus outcomes cover each requested corpus");
    expect(lazy.search.description).toContain("results are partial");
    expect(lazy.get.description).toContain("status=ok");
    expect(lazy.get.description).toContain("status=not_found");
    expect(lazy.get.description).toContain("results are partial");
    expect(prompt).toContain("Report partial, unavailable, or stale recall");
    expect(prompt).toContain("warning and action guidance");
  });
});

describe("memory-core plugin runtime registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not resolve prompt config when no memory tools are exposed", () => {
    let promptBuilder:
      | NonNullable<Parameters<OpenClawPluginApi["registerMemoryCapability"]>[0]["promptBuilder"]>
      | undefined;
    const current = vi.fn(() => {
      throw new Error("runtime config must remain lazy");
    });
    plugin.register(
      createTestPluginApi({
        runtime: hostRuntimeWithConfig(current),
        registerMemoryCapability(capability) {
          promptBuilder = capability.promptBuilder;
        },
      }),
    );

    expect(promptBuilder?.({ availableTools: new Set() })).toStrictEqual([]);
    expect(current).not.toHaveBeenCalled();
  });

  it("registers the dreaming runtime slash command", () => {
    let command: OpenClawPluginCommandDefinition | undefined;
    plugin.register(
      createTestPluginApi({
        runtime: hostRuntime,
        registerCommand(definition) {
          command = definition;
        },
      }),
    );

    expect(command?.name).toBe("dreaming");
    expect(command?.acceptsArgs).toBe(true);
    expect(command?.exposeSenderIsOwner).toBe(true);
    expect(command?.description).toContain("Enable or disable");
  });

  it("registers the standing-intent tool and deterministic prompt hook", () => {
    const toolNames: string[] = [];
    const hooks: string[] = [];
    const subagentRun = vi.fn();
    plugin.register(
      createTestPluginApi({
        runtime: { ...hostRuntime, subagent: { run: subagentRun } } as never,
        registerTool(_factory, options?: Parameters<OpenClawPluginApi["registerTool"]>[1]) {
          toolNames.push(...(options?.names ?? []));
        },
        on(hookName) {
          hooks.push(hookName);
        },
      }),
    );

    expect(toolNames).toContain("intent");
    expect(hooks).toContain("before_prompt_build");
    expect(subagentRun).not.toHaveBeenCalled();
  });

  it("scopes both reply hooks to scheduled turns across three registrations", () => {
    for (let cycle = 1; cycle <= 3; cycle += 1) {
      const replyHookTriggers: unknown[] = [];
      plugin.register(
        createTestPluginApi({
          runtime: hostRuntime,
          on(hookName, _handler, options) {
            if (hookName === "before_agent_reply") {
              replyHookTriggers.push(options?.eligibleTriggers);
            }
          },
        }),
      );

      expect(replyHookTriggers, `cycle ${cycle}`).toEqual([
        ["heartbeat", "cron"],
        ["heartbeat", "cron"],
      ]);
    }
  });

  it("hides intent create, list, and cancel from non-owner turns", () => {
    const warn = vi.fn();
    let intentFactory:
      | ((ctx: { config?: OpenClawConfig; senderIsOwner?: boolean }) => unknown)
      | undefined;
    plugin.register(
      createTestPluginApi({
        config: {},
        runtime: hostRuntime,
        logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn },
        registerTool(factory, options) {
          if (options?.names?.includes("intent") && typeof factory === "function") {
            intentFactory = factory as typeof intentFactory;
          }
        },
      }),
    );
    if (!intentFactory) {
      throw new Error("expected standing-intent tool factory");
    }

    expect(intentFactory({ config: {}, senderIsOwner: false })).toBeNull();
    expect(intentFactory({ config: {} })).toBeNull();
    expect(warn).not.toHaveBeenCalled();

    expect(intentFactory({ senderIsOwner: true })).toBeNull();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      "memory-core: intent tool unavailable: runtime config is unavailable for this turn",
    );

    const ownerTool = intentFactory({ config: {}, senderIsOwner: true }) as {
      name?: string;
      description?: string;
      parameters?: {
        properties?: Record<string, { default?: string }>;
      };
    };
    expect(ownerTool).toMatchObject({ name: "intent" });
    expect(ownerTool.description).toContain("Use scheduled tasks for time-based reminders");
    expect(ownerTool.description).not.toMatch(/\b(?:cron|automations)\b/u);
    expect(ownerTool.parameters?.properties?.scope?.default).toBe("channel");
    expect(ownerTool.parameters?.properties?.senderScope?.default).toBe("sender");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps memory manager initialization demand-driven", () => {
    plugin.register(
      createTestPluginApi({
        runtime: hostRuntime,
      }),
    );

    expect(createMemoryRuntimeMock).not.toHaveBeenCalled();
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
  });

  it("wires scoped memory search cleanup through the lazy runtime", async () => {
    const runtime = registerMemoryCoreRuntime();
    const cfg = {} as OpenClawConfig;

    await runtime.closeMemorySearchManager?.({ cfg, agentId: "main" });

    expect(closeMemorySearchManagerMock).toHaveBeenCalledWith({ cfg, agentId: "main" });
  });

  it("binds the host local-service hook to the registered memory runtime", async () => {
    const runtime = registerMemoryCoreRuntime();
    const cfg = {} as OpenClawConfig;

    await runtime.getMemorySearchManager({ cfg, agentId: "main" });

    expect(createMemoryRuntimeMock).toHaveBeenCalledWith({
      acquireLocalService: expect.any(Function),
      openKeyedStore: expect.any(Function),
    });
  });

  it("defers nested host runtime access until the injected operation runs", async () => {
    const acquireLocalService = vi.fn(async () => undefined);
    const openKeyedStore = vi.fn(() => ({}));
    const llmGetter = vi.fn(() => ({ acquireLocalService }));
    const stateGetter = vi.fn(() => ({ openKeyedStore }));
    const host = Object.defineProperties(
      {},
      {
        llm: { configurable: true, enumerable: true, get: llmGetter },
        state: { configurable: true, enumerable: true, get: stateGetter },
      },
    ) as OpenClawPluginApi["runtime"];
    let runtime: MemoryPluginRuntime | undefined;

    plugin.register(
      createTestPluginApi({
        runtime: host,
        registerMemoryCapability(capability) {
          runtime = capability.runtime;
        },
      }),
    );

    expect(llmGetter).not.toHaveBeenCalled();
    expect(stateGetter).not.toHaveBeenCalled();
    await runtime?.getMemorySearchManager({ cfg: {}, agentId: "main" });
    const injectedHost = createMemoryRuntimeMock.mock.calls.at(-1)?.[0];
    if (!injectedHost?.acquireLocalService || !injectedHost.openKeyedStore) {
      throw new Error("expected memory-core host operations");
    }

    const target = { providerId: "local", baseUrl: "http://127.0.0.1:11434" };
    await injectedHost.acquireLocalService(target);
    const storeOptions = { namespace: "lazy-host", maxEntries: 1 };
    injectedHost.openKeyedStore(storeOptions);

    expect(llmGetter).toHaveBeenCalledOnce();
    expect(acquireLocalService).toHaveBeenCalledWith(target);
    expect(stateGetter).toHaveBeenCalledOnce();
    expect(openKeyedStore).toHaveBeenCalledWith(storeOptions);
  });

  it("forwards search-hit authorization through the registered memory runtime", async () => {
    const runtime = registerMemoryCoreRuntime();
    const cfg = {} as OpenClawConfig;
    const hits = [
      {
        source: "sessions" as const,
        path: "sessions/private.jsonl",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "private",
      },
    ];

    await expect(
      runtime.authorizeSearchHits?.({
        cfg,
        agentId: "main",
        requesterSessionKey: "agent:main:voice:15550001234",
        sandboxed: false,
        hits,
      }),
    ).resolves.toEqual(hits);
    expect(authorizeSearchHitsMock).toHaveBeenCalledWith({
      cfg,
      agentId: "main",
      requesterSessionKey: "agent:main:voice:15550001234",
      sandboxed: false,
      hits,
    });
    expect(createMemoryRuntimeMock).toHaveBeenCalledWith({
      acquireLocalService: expect.any(Function),
      openKeyedStore: expect.any(Function),
    });
  });

  it("binds the host SQLite state hook to tools and CLI runtime", async () => {
    const runtime = registerMemoryCoreRuntime();
    const cfg = {} as OpenClawConfig;

    await runtime.getMemorySearchManager({ cfg, agentId: "main" });

    const host = createMemoryRuntimeMock.mock.calls.at(-1)?.[0];
    const storeOptions = { namespace: "cli-status-regression", maxEntries: 1 };
    host?.openKeyedStore?.(storeOptions);
    expect(hostRuntime.state.openKeyedStore).toHaveBeenCalledWith(storeOptions);
  });
});

describe("buildMemoryFlushPlan", () => {
  const cfg = {
    agents: {
      defaults: {
        userTimezone: "America/New_York",
        timeFormat: "12",
      },
    },
  } as OpenClawConfig;

  it("replaces YYYY-MM-DD using user timezone and appends current time", () => {
    const plan = buildMemoryFlushPlan({
      cfg,
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(plan?.prompt).toContain("memory/2026-02-16.md");
    expect(plan?.prompt).toContain(
      "Current time: Monday, February 16th, 2026 - 10:00 AM (America/New_York)",
    );
    expect(plan?.prompt).toContain("Reference UTC: 2026-02-16 15:00 UTC");
    expect(plan?.relativePath).toBe("memory/2026-02-16.md");
  });

  it("appends one current time line to the built-in prompt", () => {
    const plan = buildMemoryFlushPlan({
      cfg,
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect((plan?.prompt.match(/Current time:/g) ?? []).length).toBe(1);
  });

  it("defaults to safe prompts and gating values", () => {
    const plan = buildMemoryFlushPlan();
    expect(plan?.softThresholdTokens).toBe(4000);
    expect(plan?.forceFlushTranscriptBytes).toBe(2 * 1024 * 1024);
    expect(plan?.prompt).toContain("memory/");
    expect(plan?.prompt).toContain("MEMORY.md");
    expect(plan?.systemPrompt).toContain("MEMORY.md");
  });

  it("respects disable flag", () => {
    expect(
      buildMemoryFlushPlan({
        cfg: {
          agents: {
            defaults: { compaction: { memoryFlush: { enabled: false } } },
          },
        },
      }),
    ).toBeNull();
  });

  it("carries configured memory flush model override", () => {
    const plan = buildMemoryFlushPlan({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {
                model: "ollama/qwen3:8b",
              },
            },
          },
        },
      },
    });

    expect(plan?.model).toBe("ollama/qwen3:8b");
  });

  it("falls back to defaults when numeric values are invalid", () => {
    const plan = buildMemoryFlushPlan({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {
                softThresholdTokens: -100,
              },
            },
          },
        },
      },
    });

    expect(plan?.softThresholdTokens).toBe(4000);
    expect(plan?.forceFlushTranscriptBytes).toBe(2 * 1024 * 1024);
  });

  it("parses forceFlushTranscriptBytes from byte-size strings", () => {
    const plan = buildMemoryFlushPlan({
      cfg: {
        agents: {
          defaults: {
            compaction: {
              memoryFlush: {
                forceFlushTranscriptBytes: "3mb",
              },
            },
          },
        },
      },
    });

    expect(plan?.forceFlushTranscriptBytes).toBe(3 * 1024 * 1024);
  });

  it("keeps overwrite guards in the default prompt", () => {
    const prompt = buildMemoryFlushPlan()?.prompt;
    expect(prompt).toMatch(/APPEND/i);
    expect(prompt).toContain("do not overwrite");
    expect(prompt).toContain("timestamped variant");
    expect(prompt).toMatch(/memory\/\d{4}-\d{2}-\d{2}\.md/);
  });
});
