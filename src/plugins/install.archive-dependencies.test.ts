import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { installPluginFromPath } from "./install.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { packToArchive } from "./test-helpers/archive-fixtures.js";

const tempDirs = createTempDirTracker();
afterEach(() => {
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

it.each(["native", "native with a companion bundle"])(
  "installs runnable archive dependencies for %s plugins",
  async (format) => {
    const rootDir = tempDirs.make("openclaw-archive-dependencies-");
    const packageDir = path.join(rootDir, "package");
    const stateDir = path.join(rootDir, "state");
    const npmConfig = { userconfig: "user.npmrc", globalconfig: "global.npmrc" };
    for (const [key, name] of Object.entries(npmConfig)) {
      const file = path.join(rootDir, name);
      await fs.writeFile(file, "");
      vi.stubEnv(`npm_config_${key}`, file);
      vi.stubEnv(`NPM_CONFIG_${key.toUpperCase()}`, file);
    }
    for (const [key, value] of Object.entries({
      offline: "true",
      cache: path.join(rootDir, "npm-cache"),
    })) {
      vi.stubEnv(`npm_config_${key}`, value);
      vi.stubEnv(`NPM_CONFIG_${key.toUpperCase()}`, value);
    }
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    await fs.mkdir(path.join(packageDir, "dist"), { recursive: true });
    await fs.mkdir(path.join(packageDir, "dependency"));
    await fs.writeFile(
      path.join(packageDir, "dependency/package.json"),
      JSON.stringify({ name: "archive-dependency", version: "1.0.0", main: "index.cjs" }),
    );
    await fs.writeFile(
      path.join(packageDir, "dependency/index.cjs"),
      'module.exports = "installed dependency";\n',
    );
    await fs.writeFile(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "native-archive",
        version: "1.0.0",
        openclaw: { extensions: ["./dist/index.cjs"] },
        dependencies: { "archive-dependency": "file:./dependency" },
      }),
    );
    await fs.writeFile(
      path.join(packageDir, "openclaw.plugin.json"),
      JSON.stringify({ id: "native-archive", configSchema: { type: "object", properties: {} } }),
    );
    await fs.writeFile(
      path.join(packageDir, "dist/index.cjs"),
      'module.exports = { id: "native-archive", register() {}, value: require("archive-dependency") };\n',
    );
    if (format !== "native") {
      await fs.mkdir(path.join(packageDir, ".claude-plugin"));
      await fs.writeFile(
        path.join(packageDir, ".claude-plugin/plugin.json"),
        JSON.stringify({ name: "companion-bundle" }),
      );
    }
    const archivePath = await packToArchive({
      pkgDir: packageDir,
      outDir: rootDir,
      outName: "native-archive.tgz",
    });
    const result = await withPluginCache(createPluginCache(), () =>
      installPluginFromPath({
        path: archivePath,
        extensionsDir: path.join(stateDir, "extensions"),
        config: {},
      }),
    );
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.pluginId).toBe("native-archive");
    expect(result.artifactInspection?.format).toBe("openclaw");
    const entryPath = path.join(result.targetDir, "dist/index.cjs");
    const require = createRequire(entryPath);
    try {
      const entry = require(entryPath) as { value: string };
      expect(entry.value).toBe("installed dependency");
    } finally {
      for (const filename of Object.keys(require.cache)) {
        if (filename.startsWith(`${rootDir}${path.sep}`)) {
          delete require.cache[filename];
        }
      }
    }
  },
);
