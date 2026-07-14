// System prompt memory tests cover opt-out behavior when context engines own
// memory prompt assembly for a run.
import { afterEach, describe, expect, it } from "vitest";
import {
  clearMemoryPluginState,
  registerMemoryPromptSection,
} from "../plugins/memory-state.test-fixtures.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("buildAgentSystemPrompt memory guidance", () => {
  afterEach(() => {
    clearMemoryPluginState();
  });

  it("can suppress base memory guidance so context engines own memory prompt assembly", () => {
    registerMemoryPromptSection(() => ["## Memory Recall", "Use memory carefully.", ""]);

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
    registerMemoryPromptSection((context) => {
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
});
