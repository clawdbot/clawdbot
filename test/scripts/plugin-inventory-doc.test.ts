import { describe, expect, it } from "vitest";
import {
  assertPluginInventoryCoverage,
  resolvePluginSurface,
} from "../../scripts/lib/plugin-inventory-doc.mts";

describe("resolvePluginSurface", () => {
  it("keeps manifest identifiers as inline code while leaving labels visible", () => {
    expect(
      resolvePluginSurface({
        id: "example",
        channels: ["discord"],
        providers: ["openai"],
        contracts: {
          webSearchProviders: {},
          tools: {},
        },
        dashboard: {
          dataBindings: [{ id: "items.list" }],
          actionVerbs: [{ id: "refresh" }],
        },
        skills: ["example"],
      }),
    ).toBe(
      "channels: `discord`; providers: `openai`; contracts: `tools`, `webSearchProviders`; dashboard data bindings: `example.items.list`; dashboard action verbs: `example.refresh`; skills",
    );
  });

  it("retains the generic fallback", () => {
    expect(resolvePluginSurface({})).toBe("plugin");
  });

  it("renders root CLI commands separately from runtime slash command aliases", () => {
    expect(
      resolvePluginSurface({
        cliCommands: [
          { name: " voicecall " },
          { name: "browser" },
          { name: "voicecall" },
          { name: " " },
        ],
        commandAliases: [
          { name: "voice", kind: "runtime-slash" },
          { name: " voice ", kind: "runtime-slash" },
          { name: " ", kind: "runtime-slash" },
          { name: "internal", kind: "activation-only" },
        ],
      }),
    ).toBe("CLI commands: `openclaw browser`, `openclaw voicecall`; slash commands: `/voice`");
  });

  it("escapes dashboard plugin owner delimiters and literal escape markers", () => {
    expect(
      resolvePluginSurface({
        id: "dashboard.segmented",
        dashboard: { actionVerbs: [{ id: "refresh" }] },
      }),
    ).toBe("dashboard action verbs: `dashboard%2Esegmented.refresh`");
    expect(
      resolvePluginSurface({
        id: "dashboard%2Esegmented",
        dashboard: { dataBindings: [{ id: "refresh" }] },
      }),
    ).toBe("dashboard data bindings: `dashboard%252Esegmented.refresh`");
  });
});

describe("assertPluginInventoryCoverage", () => {
  it("detects a manifest directory omitted from the collected source entries", () => {
    expect(() =>
      assertPluginInventoryCoverage(
        [{ dirName: "packaged", id: "packaged" }],
        [
          { dirName: "manifest-only", id: "manifest-only" },
          { dirName: "packaged", id: "packaged" },
        ],
      ),
    ).toThrow(/missing dirNames: manifest-only.*missing ids: manifest-only/u);
  });

  it("detects duplicate ids in the independent manifest enumeration", () => {
    const entries = [
      { dirName: "one", id: "duplicate" },
      { dirName: "two", id: "duplicate" },
    ];
    expect(() => assertPluginInventoryCoverage(entries, entries)).toThrow(
      "duplicate manifest ids: duplicate",
    );
  });
});
