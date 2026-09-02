import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  CONTROL_UI_PLUGIN_MAX_ASSET_BYTES,
  CONTROL_UI_PLUGIN_MAX_BUILD_BYTES,
} from "../plugins/control-ui-assets.js";
import type { PluginManifestControlUi } from "../plugins/manifest-types.js";
import { PLUGIN_MANIFEST_FILENAME } from "../plugins/manifest.js";
import { buildPluginLoaderAliasMap } from "../plugins/sdk-alias.js";
import { buildPluginBundle } from "./plugins-build-bundle.js";

export async function writePluginBuildManifest(
  rootDir: string,
  manifest: Record<string, unknown>,
): Promise<void> {
  const temporary = path.join(rootDir, `.${PLUGIN_MANIFEST_FILENAME}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    await fs.rename(temporary, path.join(rootDir, PLUGIN_MANIFEST_FILENAME));
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

export async function buildPluginControlUi(params: {
  rootDir: string;
  source: string;
  check?: boolean;
}): Promise<PluginManifestControlUi> {
  const rootDir = await fs.realpath(params.rootDir);
  const entry = await fs.realpath(path.resolve(rootDir, params.source));
  const relative = path.relative(rootDir, entry);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("Control UI source must stay inside the plugin package.");
  }
  const require = createRequire(path.join(rootDir, "package.json"));
  let builder: typeof import("esbuild");
  try {
    // SAFETY: Node resolves the plugin's installed esbuild package with this public API.
    builder = require("esbuild") as typeof import("esbuild");
  } catch (cause) {
    throw new Error(
      "Install esbuild in this plugin's devDependencies, then run plugins build again.",
      { cause },
    );
  }
  const outputFiles = await buildPluginBundle(builder, {
    absWorkingDir: rootDir,
    entryPoints: { index: entry },
    outdir: path.join(rootDir, "dist/control-ui/build"),
    platform: "browser",
    target: "es2022",
    minify: true,
    legalComments: "none",
    sourcemap: false,
    tsconfigRaw: {
      compilerOptions: { experimentalDecorators: true, useDefineForClassFields: false },
    },
    alias: buildPluginLoaderAliasMap(entry, process.argv[1], import.meta.url),
  });
  const files = outputFiles.toSorted((left, right) => left.path.localeCompare(right.path));
  if (
    files.some((file) => file.contents.length > CONTROL_UI_PLUGIN_MAX_ASSET_BYTES) ||
    files.reduce((total, file) => total + file.contents.length, 0) >
      CONTROL_UI_PLUGIN_MAX_BUILD_BYTES
  ) {
    throw new Error(
      "Control UI builds allow at most 4 MiB per asset and 8 MiB per plugin. Reduce the browser bundle before installing.",
    );
  }
  if (
    !files.some((file) => path.basename(file.path) === "index.js") ||
    files.some((file) => !["index.js", "index.css"].includes(path.basename(file.path)))
  ) {
    throw new Error(
      "Control UI build must produce a JavaScript entrypoint and optional stylesheet.",
    );
  }
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(`${path.basename(file.path)}\0${file.contents.length}\0`).update(file.contents);
  }
  const output = `dist/control-ui/${hash.digest("hex")}`;
  const outputDir = path.join(rootDir, output);
  const declaration = {
    entry: `${output}/index.js`,
    ...(files.some((file) => file.path.endsWith(".css"))
      ? { styles: [`${output}/index.css`] }
      : {}),
  };
  if (params.check) {
    for (const file of files) {
      const existing = await fs
        .readFile(path.join(outputDir, path.basename(file.path)))
        .catch(() => null);
      if (!existing?.equals(Buffer.from(file.contents))) {
        throw new Error("Control UI build is missing or stale. Run openclaw plugins build.");
      }
    }
    return declaration;
  }

  // Publish an immutable directory before its manifest pointer. A failed build
  // cannot change the previous activation or expose a mixed JS/CSS generation.
  await fs.mkdir(path.dirname(outputDir), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(outputDir), ".build-"));
  try {
    for (const file of files) {
      await fs.writeFile(path.join(staging, path.basename(file.path)), file.contents);
    }
    try {
      await fs.rename(staging, outputDir);
    } catch (error) {
      if (!(isRecord(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY"))) {
        throw error;
      }
      for (const file of files) {
        const existing = await fs.readFile(path.join(outputDir, path.basename(file.path)));
        if (!existing.equals(Buffer.from(file.contents))) {
          throw new Error(
            "An immutable Control UI build was modified. Remove that build and rebuild.",
            { cause: error },
          );
        }
      }
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return declaration;
}
