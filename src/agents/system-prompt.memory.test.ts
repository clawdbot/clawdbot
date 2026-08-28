// System prompt memory tests cover opt-out behavior when context engines own
// memory prompt assembly for a run.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearMemoryPluginState,
  registerMemoryPromptPreparation,
  registerTestMemoryPromptBuilder,
} from "../plugins/memory-state.test-fixtures.js";
import { prepareAgentMemoryPrompt } from "./memory-prompt-prepare.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("buildAgentSystemPrompt memory guidance", () => {
  afterEach(() => {
    clearMemoryPluginState();
  });

  it("can suppress base memory guidance so context engines own memory prompt assembly", () => {
    registerTestMemoryPromptBuilder(() => ["## Memory Recall", "Use memory carefully.", ""]);

    const promptWithMemory = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });
    const promptWithoutMemory = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      includeMemorySection: false,
    });

    expect(promptWithMemory).toContain("## Memory Recall");
    expect(promptWithoutMemory).not.toContain("## Memory Recall");
  });

  it("passes the active agent context to memory prompt assembly", () => {
    let observedContext:
      | { agentId?: string; agentSessionKey?: string; sandboxed?: boolean }
      | undefined;
    registerTestMemoryPromptBuilder((context) => {
      observedContext = context;
      return [
        "## Agent Memory",
        `agent=${context.agentId} session=${context.agentSessionKey} sandboxed=${context.sandboxed}`,
        "",
      ];
    });

    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["memory_search", "memory_get"],
      runtimeInfo: {
        agentId: "marketing-agent",
        sessionKey: "agent:marketing-agent:main",
      },
      sandboxInfo: { enabled: true },
    });

    expect(observedContext).toMatchObject({
      agentId: "marketing-agent",
      agentSessionKey: "agent:marketing-agent:main",
      sandboxed: true,
    });
    expect(prompt).toContain(
      "agent=marketing-agent session=agent:marketing-agent:main sandboxed=true",
    );
  });

  it("hands prepared memory lines to synchronous prompt assembly", async () => {
    const prepare = vi.fn(async () => ["## Prepared Wiki", "Prepared before assembly.", ""]);
    registerMemoryPromptPreparation("memory-wiki", prepare);
    const preparedMemoryPrompt = await prepareAgentMemoryPrompt({
      enabled: true,
      toolNames: ["WIKI_SEARCH"],
      agentId: "main",
      agentSessionKey: "agent:main:main",
    });

    const prompt = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      toolNames: ["WIKI_SEARCH"],
      runtimeInfo: { agentId: "main", sessionKey: "agent:main:main" },
      preparedMemoryPrompt,
    });

    expect(prompt).toContain("## Prepared Wiki\nPrepared before assembly.");
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
