// Check Plugin Sdk Wildcard Reexports tests cover check plugin sdk wildcard reexports script behavior.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findPluginSdkWildcardReexports } from "../../scripts/check-plugin-sdk-wildcard-reexports.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("check-plugin-sdk-wildcard-reexports", () => {
  it("flags wildcard re-exports from plugin-sdk subpaths", () => {
    expect(
      findPluginSdkWildcardReexports(
        [
          'export * from "openclaw/plugin-sdk/foo";',
          'export * as sdk from "openclaw/plugin-sdk/foo";',
          'export type * from "openclaw/plugin-sdk/bar";',
          'export type * as sdkTypes from "openclaw/plugin-sdk/bar";',
          'export { named } from "openclaw/plugin-sdk/foo";',
        ].join("\n"),
      ),
    ).toEqual([
      { line: 1, text: 'export * from "openclaw/plugin-sdk/foo";' },
      { line: 2, text: 'export * as sdk from "openclaw/plugin-sdk/foo";' },
      { line: 3, text: 'export type * from "openclaw/plugin-sdk/bar";' },
      { line: 4, text: 'export type * as sdkTypes from "openclaw/plugin-sdk/bar";' },
    ]);
  });

  it("allows explicit SDK exports and local wildcard barrels", () => {
    expect(
      findPluginSdkWildcardReexports(
        [
          'export { named } from "openclaw/plugin-sdk/foo";',
          'export type { Named } from "openclaw/plugin-sdk/foo";',
          'export * from "./src/runtime-api.js";',
          'export * as runtime from "./src/runtime-api.js";',
        ].join("\n"),
      ),
    ).toStrictEqual([]);
  });

  it("follows extension-root API barrel symlinks", () => {
    const root = tempDirs.make("openclaw-plugin-sdk-wildcard-");
    const scriptsDir = path.join(root, "scripts");
    const scriptsLibDir = path.join(scriptsDir, "lib");
    const extensionDir = path.join(root, "extensions", "fixture");
    mkdirSync(scriptsLibDir, { recursive: true });
    mkdirSync(extensionDir, { recursive: true });
    writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
    copyFileSync(
      new URL("../../scripts/check-plugin-sdk-wildcard-reexports.mts", import.meta.url),
      path.join(scriptsDir, "check-plugin-sdk-wildcard-reexports.mts"),
    );
    for (const fileName of ["extension-wildcard-reexport-scanner.mts", "repo-root.mjs"]) {
      copyFileSync(
        new URL(`../../scripts/lib/${fileName}`, import.meta.url),
        path.join(scriptsLibDir, fileName),
      );
    }
    writeFileSync(
      path.join(extensionDir, "actual-api.ts"),
      'export * from "openclaw/plugin-sdk/foo";\n',
    );
    symlinkSync("actual-api.ts", path.join(extensionDir, "api.ts"));

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        path.join(scriptsDir, "check-plugin-sdk-wildcard-reexports.mts"),
        "--json",
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        file: "extensions/fixture/api.ts",
        line: 1,
        text: 'export * from "openclaw/plugin-sdk/foo";',
      },
    ]);
  });
});
