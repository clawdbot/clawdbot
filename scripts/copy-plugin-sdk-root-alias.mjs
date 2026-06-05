// Copies the CommonJS plugin SDK root alias into dist output.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeTextFileIfChanged } from "./runtime-postbuild-shared.mjs";

/**
 * Copies the plugin SDK root alias source into the configured output path.
 */
export function copyPluginSdkRootAlias(params = {}) {
  const cwd = params.cwd ?? process.cwd();
  const source = resolve(cwd, "src/plugin-sdk/root-alias.cjs");
  const target = resolve(cwd, "dist/plugin-sdk/root-alias.cjs");

  writeTextFileIfChanged(target, readFileSync(source, "utf8"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  copyPluginSdkRootAlias();
}
