import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import { createTaskSuggestionTools } from "./task-suggestion-tools.js";

function createTools(gatewayCall = vi.fn()) {
  return {
    gatewayCall,
    tools: createTaskSuggestionTools({
      sessionKey: "agent:main:main",
      agentId: "main",
      cwd: "/repo",
      callGateway: gatewayCall as never,
    }),
  };
}

describe("task suggestion tools", () => {
  it("creates a suggestion without starting work", async () => {
    const { gatewayCall, tools } = createTools(
      vi.fn(async () => ({ taskId: "task_123", suggestion: {} })),
    );
    const spawnTask = tools.find((tool) => tool.name === "spawn_task");

    const result = await spawnTask?.execute("call-1", {
      title: "Remove stale adapter",
      prompt: "Delete the unused adapter in src/example.ts and update its tests.",
      tldr: "The adapter is no longer reachable. Removing it reduces maintenance cost.",
    });

    expect(gatewayCall).toHaveBeenCalledWith(
      "taskSuggestions.create",
      {},
      {
        title: "Remove stale adapter",
        prompt: "Delete the unused adapter in src/example.ts and update its tests.",
        tldr: "The adapter is no longer reachable. Removing it reduces maintenance cost.",
        cwd: "/repo",
        sessionKey: "agent:main:main",
        agentId: "main",
      },
    );
    expect(result?.content).toEqual([
      { type: "text", text: JSON.stringify({ task_id: "task_123" }, null, 2) },
    ]);
    expect(spawnTask?.outputSchema).toBeDefined();
    expect(Value.Check(spawnTask!.outputSchema!, result?.details)).toBe(true);
    expect(compactToolOutputHint(spawnTask?.outputSchema)).toBe("{ task_id: string }");
    expect(tools.find((tool) => tool.name === "dismiss_task")?.outputSchema).toBeUndefined();
  });

  it("withdraws a pending suggestion", async () => {
    const { gatewayCall, tools } = createTools(
      vi.fn(async () => ({ taskId: "task_123", dismissed: true })),
    );
    const dismissTask = tools.find((tool) => tool.name === "dismiss_task");

    await dismissTask?.execute("call-2", { task_id: "task_123", reason: "Already fixed" });

    expect(gatewayCall).toHaveBeenCalledWith(
      "taskSuggestions.dismiss",
      {},
      { taskId: "task_123", reason: "Already fixed" },
    );
  });

  it("rejects relative project directories", async () => {
    const { tools } = createTools();
    const spawnTask = tools.find((tool) => tool.name === "spawn_task");

    await expect(
      spawnTask?.execute("call-3", {
        title: "Add coverage",
        prompt: "Add the missing regression test.",
        tldr: "The edge case is confirmed and untested.",
        cwd: "relative/repo",
      }),
    ).rejects.toThrow("cwd must be an absolute path");
  });
});
