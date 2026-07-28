import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncPluginVersions } from "../../scripts/sync-plugin-versions.js";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs = new Set<string>();

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function makeFixture(
  packageJson: Record<string, unknown>,
  rootVersion = "2026.7.2-beta.5",
): {
  packagePath: string;
  rootDir: string;
} {
  const rootDir = makeTempDir(tempDirs, "openclaw-sync-plugin-versions-");
  const extensionDir = join(rootDir, "extensions", "buzz");
  const packagePath = join(extensionDir, "package.json");
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(
    join(rootDir, "package.json"),
    `${JSON.stringify({ version: rootVersion }, null, 2)}\n`,
  );
  writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  return { packagePath, rootDir };
}

describe("syncPluginVersions", () => {
  it("preserves metadata for an already-published pinned plugin version", () => {
    const fixture = makeFixture({
      name: "@openclaw/buzz",
      version: "2026.7.2-beta.5",
      peerDependencies: { openclaw: ">=2026.7.2-beta.3" },
      openclaw: {
        compat: { pluginApi: ">=2026.7.2-beta.3" },
        build: { openclawVersion: "2026.7.2" },
      },
    });
    const before = readFileSync(fixture.packagePath, "utf8");

    const result = syncPluginVersions(fixture.rootDir);

    expect(result.updated).toEqual([]);
    expect(result.skipped).toEqual(["@openclaw/buzz"]);
    expect(readFileSync(fixture.packagePath, "utf8")).toBe(before);
  });

  it("keeps aligning the same plugin on a later release version", () => {
    const fixture = makeFixture(
      {
        name: "@openclaw/buzz",
        version: "2026.7.2-beta.5",
        peerDependencies: { openclaw: ">=2026.7.2-beta.3" },
        openclaw: {
          compat: { pluginApi: ">=2026.7.2-beta.3" },
          build: { openclawVersion: "2026.7.2" },
        },
      },
      "2026.7.2-beta.6",
    );

    const result = syncPluginVersions(fixture.rootDir);
    const packageJson = JSON.parse(readFileSync(fixture.packagePath, "utf8")) as {
      openclaw: { build: { openclawVersion: string }; compat: { pluginApi: string } };
      peerDependencies: { openclaw: string };
      version: string;
    };

    expect(result.updated).toEqual(["@openclaw/buzz"]);
    expect(packageJson).toMatchObject({
      version: "2026.7.2-beta.6",
      peerDependencies: { openclaw: ">=2026.7.2-beta.6" },
      openclaw: {
        compat: { pluginApi: ">=2026.7.2-beta.6" },
        build: { openclawVersion: "2026.7.2-beta.6" },
      },
    });
  });
});
