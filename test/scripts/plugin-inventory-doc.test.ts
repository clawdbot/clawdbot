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
    ).toEqual([
      "Channels: `discord`",
      "Providers: `openai`",
      "Contracts: `tools`, `webSearchProviders`",
      "Dashboard data bindings: `example.items.list`",
      "Dashboard action verbs: `example.refresh`",
      "Skills",
    ]);
  });

  it("returns no surface items when the manifest declares none", () => {
    // The generic fallback now lives in renderSurface(), which prints
    // "This plugin declares no channels, providers, commands, or contracts."
    // for an empty list. Keeping it out of the data layer lets the caller
    // choose its own wording.
    expect(resolvePluginSurface({})).toEqual([]);
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
    ).toEqual([
      "CLI commands: `openclaw browser`, `openclaw voicecall`",
      "Slash commands: `/voice`",
    ]);
  });

  it("escapes dashboard plugin owner delimiters and literal escape markers", () => {
    expect(
      resolvePluginSurface({
        id: "dashboard.segmented",
        dashboard: { actionVerbs: [{ id: "refresh" }] },
      }),
    ).toEqual(["Dashboard action verbs: `dashboard%2Esegmented.refresh`"]);
    expect(
      resolvePluginSurface({
        id: "dashboard%2Esegmented",
        dashboard: { dataBindings: [{ id: "refresh" }] },
      }),
    ).toEqual(["Dashboard data bindings: `dashboard%252Esegmented.refresh`"]);
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
