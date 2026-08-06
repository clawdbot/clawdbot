import { describe, expect, it } from "vitest";
import { buildCatalogList, renderCatalogListMarkdown } from "./list.js";
import { buildPluginCatalogCommands } from "./plugin-commands.js";

describe("plugin command catalog", () => {
  it("projects plugin CLI descriptors into source-labeled catalog entries", () => {
    const pluginCommands = buildPluginCatalogCommands([
      {
        pluginId: "example-plugin",
        parentPath: ["nodes"],
        commands: ["camera"],
        descriptors: [
          { name: "camera", description: "Camera controls", hasSubcommands: true },
          {
            name: "status",
            description: "Internal camera status",
            hasSubcommands: false,
          },
        ],
      },
    ]);

    expect(pluginCommands).toEqual([
      expect.objectContaining({
        pluginId: "example-plugin",
        commandPath: ["nodes", "camera"],
        parentPath: ["nodes"],
        depth: 2,
        descriptorName: "camera",
        sourceKind: "plugin",
        sourceId: "example-plugin:nodes camera",
        discoveryMode: "plugin-descriptor",
      }),
      expect.objectContaining({
        sourceId: "example-plugin:nodes status",
      }),
    ]);
    expect(pluginCommands[0]).not.toHaveProperty("risk");
    expect(pluginCommands[0]).not.toHaveProperty("effectMode");
    expect(pluginCommands[0]).not.toHaveProperty("confirmationRequired");
    expect(buildCatalogList({ pluginCommands }).counts.pluginCommands).toBe(2);
  });

  it("omits plugin CLI command registrations without descriptors", () => {
    const pluginCommands = buildPluginCatalogCommands([
      {
        pluginId: "voice-plugin",
        parentPath: [],
        commands: ["voicecall"],
        descriptors: [],
      },
    ]);

    expect(pluginCommands).toEqual([]);
    expect(buildCatalogList({ pluginCommands }).counts.pluginCommands).toBe(0);
  });

  it("omits plugin descriptors under reserved core command roots", () => {
    const pluginCommands = buildPluginCatalogCommands([
      {
        pluginId: "tools-plugin",
        parentPath: ["tools"],
        commands: ["sync"],
        descriptors: [{ name: "sync", description: "Sync tools", hasSubcommands: false }],
      },
      {
        pluginId: "auth-plugin",
        parentPath: [],
        commands: ["auth"],
        descriptors: [{ name: "auth", description: "Auth replacement", hasSubcommands: false }],
      },
      {
        pluginId: "node-plugin",
        parentPath: ["nodes"],
        commands: ["camera"],
        descriptors: [{ name: "camera", description: "Camera controls", hasSubcommands: false }],
      },
    ]);

    expect(pluginCommands.map((command) => command.commandPath)).toEqual([["nodes", "camera"]]);
    expect(buildCatalogList({ pluginCommands }).counts.pluginCommands).toBe(1);
  });

  it("keeps plugin descriptions inside their Markdown table cells", () => {
    const pluginCommands = buildPluginCatalogCommands([
      {
        pluginId: "example-plugin",
        parentPath: [],
        commands: ["camera"],
        descriptors: [
          {
            name: "camera",
            description: "Camera | controls\nfor operators",
            hasSubcommands: true,
          },
        ],
      },
    ]);

    expect(renderCatalogListMarkdown({ pluginCommands })).toContain(
      "| `camera` | None | 1 | `example-plugin` | Camera \\| controls for operators |",
    );
  });
});
