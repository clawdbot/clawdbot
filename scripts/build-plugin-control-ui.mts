import fs from "node:fs/promises";
import path from "node:path";
import {
  buildPluginControlUi,
  controlUiSource,
  writePluginBuildManifest,
} from "../src/cli/plugins-control-ui-build.js";
import { resolveRepoRoot } from "./lib/repo-root.mjs";

const rootDir = process.cwd();
const packageManifest = JSON.parse(await fs.readFile(path.join(rootDir, "package.json"), "utf8"));
const manifest = JSON.parse(await fs.readFile(path.join(rootDir, "openclaw.plugin.json"), "utf8"));
if (process.argv.includes("--copy")) {
  const repoRoot = resolveRepoRoot(import.meta.url);
  const pluginDir = path.relative(path.join(repoRoot, "extensions"), rootDir);
  if (!pluginDir || pluginDir.includes(path.sep) || pluginDir.startsWith(".")) {
    throw new Error("Bundled UI copy must run inside one bundled plugin package.");
  }
  const output = path.dirname(manifest.controlUi.entry);
  if (!/^dist\/control-ui\/[a-f0-9]{64}$/u.test(output)) {
    throw new Error("Build the plugin's immutable Control UI assets before copying.");
  }
  await fs.cp(
    path.join(rootDir, output),
    path.join(repoRoot, "dist/extensions", pluginDir, output),
    { recursive: true },
  );
} else {
  const source = controlUiSource(packageManifest);
  if (!source) {
    throw new Error("Missing package.json openclaw.controlUi browser entrypoint.");
  }
  manifest.controlUi = await buildPluginControlUi({ rootDir, source });
  await writePluginBuildManifest(rootDir, manifest);
}
