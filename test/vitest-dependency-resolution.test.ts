import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { createServer } from "vite";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";
import { sharedVitestConfig } from "./vitest/vitest.shared.config.ts";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("resolves Undici's real entry from each importer instead of the root install or Bun builtin", async () => {
  const root = tempDirs.make("openclaw-vitest-dependency-resolution-");
  const importers = [
    [root, "1.0.0"],
    [path.join(root, "extensions", "plugin-a"), "2.0.0"],
    [path.join(root, "extensions", "plugin-b"), "3.0.0"],
  ] as const;
  for (const [dir, version] of importers) {
    const dependencyDir = path.join(dir, "node_modules", "undici");
    fs.mkdirSync(dependencyDir, { recursive: true });
    fs.writeFileSync(path.join(dir, "source.test.ts"), 'import "undici";');
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ dependencies: { undici: version } }),
    );
    fs.writeFileSync(
      path.join(dependencyDir, "package.json"),
      JSON.stringify({ name: "undici", version, main: "index.js" }),
    );
    fs.writeFileSync(
      path.join(dependencyDir, "index.js"),
      `exports.version = ${JSON.stringify(version)};`,
    );
  }
  const server = await createServer({
    root,
    configFile: false,
    envDir: false,
    resolve: sharedVitestConfig.resolve,
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  });
  try {
    for (const [dir, version] of importers) {
      const importer = path.join(dir, "source.test.ts");
      const require = createRequire(importer);
      const resolved = await server.environments.ssr.pluginContainer.resolveId("undici", importer);
      expect(resolved).not.toBeNull();
      const entry = resolved!.id;
      expect(require(path.join(path.dirname(entry), "package.json")).version).toBe(version);
      expect(entry).toBe(require.resolve("undici/index.js"));
      expect(require(entry).version).toBe(version);
    }
  } finally {
    await server.close();
  }
});
