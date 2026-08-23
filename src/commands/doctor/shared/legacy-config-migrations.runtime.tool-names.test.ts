import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_TOOL_NAMES } from "./legacy-config-migrations.runtime.tool-names.js";
import { LEGACY_TASK_SUGGESTION_TOOL_NAME } from "./legacy-tool-name-migration.js";

describe("legacy task-suggestion tool name config migration", () => {
  it("rewrites persisted tool policy lists without touching unrelated allowlists", () => {
    const raw = {
      tools: {
        allow: [LEGACY_TASK_SUGGESTION_TOOL_NAME, "read"],
        agentToAgent: { allow: [LEGACY_TASK_SUGGESTION_TOOL_NAME] },
        byProvider: { openai: { deny: [LEGACY_TASK_SUGGESTION_TOOL_NAME.toUpperCase()] } },
        sandbox: { tools: { alsoAllow: [LEGACY_TASK_SUGGESTION_TOOL_NAME] } },
      },
      agents: {
        entries: {
          main: { tools: { allow: [LEGACY_TASK_SUGGESTION_TOOL_NAME] } },
        },
      },
      gateway: { tools: { deny: [LEGACY_TASK_SUGGESTION_TOOL_NAME] } },
      plugins: {
        entries: {
          example: { config: { toolsAllow: [LEGACY_TASK_SUGGESTION_TOOL_NAME] } },
        },
      },
    };
    const changes: string[] = [];

    LEGACY_CONFIG_MIGRATIONS_RUNTIME_TOOL_NAMES[0]?.apply(raw, changes);

    expect(raw.tools.allow).toEqual(["suggest_task", "read"]);
    expect(raw.tools.byProvider.openai.deny).toEqual(["suggest_task"]);
    expect(raw.tools.sandbox.tools.alsoAllow).toEqual(["suggest_task"]);
    expect(raw.agents.entries.main.tools.allow).toEqual(["suggest_task"]);
    expect(raw.gateway.tools.deny).toEqual(["suggest_task"]);
    // Plugin config is opaque plugin-owned data; the core migration must not
    // reach into it even when the key shape matches a tool policy.
    expect(raw.plugins.entries.example.config.toolsAllow).toEqual([
      LEGACY_TASK_SUGGESTION_TOOL_NAME,
    ]);
    expect(raw.tools.agentToAgent.allow).toEqual([LEGACY_TASK_SUGGESTION_TOOL_NAME]);
    expect(changes).toHaveLength(1);
  });
});
