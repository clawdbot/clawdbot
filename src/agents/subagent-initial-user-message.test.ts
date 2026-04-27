import { describe, expect, it } from "vitest";
import { buildSubagentInitialUserMessage } from "./subagent-initial-user-message.js";
import { buildSubagentSystemPrompt } from "./subagent-system-prompt.js";

describe("buildSubagentInitialUserMessage", () => {
  it("does not embed a task string already present in the system prompt (#72019)", () => {
    const msg = buildSubagentInitialUserMessage({
      childDepth: 1,
      maxSpawnDepth: 3,
      persistentSession: false,
    });

    expect(msg).not.toContain("[Subagent Task]:");
    expect(msg).toContain("**Your Role**");
    expect(msg).toContain("depth 1/3");
  });

  it("includes the persistent session note when requested", () => {
    const msg = buildSubagentInitialUserMessage({
      childDepth: 2,
      maxSpawnDepth: 4,
      persistentSession: true,
    });

    expect(msg).toContain("persistent and remains available");
  });

  it("keeps the delegated task single-sourced across system and first user text", () => {
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
    });

    expect(system).toContain("UNIQUE_SUBAGENT_TASK_TOKEN");
    expect(user).not.toContain("UNIQUE_SUBAGENT_TASK_TOKEN");
    expect(`${system}\n${user}`.match(/UNIQUE_SUBAGENT_TASK_TOKEN/g)).toHaveLength(1);
  });
});
