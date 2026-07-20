// Memory Core tests cover index plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi, OpenClawPluginCommandDefinition } from "openclaw/plugin-sdk/core";
import type { MemoryPluginRuntime } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMemoryFlushPlan } from "./src/flush-plan.js";
import type { MemoryCoreRuntimeHost } from "./src/memory/runtime-host.js";
import { buildPromptSection } from "./src/prompt-section.js";

const closeMemorySearchManagerMock = vi.hoisted(() => vi.fn(async () => {}));
const getMemorySearchManagerMock = vi.hoisted(() => vi.fn(async () => null));
const createMemoryRuntimeMock = vi.hoisted(() =>
  vi.fn((_host: MemoryCoreRuntimeHost = {}) => ({
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
      lookup: vi.fn(),
      register: vi.fn(),
      delete: vi.fn(),
      list: vi.fn(),
    })),
  },
} as unknown as OpenClawPluginApi["runtime"];

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
      acquireLocalService: hostRuntime.llm.acquireLocalService,
      withLease: expect.any(Function),
    });
  });

  it("binds the host SQLite lease hook to tools and CLI runtime", async () => {
    const runtime = registerMemoryCoreRuntime();
    const cfg = {} as OpenClawConfig;

    await runtime.getMemorySearchManager({ cfg, agentId: "main" });

    const host = createMemoryRuntimeMock.mock.calls.at(-1)?.[0];
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
      cfg: {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            compaction: {
              memoryFlush: {
                prompt: "Store durable notes in memory/YYYY-MM-DD.md",
              },
            },
          },
        },
      },
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(plan?.prompt).toContain("memory/2026-02-16.md");
    expect(plan?.prompt).toContain(
      "Current time: Monday, February 16th, 2026 - 10:00 AM (America/New_York)",
    );
    expect(plan?.prompt).toContain("Reference UTC: 2026-02-16 15:00 UTC");
    expect(plan?.relativePath).toBe("memory/2026-02-16.md");
  });

  it("does not append a duplicate current time line", () => {
    const plan = buildMemoryFlushPlan({
      cfg: {
        ...cfg,
        agents: {
          ...cfg.agents,
          defaults: {
            ...cfg.agents?.defaults,
            compaction: {
              memoryFlush: {
                prompt: "Store notes.\nCurrent time: already present",
              },
            },
          },
        },
      },
      nowMs: Date.UTC(2026, 1, 16, 15, 0, 0),
    });

    expect(plan?.prompt).toContain("Current time: already present");
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
