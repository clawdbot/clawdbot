import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_TOOL_NAMES } from "./legacy-config-migrations.runtime.tool-names.js";
import { TASK_SUGGESTION_TOOL_NAME_MIGRATION } from "./legacy-tool-name-migration.js";

const LEGACY_TASK_SUGGESTION_TOOL_NAME = TASK_SUGGESTION_TOOL_NAME_MIGRATION.legacyName;

function requireMigration(id: string) {
  const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_TOOL_NAMES.find((entry) => entry.id === id);
  expect(migration, `migration ${id}`).toBeDefined();
  return migration!;
}

describe("legacy tool name config migrations", () => {
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

    requireMigration("tools.suggest-task-name").apply(raw, changes);

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

  it("rewrites image inspection policy entries across every core-owned policy surface", () => {
    const raw = {
      tools: {
        allow: ["image", "read"],
        byProvider: { openai: { deny: ["IMAGE"] } },
        sandbox: { tools: { alsoAllow: [" image "] } },
        subagents: { tools: { deny: ["image"] } },
        toolsBySender: { "id:guest": { deny: ["image"] } },
      },
      agents: {
        entries: {
          main: {
            tools: {
              allow: ["image"],
              byProvider: { anthropic: { deny: ["image"] } },
              sandbox: { tools: { alsoAllow: ["image"] } },
              toolsBySender: { "id:guest": { deny: ["image"] } },
            },
          },
        },
      },
      channels: {
        discord: {
          guilds: {
            "1": {
              tools: { allow: ["image"] },
              toolsBySender: { "id:guest": { deny: ["image"] } },
            },
          },
        },
      },
      gateway: { tools: { allow: ["image"], deny: ["image", "image_generate"] } },
    };
    const changes: string[] = [];

    requireMigration("tools.view-image-name").apply(raw, changes);

    expect(raw.tools.allow).toEqual(["view_image", "read"]);
    expect(raw.tools.byProvider.openai.deny).toEqual(["view_image"]);
    expect(raw.tools.sandbox.tools.alsoAllow).toEqual(["view_image"]);
    expect(raw.tools.subagents.tools.deny).toEqual(["view_image"]);
    expect(raw.tools.toolsBySender["id:guest"].deny).toEqual(["view_image"]);
    expect(raw.agents.entries.main.tools.allow).toEqual(["view_image"]);
    expect(raw.agents.entries.main.tools.byProvider.anthropic.deny).toEqual(["view_image"]);
    expect(raw.agents.entries.main.tools.sandbox.tools.alsoAllow).toEqual(["view_image"]);
    expect(raw.agents.entries.main.tools.toolsBySender["id:guest"].deny).toEqual(["view_image"]);
    expect(raw.channels.discord.guilds["1"].tools.allow).toEqual(["view_image"]);
    expect(raw.channels.discord.guilds["1"].toolsBySender["id:guest"].deny).toEqual(["view_image"]);
    expect(raw.gateway.tools.allow).toEqual(["view_image"]);
    expect(raw.gateway.tools.deny).toEqual(["view_image", "image_generate"]);
    expect(changes).toHaveLength(1);
  });

  it.each([
    {
      name: "preserves image* and appends view_image",
      entries: ["image*"],
      expected: ["image*", "view_image"],
      changed: true,
    },
    {
      name: "preserves an arbitrary old-only wildcard and appends view_image",
      entries: ["i*e"],
      expected: ["i*e", "view_image"],
      changed: true,
    },
    { name: "leaves * unchanged", entries: ["*"], expected: ["*"], changed: false },
    {
      name: "leaves *image* unchanged",
      entries: ["*image*"],
      expected: ["*image*"],
      changed: false,
    },
    {
      name: "does not append when another pattern already covers view_image",
      entries: ["image*", "view_*"],
      expected: ["image*", "view_*"],
      changed: false,
    },
  ])("$name", ({ entries, expected, changed }) => {
    const raw = { tools: { allow: [...entries] } };
    const changes: string[] = [];

    requireMigration("tools.view-image-name").apply(raw, changes);

    expect(raw.tools.allow).toEqual(expected);
    expect(changes).toHaveLength(changed ? 1 : 0);
  });
});
