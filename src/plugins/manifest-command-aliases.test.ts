import { describe, expect, it } from "vitest";
import {
  normalizeManifestCommandAliases,
  resolveManifestCommandAliasOwnerInRegistry,
  resolveManifestToolOwnerInRegistry,
} from "./manifest-command-aliases.js";

describe("manifest command aliases", () => {
  it("normalizes string and object entries", () => {
    expect(
      normalizeManifestCommandAliases([
        "memory",
        { name: "reindex", kind: "runtime-slash", cliCommand: "memory" },
        { name: "" },
        { name: "bad-kind", kind: "unknown" },
      ]),
    ).toEqual([
      { name: "memory" },
      { name: "reindex", kind: "runtime-slash", cliCommand: "memory" },
      { name: "bad-kind" },
    ]);
  });

  it("resolves explicit same-id aliases without treating other plugin ids as aliases", () => {
    const registry = {
      plugins: [
        {
          id: "memory-core",
          commandAliases: [{ name: "memory", kind: "runtime-slash" as const }],
        },
        {
          id: "memory",
          enabledByDefault: true,
          commandAliases: [{ name: "legacy-memory" }],
        },
        {
          id: "matrix",
          commandAliases: [{ name: "matrix" }],
        },
      ],
    };

    expect(resolveManifestCommandAliasOwnerInRegistry({ command: "memory", registry })).toBe(
      undefined,
    );
    expect(
      resolveManifestCommandAliasOwnerInRegistry({ command: "legacy-memory", registry }),
    ).toEqual({
      name: "legacy-memory",
      pluginId: "memory",
      enabledByDefault: true,
    });
    expect(resolveManifestCommandAliasOwnerInRegistry({ command: "matrix", registry })).toEqual({
      name: "matrix",
      pluginId: "matrix",
    });
  });

  it("resolves agent tool owners from contracts.tools", () => {
    const registry = {
      plugins: [
        {
          id: "lossless-claw",
          contracts: { tools: ["lcm_recent", "lcm_search"] },
        },
        {
          id: "other-plugin",
          contracts: { tools: ["unrelated_tool"] },
        },
      ],
    };

    expect(resolveManifestToolOwnerInRegistry({ toolName: "lcm_recent", registry })).toEqual({
      toolName: "lcm_recent",
      pluginId: "lossless-claw",
    });
    expect(resolveManifestToolOwnerInRegistry({ toolName: "LCM_Recent", registry })).toEqual({
      toolName: "lcm_recent",
      pluginId: "lossless-claw",
    });
    expect(
      resolveManifestToolOwnerInRegistry({ toolName: "missing_tool", registry }),
    ).toBeUndefined();
    expect(resolveManifestToolOwnerInRegistry({ toolName: "", registry })).toBeUndefined();
  });
});
