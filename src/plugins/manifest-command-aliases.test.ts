import { describe, expect, it } from "vitest";
import {
  normalizeManifestCommandAliases,
  resolveManifestCommandAliasOwnerInRegistry,
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

  it("resolves aliases without treating plugin ids as command aliases", () => {
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
      ],
    };

    expect(resolveManifestCommandAliasOwnerInRegistry({ command: "memory", registry })).toBe(
      undefined,
    );
    expect(
      resolveManifestCommandAliasOwnerInRegistry({ command: "legacy-memory", registry }),
    ).toMatchObject({
      pluginId: "memory",
      enabledByDefault: true,
      name: "legacy-memory",
    });
  });
});
