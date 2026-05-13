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

function itemById<T extends { id: string }>(items: T[], id: string): T | undefined {
  return items.find((item) => item.id === id);
}

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

    const memoryPlugin = itemById(plan.items, "config:memory-plugin:honcho");
    expect(memoryPlugin?.kind).toBe("config");
    expect(memoryPlugin?.action).toBe("merge");
    expect(memoryPlugin?.target).toBe("plugins.entries.honcho");

    const manualMemory = itemById(plan.items, "manual:memory-provider:honcho");
    expect(manualMemory?.kind).toBe("manual");
    expect(manualMemory?.status).toBe("skipped");

    const modelProviders = itemById(plan.items, "config:model-providers");
    const modelProviderValue = modelProviders?.details?.value as
      | {
          openai?: { baseUrl?: string; apiKey?: unknown };
          "local-llm"?: { baseUrl?: string };
        }
      | undefined;
    expect(modelProviderValue?.openai?.baseUrl).toBe("https://api.openai.example/v1");
    expect(modelProviderValue?.openai?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
    expect(modelProviderValue?.["local-llm"]?.baseUrl).toBe("http://127.0.0.1:11434/v1");

    const mcpServers = itemById(plan.items, "config:mcp-servers");
    expect(mcpServers?.details?.value).toEqual({
      time: {
        command: "npx",
        args: ["-y", "mcp-server-time"],
      },
    });

    const skillEntries = itemById(plan.items, "config:skill-entries");
    expect(skillEntries?.details?.value).toEqual({
      "ship-it": {
        config: {
          mode: "fast",
        },
      },
    });
    expect(plan.warnings).toEqual([
      "Some Hermes settings require manual review before they can be activated safely.",
    ]);
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
    expect(config.models?.providers?.openai?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "OPENAI_API_KEY",
    });
    expect(config.mcp?.servers?.time?.command).toBe("npx");
    expect(config.skills?.entries?.["ship-it"]?.config?.mode).toBe("fast");
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
    const mcp = config.mcp as
      | { servers?: { time?: { command?: unknown; env?: { OPENAI_API_KEY?: unknown } } } }
      | undefined;
    expect(mcp?.servers?.time?.command).toBe("npx");
    expect(mcp?.servers?.time?.env?.OPENAI_API_KEY).toBe("short-dev-key");
  });
});
