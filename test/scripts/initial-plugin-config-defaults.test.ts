import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { collectInitialPluginConfigDefaults } from "../../scripts/generate-initial-plugin-config-defaults.mjs";

describe("initial plugin config defaults generator", () => {
  it("keeps native and TypeScript defaults in sync with shipped declarations", () => {
    expect(() =>
      execFileSync(
        process.execPath,
        ["scripts/generate-initial-plugin-config-defaults.mjs", "--check"],
        {
          stdio: "pipe",
        },
      ),
    ).not.toThrow();
  });
  it("accepts bundled and official declarations but excludes untrusted catalog entries", () => {
    const initialConfigDefaults = { sessionCatalog: { enabled: false } };
    expect(
      collectInitialPluginConfigDefaults({
        bundledManifests: [
          {
            manifest: { id: "bundled", configContracts: { initialConfigDefaults } },
            source: "bundled",
          },
        ],
        officialEntries: [
          {
            entry: {
              source: "official",
              openclaw: { plugin: { id: "official" }, configContracts: { initialConfigDefaults } },
            },
            source: "official",
          },
          {
            entry: {
              source: "community",
              openclaw: { plugin: { id: "untrusted" }, configContracts: { initialConfigDefaults } },
            },
            source: "untrusted",
          },
        ],
      }),
    ).toEqual({ bundled: initialConfigDefaults, official: initialConfigDefaults });
  });
});
