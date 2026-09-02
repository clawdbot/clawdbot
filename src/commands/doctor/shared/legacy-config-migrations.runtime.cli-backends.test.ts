// CLI backend legacy config migration tests cover adapter DSL retirement.
import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_CLI_BACKENDS } from "./legacy-config-migrations.runtime.cli-backends.js";

const migration = LEGACY_CONFIG_MIGRATIONS_RUNTIME_CLI_BACKENDS[0];

describe("CLI backend config migration", () => {
  it("strips the complete adapter map and points users to the plugin recipe", () => {
    const raw: Record<string, unknown> = {
      agents: {
        defaults: {
          model: "anthropic/claude-sonnet-4-6",
          cliBackends: {
            "claude-cli": {
              command: "/opt/claude",
              args: ["-p", "--output-format", "stream-json"],
              env: { CLAUDE_CONFIG_DIR: "/srv/claude" },
            },
          },
        },
      },
    };
    const changes: string[] = [];

    migration?.apply(raw, changes);

    expect(raw).toEqual({
      agents: { defaults: { model: "anthropic/claude-sonnet-4-6" } },
    });
    expect(changes).toEqual([
      "Removed agents.defaults.cliBackends; CLI backend adapters now register through plugins (https://docs.openclaw.ai/plugins/cli-backend-plugins).",
    ]);
  });

  it("leaves config without the retired key unchanged", () => {
    const raw: Record<string, unknown> = { agents: { defaults: { model: "openai/gpt-5.6" } } };
    const changes: string[] = [];

    migration?.apply(raw, changes);

    expect(raw).toEqual({ agents: { defaults: { model: "openai/gpt-5.6" } } });
    expect(changes).toEqual([]);
  });
});
