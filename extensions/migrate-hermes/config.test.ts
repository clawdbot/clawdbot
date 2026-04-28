import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/provider-auth";
import { afterEach, describe, expect, it } from "vitest";
import { buildHermesMigrationProvider } from "./provider.js";
import {
  cleanupTempRoots,
  makeConfigRuntime,
  makeContext,
  makeTempRoot,
  writeFile,
} from "./test/provider-helpers.js";

describe("Hermes migration config mapping", () => {
  afterEach(async () => {
    await cleanupTempRoots();
  });

  it("plans provider, MCP, skill, and memory plugin config as plugin-owned items", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    await writeFile(
      path.join(source, "config.yaml"),
      [
        "model:",
        "  provider: openai",
        "  model: gpt-5.4",
        "providers:",
        "  openai:",
        "    base_url: https://api.openai.example/v1",
        "    api_key_env: OPENAI_API_KEY",
        "    models: [gpt-5.4]",
        "custom_providers:",
        "  - name: local-llm",
        "    base_url: http://127.0.0.1:11434/v1",
        "    models: [local-model]",
        "memory:",
        "  provider: honcho",
        "  honcho:",
        "    project: hermes",
        "skills:",
        "  config:",
        "    ship-it:",
        "      mode: fast",
        "mcp_servers:",
        "  time:",
        "    command: npx",
        "    args: ['-y', 'mcp-server-time']",
        "",
      ].join("\n"),
    );
    await writeFile(path.join(source, "memories", "MEMORY.md"), "memory line\n");

    const provider = buildHermesMigrationProvider();
    const plan = await provider.plan(makeContext({ source, stateDir, workspaceDir }));

    expect(plan.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "config:memory-plugin:honcho",
          kind: "config",
          action: "merge",
          target: "plugins.entries.honcho",
        }),
        expect.objectContaining({
          id: "manual:memory-provider:honcho",
          kind: "manual",
          status: "skipped",
        }),
        expect.objectContaining({
          id: "config:model-providers",
          details: expect.objectContaining({
            value: expect.objectContaining({
              openai: expect.objectContaining({
                baseUrl: "https://api.openai.example/v1",
                apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
              }),
              "local-llm": expect.objectContaining({
                baseUrl: "http://127.0.0.1:11434/v1",
              }),
            }),
          }),
        }),
        expect.objectContaining({
          id: "config:mcp-servers",
          details: expect.objectContaining({
            value: {
              time: {
                command: "npx",
                args: ["-y", "mcp-server-time"],
              },
            },
          }),
        }),
        expect.objectContaining({
          id: "config:skill-entries",
          details: expect.objectContaining({
            value: {
              "ship-it": {
                config: {
                  mode: "fast",
                },
              },
            },
          }),
        }),
      ]),
    );
    expect(plan.warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("manual review")]),
    );
  });

  it("applies mapped config items through the migration runtime config writer", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const config = {
      agents: { defaults: { workspace: workspaceDir } },
    } as OpenClawConfig;
    await writeFile(
      path.join(source, "config.yaml"),
      [
        "providers:",
        "  openai:",
        "    api_key_env: OPENAI_API_KEY",
        "    models: [gpt-5.4]",
        "mcp_servers:",
        "  time:",
        "    command: npx",
        "skills:",
        "  config:",
        "    ship-it:",
        "      mode: fast",
        "",
      ].join("\n"),
    );

    const provider = buildHermesMigrationProvider();
    const result = await provider.apply(
      makeContext({
        source,
        stateDir,
        workspaceDir,
        runtime: makeConfigRuntime(config),
      }),
    );

    expect(result.summary.errors).toBe(0);
    expect(config).toMatchObject({
      models: {
        providers: {
          openai: {
            apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
          },
        },
      },
      mcp: {
        servers: {
          time: {
            command: "npx",
          },
        },
      },
      skills: {
        entries: {
          "ship-it": {
            config: {
              mode: "fast",
            },
          },
        },
      },
    });
  });

  it("uses the provider runtime for CLI-applied config items", async () => {
    const root = await makeTempRoot();
    const source = path.join(root, "hermes");
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    const config: Record<string, unknown> = {
      agents: { defaults: { workspace: workspaceDir } },
    };
    await writeFile(
      path.join(source, "config.yaml"),
      [
        "mcp_servers:",
        "  time:",
        "    command: npx",
        "    env:",
        "      OPENAI_API_KEY: short-dev-key",
        "",
      ].join("\n"),
    );

    const provider = buildHermesMigrationProvider({ runtime: makeConfigRuntime(config) });
    const result = await provider.apply(makeContext({ source, stateDir, workspaceDir }));

    expect(result.summary.errors).toBe(0);
    expect(config).toMatchObject({
      mcp: {
        servers: {
          time: {
            command: "npx",
            env: {
              OPENAI_API_KEY: "short-dev-key",
            },
          },
        },
      },
    });
  });
});
