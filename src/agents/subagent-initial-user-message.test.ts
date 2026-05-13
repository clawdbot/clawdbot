import { describe, expect, it } from "vitest";
import { buildSubagentInitialUserMessage } from "./subagent-initial-user-message.js";
import { buildSubagentSystemPrompt } from "./subagent-system-prompt.js";

describe("buildSubagentInitialUserMessage", () => {
  it("embeds the delegated task in a visible task envelope", () => {
    const msg = buildSubagentInitialUserMessage({
      childDepth: 1,
      maxSpawnDepth: 3,
      persistentSession: false,
      task: "UNIQUE_VISIBLE_TASK\n  preserve indentation",
    });

    expect(msg).toContain("[Subagent Task]");
    expect(msg).toContain("UNIQUE_VISIBLE_TASK");
    expect(msg).toContain("  preserve indentation");
    expect(msg).not.toContain("**Your Role**");
    expect(msg).toContain("depth 1/3");
  });

  it("includes the persistent session note when requested", () => {
    const msg = buildSubagentInitialUserMessage({
      childDepth: 2,
      maxSpawnDepth: 4,
      persistentSession: true,
      task: "continue the task",
    });

    expect(msg).toContain("persistent and remains available");
  });

  it("keeps the delegated task single-sourced in first user text", () => {
    const task = "UNIQUE_SUBAGENT_TASK_TOKEN\n  preserve indentation";
    const system = buildSubagentSystemPrompt({
      childSessionKey: "agent:main:subagent:test",
      task,
      childDepth: 1,
      maxSpawnDepth: 2,
    });
    const user = buildSubagentInitialUserMessage({
      childDepth: 1,
      maxSpawnDepth: 2,
      persistentSession: false,
      task,
    });

    expect(system).not.toContain("UNIQUE_SUBAGENT_TASK_TOKEN");
    expect(user).toContain("UNIQUE_SUBAGENT_TASK_TOKEN");
    expect(`${system}\n${user}`.match(/UNIQUE_SUBAGENT_TASK_TOKEN/g)).toHaveLength(1);
  });
});
