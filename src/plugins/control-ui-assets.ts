import path from "node:path";
import { root } from "../infra/fs-safe.js";
import { walkRootDirectory } from "../infra/root-walk.js";
import type { PluginManifestControlUi } from "./manifest-types.js";

export const CONTROL_UI_PLUGIN_MAX_ASSET_BYTES = 4 * 1024 * 1024;
export const CONTROL_UI_PLUGIN_MAX_BUILD_BYTES = 8 * 1024 * 1024;
const MAX_CONTROL_UI_ASSETS = 128;

export type PluginControlUiAsset = { body: Buffer; contentType: string };

// Serving and packing must capture the same bounded browser directory, including
// dependent chunks, without exposing package sources or unrelated files.
export async function readPluginControlUiAssets(
  rootDir: string,
  declaration: PluginManifestControlUi,
) {
  const pluginRoot = await root(rootDir, {
    hardlinks: "reject",
    symlinks: "reject",
    maxBytes: CONTROL_UI_PLUGIN_MAX_ASSET_BYTES,
  });
  const directory = path.posix.dirname(declaration.entry);
  const assets = new Map<string, PluginControlUiAsset>();
  let bytes = 0;
  for await (const entry of walkRootDirectory(pluginRoot.rootReal, directory, {
    symlinkPolicy: "skip",
    maxDepth: 8,
    maxEntries: MAX_CONTROL_UI_ASSETS,
    limitBehavior: "throw",
  })) {
    const relativePath = path.posix.relative(directory, entry.relativePath);
    if (
      entry.kind !== "file" ||
      !/^(?:[\w-][\w.-]*\/)*[\w-][\w.-]*\.(?:m?js|css)$/u.test(relativePath)
    ) {
      continue;
    }
    const body = await pluginRoot.readBytes(entry.relativePath);
    bytes += body.length;
    if (bytes > CONTROL_UI_PLUGIN_MAX_BUILD_BYTES) {
      throw new Error("browser build exceeds its byte limit");
    }
    assets.set(relativePath, {
      body,
      contentType: relativePath.endsWith(".css")
        ? "text/css; charset=utf-8"
        : "text/javascript; charset=utf-8",
    });
  }
  const entryName = path.posix.basename(declaration.entry);
  const styles = (declaration.styles ?? []).map((style) => path.posix.relative(directory, style));
  if (![entryName, ...styles].every((name) => assets.has(name))) {
    throw new Error("declared browser assets are missing");
  }
  return { directory, entryName, styles, assets, bytes };
}
