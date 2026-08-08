// Memory Core tests cover index plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi, OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import type {
  AnyAgentTool,
  MemoryPluginRuntime,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildMemoryFlushPlan } from "./src/flush-plan.js";
import type { MemoryCoreRuntimeHost } from "./src/memory/runtime-host.js";
import { buildPromptSection } from "./src/prompt-section.js";

const closeMemorySearchManagerMock = vi.hoisted(() => vi.fn(async () => {}));
const getMemorySearchManagerMock = vi.hoisted(() => vi.fn(async () => null));
const authorizeSearchHitsMock = vi.hoisted(() => vi.fn(async ({ hits }) => hits));
const memoryStateRegisterMock = vi.hoisted(() =>
  vi.fn<PluginStateKeyedStore<unknown>["register"]>(async () => undefined),
);
const memoryStateDeleteMock = vi.hoisted(() => vi.fn(async () => undefined));
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
    withLease: vi.fn(),
    openKeyedStore: vi.fn(() => ({
      lookup: vi.fn(async () => undefined),
      register: memoryStateRegisterMock,
      delete: memoryStateDeleteMock,
      entries: vi.fn(async () => []),
    })),
  },
} as unknown as OpenClawPluginApi["runtime"];

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function materializeMemoryStoreTool(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
  toolContext?: {
    sandboxed?: boolean;
    senderIsOwner?: boolean;
    isTurnTainted?: () => boolean;
    sessionKey?: string;
  };
}): AnyAgentTool {
  const tool = resolveMemoryStoreTool(params);
  if (!tool) {
    throw new Error("expected materialized memory_store tool");
  }
  return tool;
}

function resolveMemoryStoreTool(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
  toolContext?: {
    sandboxed?: boolean;
    senderIsOwner?: boolean;
    isTurnTainted?: () => boolean;
    sessionKey?: string;
  };
}): AnyAgentTool | null | undefined {
  let registration: Parameters<OpenClawPluginApi["registerTool"]>[0] | undefined;
  plugin.register(
    createTestPluginApi({
      config: params.cfg,
      runtime: hostRuntime,
      registerTool(toolOrFactory, options) {
        if (options?.names?.includes("memory_store")) {
          registration = toolOrFactory;
        }
      },
    }),
  );
  if (!registration) {
    throw new Error("expected memory-core to register memory_store");
  }
  const materialized =
    typeof registration === "function"
      ? registration({
          agentId: "main",
          config: params.cfg,
          runtimeConfig: params.cfg,
          getRuntimeConfig: () => params.cfg,
          workspaceDir: params.workspaceDir,
          sessionKey: "agent:main:main",
          ...params.toolContext,
        } as never)
      : registration;
  const tool = Array.isArray(materialized)
    ? materialized.find((candidate) => candidate.name === "memory_store")
    : materialized;
  return tool;
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

describe("buildPromptSection", () => {
  it("returns empty when no memory tools are available", () => {
    expect(buildPromptSection({ availableTools: new Set() })).toStrictEqual([]);
  });

  it("describes the two-step flow when both memory tools are available", () => {
    const result = buildPromptSection({
      availableTools: new Set(["memory_search", "memory_get"]),
    });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_search");
    expect(result[1]).toContain("then use memory_get");
    expect(result[1]).toContain("indexed session transcripts");
    expect(result).toContain(
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
    );
    expect(result.at(-1)).toBe("");
  });

  it("requires explicit remember requests to use memory_store before claiming persistence", () => {
    const result = buildPromptSection({
      availableTools: new Set(["memory_search", "memory_get", "memory_store"]),
    });

    expect(result.join("\n")).toContain("call memory_store");
    expect(result.join("\n")).toContain("details.memoryPersistence");
    expect(result.join("\n")).toContain("does not prove semantic recall");
  });

  it("limits the guidance to memory_search when only search is available", () => {
    const result = buildPromptSection({ availableTools: new Set(["memory_search"]) });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_search");
    expect(result[1]).toContain("indexed session transcripts");
    expect(result[1]).not.toContain("then use memory_get");
  });

  it("limits the guidance to memory_get when only get is available", () => {
    const result = buildPromptSection({ availableTools: new Set(["memory_get"]) });
    expect(result[0]).toBe("## Memory Recall");
    expect(result[1]).toContain("run memory_get");
    expect(result[1]).not.toContain("run memory_search");
  });

  it("includes citations-off instruction when citationsMode is off", () => {
    const result = buildPromptSection({
      availableTools: new Set(["memory_search"]),
      citationsMode: "off",
    });
    expect(result).toContain(
      "Citations are disabled: do not mention file paths or line numbers in replies unless the user explicitly asks.",
    );
  });
});

describe("memory-core memory_store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists and readback-verifies an explicit memory without initializing embeddings", async () => {
    const workspaceDir = tempDirs.make("memory-core-store-");
    const cfg = {
      agents: { defaults: { workspace: workspaceDir, userTimezone: "UTC" } },
    } as OpenClawConfig;
    const relativePath = buildMemoryFlushPlan({ cfg })?.relativePath;
    if (!relativePath) {
      throw new Error("expected daily memory path");
    }
    const tool = materializeMemoryStoreTool({ cfg, workspaceDir });

    expect(tool.description).toContain("details.memoryPersistence");
    expect(tool.memoryPersistenceReceiptVersion).toBe(1);
    const result = await tool.execute("store-1", { text: "The user prefers concise replies." });

    expect(result.details).toEqual({
      action: "created",
      memoryPersistence: {
        version: 1,
        status: "created",
        backend: "memory-core",
        target: { kind: "file", path: relativePath },
      },
    });
    await expect(fs.readFile(path.join(workspaceDir, relativePath), "utf8")).resolves.toContain(
      "The user prefers concise replies.",
    );
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
  });

  it.each(["ro", "none"] as const)(
    "does not expose memory_store in a %s sandbox",
    (workspaceAccess) => {
      const workspaceDir = tempDirs.make(`memory-core-store-sandbox-${workspaceAccess}-`);
      const cfg = {
        agents: {
          defaults: {
            workspace: workspaceDir,
            userTimezone: "UTC",
            sandbox: { workspaceAccess },
          },
        },
      } as OpenClawConfig;

      expect(
        resolveMemoryStoreTool({
          cfg,
          workspaceDir,
          toolContext: { sandboxed: true },
        }),
      ).toBeNull();
    },
  );

  it("returns already_present without duplicating an exact daily-memory entry", async () => {
    const workspaceDir = tempDirs.make("memory-core-store-dedupe-");
    const cfg = {
      agents: { defaults: { workspace: workspaceDir, userTimezone: "UTC" } },
    } as OpenClawConfig;
    const relativePath = buildMemoryFlushPlan({ cfg })?.relativePath;
    if (!relativePath) {
      throw new Error("expected daily memory path");
    }
    const tool = materializeMemoryStoreTool({ cfg, workspaceDir });

    await tool.execute("store-first", { text: "The user prefers concise replies." });
    const restartedTool = materializeMemoryStoreTool({ cfg, workspaceDir });
    const duplicate = await restartedTool.execute("store-duplicate", {
      text: "The user prefers concise replies.",
    });

    expect(duplicate.details).toEqual({
      action: "already_present",
      memoryPersistence: {
        version: 1,
        status: "already_present",
        backend: "memory-core",
        target: { kind: "file", path: relativePath },
      },
    });
    const stored = await fs.readFile(path.join(workspaceDir, relativePath), "utf8");
    expect(stored.match(/The user prefers concise replies\./g)).toHaveLength(1);
  });

  it("stays available when semantic search and compaction memory flush are disabled", async () => {
    const workspaceDir = tempDirs.make("memory-core-store-disabled-recall-");
    const cfg = {
      memory: { search: { enabled: false } },
      agents: {
        defaults: {
          workspace: workspaceDir,
          userTimezone: "UTC",
          compaction: { memoryFlush: { enabled: false } },
        },
      },
    } as OpenClawConfig;

    const tool = materializeMemoryStoreTool({ cfg, workspaceDir });
    const result = await tool.execute("store-with-recall-disabled", {
      text: "The user uses metric units.",
    });

    expect(result.details).toMatchObject({
      action: "created",
      memoryPersistence: { status: "created" },
    });
    expect(getMemorySearchManagerMock).not.toHaveBeenCalled();
  });

  it("records a tainted remember turn as untrusted provenance", async () => {
    const workspaceDir = tempDirs.make("memory-core-store-tainted-");
    const cfg = {
      agents: { defaults: { workspace: workspaceDir, userTimezone: "UTC" } },
    } as OpenClawConfig;
    const tool = materializeMemoryStoreTool({
      cfg,
      workspaceDir,
      toolContext: {
        senderIsOwner: true,
        isTurnTainted: () => true,
      },
    });

    await tool.execute("store-tainted", {
      text: "A network page claimed this is the user's preference.",
    });

    const provenanceValues = memoryStateRegisterMock.mock.calls.map(
      ([, value]) => asOptionalRecord(value)?.value,
    );
    expect(provenanceValues).toContainEqual(expect.objectContaining({ originClass: "untrusted" }));
  });

  it("returns no receipt and writes nothing for an incognito remember request", async () => {
    const workspaceDir = tempDirs.make("memory-core-store-incognito-");
    const cfg = {
      agents: { defaults: { workspace: workspaceDir, userTimezone: "UTC" } },
    } as OpenClawConfig;
    const tool = materializeMemoryStoreTool({
      cfg,
      workspaceDir,
      toolContext: {
        sessionKey: "agent:main:internal-session-effects:incognito-memory-test",
      },
    });

    const result = await tool.execute("store-incognito", {
      text: "This must not persist.",
    });

    expect(result.details).toEqual({ action: "rejected", reason: "incognito_session" });
    expect(result.details).not.toHaveProperty("memoryPersistence");
    await expect(fs.readdir(path.join(workspaceDir, "memory"))).rejects.toThrow();
  });

  it("serializes concurrent appends without losing either committed memory", async () => {
    const workspaceDir = tempDirs.make("memory-core-store-concurrent-");
    const cfg = {
      agents: { defaults: { workspace: workspaceDir, userTimezone: "UTC" } },
    } as OpenClawConfig;
    const relativePath = buildMemoryFlushPlan({ cfg })?.relativePath;
    if (!relativePath) {
      throw new Error("expected daily memory path");
    }
    const tool = materializeMemoryStoreTool({ cfg, workspaceDir });

    const results = await Promise.all([
      tool.execute("store-a", { text: "The user prefers concise replies." }),
      tool.execute("store-b", { text: "The user uses metric units." }),
    ]);

    expect(
      results.map((result) => (result.details as { action?: unknown } | undefined)?.action),
    ).toEqual(["created", "created"]);
    const stored = await fs.readFile(path.join(workspaceDir, relativePath), "utf8");
    expect(stored).toContain("The user prefers concise replies.");
    expect(stored).toContain("The user uses metric units.");
  });

  it("rejects a symlinked memory directory without writing outside the workspace", async () => {
    const workspaceDir = tempDirs.make("memory-core-store-symlink-");
    const outsideDir = tempDirs.make("memory-core-store-outside-");
    await fs.symlink(outsideDir, path.join(workspaceDir, "memory"), "dir");
    const cfg = {
      agents: { defaults: { workspace: workspaceDir, userTimezone: "UTC" } },
    } as OpenClawConfig;
    const tool = materializeMemoryStoreTool({ cfg, workspaceDir });

    await expect(
      tool.execute("store-escape", { text: "This must stay inside the workspace." }),
    ).rejects.toThrow();
    await expect(fs.readdir(outsideDir)).resolves.toEqual([]);
  });
});

describe("memory-core plugin runtime registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    let intentFactory:
      | ((ctx: { config?: OpenClawConfig; senderIsOwner?: boolean }) => unknown)
      | undefined;
    plugin.register(
      createTestPluginApi({
        config: {},
        runtime: hostRuntime,
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
    expect(intentFactory({ config: {}, senderIsOwner: true })).toMatchObject({ name: "intent" });
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
      withLease: expect.any(Function),
    });
  });

  it("defers nested host runtime access until the injected operation runs", async () => {
    const acquireLocalService = vi.fn(async () => undefined);
    const openKeyedStore = vi.fn(() => ({}));
    const withLease = vi.fn(async (_options, run) => await run({}));
    const llmGetter = vi.fn(() => ({ acquireLocalService }));
    const stateGetter = vi.fn(() => ({ openKeyedStore, withLease }));
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
    if (
      !injectedHost?.acquireLocalService ||
      !injectedHost.openKeyedStore ||
      !injectedHost.withLease
    ) {
      throw new Error("expected memory-core host operations");
    }

    const target = { providerId: "local", baseUrl: "http://127.0.0.1:11434" };
    await injectedHost.acquireLocalService(target);
    const storeOptions = { namespace: "lazy-host", maxEntries: 1 };
    injectedHost.openKeyedStore(storeOptions);
    const run = vi.fn(async () => "leased");
    const leaseOptions = {
      namespace: "lazy-host",
      key: "manager",
      database: { scope: "shared" as const },
      leaseMs: 1_000,
      waitMs: 1_000,
    };
    await injectedHost.withLease(leaseOptions, run as never);

    expect(llmGetter).toHaveBeenCalledOnce();
    expect(acquireLocalService).toHaveBeenCalledWith(target);
    expect(stateGetter).toHaveBeenCalledTimes(2);
    expect(openKeyedStore).toHaveBeenCalledWith(storeOptions);
    expect(withLease).toHaveBeenCalledWith(leaseOptions, run);
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
      withLease: expect.any(Function),
    });
  });

  it("binds the host SQLite state hooks to tools and CLI runtime", async () => {
    const runtime = registerMemoryCoreRuntime();
    const cfg = {} as OpenClawConfig;

    await runtime.getMemorySearchManager({ cfg, agentId: "main" });

    const host = createMemoryRuntimeMock.mock.calls.at(-1)?.[0];
    const storeOptions = { namespace: "cli-status-regression", maxEntries: 1 };
    host?.openKeyedStore?.(storeOptions);
    expect(hostRuntime.state.openKeyedStore).toHaveBeenCalledWith(storeOptions);
    expect(host?.withLease).toEqual(expect.any(Function));
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
