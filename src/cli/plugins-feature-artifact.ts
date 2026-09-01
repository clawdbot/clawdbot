import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { create as createArchive } from "tar";
import { root } from "../infra/fs-safe.js";
import { loadPluginManifest, resolvePackageExtensionEntries } from "../plugins/manifest.js";
import { createPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { defaultRuntime } from "../runtime.js";
import { collectPluginsValidationResult } from "./plugins-authoring-command.js";

export type PluginsPackOptions = { root?: string; out?: string; json?: boolean };

/** Produce one reviewable import: bundled code, immutable UI assets, no install scripts. */
export async function packFeaturePlugin(opts: PluginsPackOptions) {
  const rootDir = await fs.realpath(path.resolve(opts.root ?? process.cwd()));
  const validation = await collectPluginsValidationResult({ root: rootDir });
  if (!validation.valid) {
    throw new Error(validation.errors.join("\n"));
  }
  const source = await root(rootDir, { symlinks: "reject", hardlinks: "reject" });
  const packageManifest = await source.readJson("package.json");
  if (!isRecord(packageManifest) || !isRecord(packageManifest.openclaw)) {
    throw new Error("Plugin package metadata is missing. Run openclaw plugins build.");
  }
  const extensions = resolvePackageExtensionEntries(packageManifest);
  if (extensions.status !== "ok" || extensions.entries.length !== 1) {
    throw new Error("Plugin artifacts require exactly one backend entrypoint.");
  }
  const entry = extensions.entries[0]!;
  const loaded = withPluginCache(createPluginCache(), () => loadPluginManifest(rootDir, false));
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  const require = createRequire(path.join(rootDir, "package.json"));
  // SAFETY: Node resolves the plugin's installed esbuild package with this public API.
  const builder = require("esbuild") as typeof import("esbuild");
  const result = await builder.build({
    absWorkingDir: rootDir,
    entryPoints: [entry],
    outfile: "dist/index.js",
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    external: ["openclaw", "openclaw/*"],
    // Bundled CommonJS dependencies still use require for Node builtins in ESM.
    banner: {
      js: 'import { createRequire as __openclawCreateRequire } from "node:module"; const require = __openclawCreateRequire(import.meta.url);',
    },
    write: false,
    metafile: true,
    logLevel: "silent",
  });
  const unbundled = Object.values(result.metafile.outputs)
    .flatMap((output) => output.imports)
    .filter(
      (item) =>
        item.external &&
        !isBuiltin(item.path) &&
        item.path !== "openclaw" &&
        !item.path.startsWith("openclaw/"),
    );
  if (unbundled.length || result.outputFiles.length !== 1) {
    throw new Error("Plugin artifact must bundle all dependencies into its backend entrypoint.");
  }
  const pluginId = loaded.manifest.id;
  const outputPath = path.resolve(opts.out ?? path.join(rootDir, `${pluginId}.tgz`));
  if (!/\.(?:tgz|tar\.gz)$/u.test(outputPath)) {
    throw new Error("Plugin artifact output must end in .tgz or .tar.gz.");
  }
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-pack-"));
  try {
    await fs.mkdir(path.join(staging, "package"));
    const destination = await root(path.join(staging, "package"), {
      mkdir: true,
      symlinks: "reject",
      hardlinks: "reject",
    });
    await destination.ensureRoot();
    const { controlUi: _source, ...openclaw } = packageManifest.openclaw;
    // Only runtime package metadata travels with the archive. Build-time dependencies
    // and scripts cannot trigger additional executable downloads after approval.
    const packedPackage = {
      name: packageManifest.name,
      version: packageManifest.version,
      type: "module",
      ...(typeof packageManifest.description === "string"
        ? { description: packageManifest.description }
        : {}),
      ...(typeof packageManifest.license === "string" ? { license: packageManifest.license } : {}),
      ...(isRecord(packageManifest.peerDependencies) &&
      typeof packageManifest.peerDependencies.openclaw === "string"
        ? { peerDependencies: { openclaw: packageManifest.peerDependencies.openclaw } }
        : {}),
      openclaw: { ...openclaw, extensions: ["./dist/index.js"] },
    };
    await destination.create("package.json", `${JSON.stringify(packedPackage, null, 2)}\n`);
    await destination.create(
      "openclaw.plugin.json",
      await source.readBytes("openclaw.plugin.json"),
    );
    await destination.mkdir("dist");
    await destination.create("dist/index.js", Buffer.from(result.outputFiles[0]!.contents));
    const controlUi = loaded.manifest.controlUi;
    for (const asset of controlUi ? [controlUi.entry, ...(controlUi.styles ?? [])] : []) {
      await destination.mkdir(path.dirname(asset));
      await destination.create(
        asset,
        await source.readBytes(asset, { maxBytes: 16 * 1024 * 1024 }),
      );
    }
    const archive = path.join(staging, "plugin.tgz");
    await createArchive(
      { cwd: staging, file: archive, gzip: true, portable: true, noMtime: true, strict: true },
      ["package"],
    );
    const bytes = await fs.readFile(archive);
    if (bytes.length > 32 * 1024 * 1024) {
      throw new Error("Plugin artifacts must be at most 32 MiB.");
    }
    // Exclusive creation preserves existing artifacts and their approval digests.
    await fs.writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    return {
      path: outputPath,
      sha256,
      pluginId,
      bytes: bytes.length,
      activation: { action: "plugin_activate_artifact", path: outputPath, sha256 },
    };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function runPluginsPackCommand(opts: PluginsPackOptions): Promise<void> {
  const receipt = await packFeaturePlugin(opts);
  if (opts.json) {
    defaultRuntime.writeJson(receipt);
    return;
  }
  defaultRuntime.log(
    `Packed ${receipt.pluginId}: ${receipt.path}\nSHA256: ${receipt.sha256}\nUse plugin_activate_artifact with this path and digest to request activation approval.`,
  );
}
