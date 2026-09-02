import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExternalPluginLocalDist,
  listExternalPluginLocalDistPackageDirs,
} from "../../scripts/build-external-plugin-local-dist.mts";
import { copyBundledPluginMetadata } from "../../scripts/copy-bundled-plugin-metadata.mts";
import {
  collectRootPackageExcludedExtensionDirs,
  DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("external plugin local dist build", () => {
  it("retains each plugin's dependency owner and the shared host SDK", async () => {
    const repoRoot = tempDirs.make("openclaw-external-plugin-owners-");
    fs.writeFileSync(
      path.join(repoRoot, "package.json"),
      JSON.stringify({
        name: "openclaw",
        version: "1.0.0",
        type: "module",
        exports: { "./plugin-sdk/probe": "./probe.js" },
      }),
    );
    fs.writeFileSync(path.join(repoRoot, "probe.js"), "export const shared = {};\n");
    for (const [pluginId, version] of [
      ["first", "1.0.0"],
      ["second", "2.0.0"],
    ] as const) {
      const packageDir = path.join(repoRoot, "extensions", pluginId);
      const dependencyDir = path.join(packageDir, "node_modules", "private-dep");
      fs.mkdirSync(dependencyDir, { recursive: true });
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({
          name: `@openclaw/${pluginId}`,
          version: "1.0.0",
          type: "module",
          dependencies: { "private-dep": version },
          peerDependencies: { openclaw: "1.0.0" },
          openclaw: {
            extensions: ["./index.ts"],
            build: { bundledDist: false },
            release: { publishToNpm: true },
          },
        }),
      );
      fs.writeFileSync(
        path.join(dependencyDir, "package.json"),
        JSON.stringify({ name: "private-dep", version, type: "module", main: "index.js" }),
      );
      fs.writeFileSync(
        path.join(dependencyDir, "index.js"),
        `export default ${JSON.stringify(version)};\n`,
      );
      fs.symlinkSync(
        repoRoot,
        path.join(packageDir, "node_modules", "openclaw"),
        process.platform === "win32" ? "junction" : "dir",
      );
      fs.writeFileSync(
        path.join(packageDir, "index.ts"),
        'export { default as version } from "private-dep";\nexport { shared } from "openclaw/plugin-sdk/probe";\n',
      );
      fs.writeFileSync(
        path.join(packageDir, "openclaw.plugin.json"),
        JSON.stringify({ id: pluginId, skills: ["./node_modules/private-dep"] }),
      );
    }
    await buildExternalPluginLocalDist({ repoRoot, env: {}, logLevel: "silent" });
    copyBundledPluginMetadata({ repoRoot, env: {} });
    // Repeating postbuild must not remove source packages through the output link.
    copyBundledPluginMetadata({ repoRoot, env: {} });
    const entryUrl = (pluginId: string) =>
      pathToFileURL(path.join(repoRoot, "dist", "extensions", pluginId, "index.js")).href;
    const stagedDir = path.join(repoRoot, "staged", "first");
    fs.cpSync(path.join(repoRoot, "dist", "extensions", "first"), stagedDir, { recursive: true });
    const output = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      const first = await import(${JSON.stringify(entryUrl("first"))});
      const second = await import(${JSON.stringify(entryUrl("second"))});
      const staged = await import(${JSON.stringify(pathToFileURL(path.join(stagedDir, "index.js")).href)});
      console.log(JSON.stringify({ versions: [first.version, second.version, staged.version], shared: first.shared === second.shared && first.shared === staged.shared }));
    `,
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({ versions: ["1.0.0", "2.0.0", "1.0.0"], shared: true });
  });

  it("selects every externalized first-party plugin behind a package exclusion", () => {
    const packageDirs = listExternalPluginLocalDistPackageDirs();
    const excludedPluginIds = collectRootPackageExcludedExtensionDirs();

    expect(packageDirs).toHaveLength(67);
    expect(packageDirs).toEqual(
      expect.arrayContaining([
        "extensions/diffs",
        "extensions/diffs-language-pack",
        "extensions/discord",
        "extensions/feishu",
        "extensions/matrix",
        "extensions/slack",
        "extensions/sms",
        "extensions/mxc",
        "extensions/whatsapp",
      ]),
    );
    expect(
      packageDirs.every((packageDir) => excludedPluginIds.has(packageDir.split("/").at(-1) ?? "")),
    ).toBe(true);
  });

  it("leaves Docker-selected external plugin compilation on the unified build path", () => {
    expect(
      listExternalPluginLocalDistPackageDirs({
        env: {
          ...process.env,
          [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "slack,whatsapp",
        },
      }),
    ).toEqual([]);
  });

  it("performs no writes when Docker owns the selected build", async () => {
    await expect(
      buildExternalPluginLocalDist({
        env: {
          ...process.env,
          [DOCKER_SELECTED_PLUGIN_BUILD_IDS_ENV]: "slack,whatsapp",
        },
        logLevel: "silent",
      }),
    ).resolves.toMatchObject({ pluginDirs: [] });
  });
});
