import { readFile } from "node:fs/promises";
import path from "node:path";
import { controlUiPluginAssetPrefix } from "../../../src/gateway/control-ui-plugin-assets-contract.js";
import type { PluginManifestControlUi } from "../../../src/plugins/manifest-types.js";

export type NativeControlUiPluginFixture = {
  pluginId: string;
  rootDir: string;
  source: string;
};

const builds = new Map<string, Promise<PluginManifestControlUi>>();

/** Browser proofs load the same self-contained assets the plugin authoring command produces. */
export async function prepareNativeControlUiPluginFixtures(
  fixtures: readonly NativeControlUiPluginFixture[],
) {
  const plugins = [];
  const assets = new Map<string, { body: Buffer; contentType: string }>();
  for (const fixture of fixtures) {
    const key = `${fixture.rootDir}\0${fixture.source}`;
    let build = builds.get(key);
    if (!build) {
      build = import("../../../src/cli/plugins-control-ui-build.js").then(
        ({ buildPluginControlUi }) => buildPluginControlUi(fixture),
      );
      builds.set(key, build);
    }
    const declaration = await build;
    const revision = path.basename(path.dirname(declaration.entry));
    const prefix = `${controlUiPluginAssetPrefix(fixture.pluginId)}${revision}/`;
    for (const file of [declaration.entry, ...(declaration.styles ?? [])]) {
      assets.set(`${prefix}${path.basename(file)}`, {
        body: await readFile(path.join(fixture.rootDir, file)),
        contentType: file.endsWith(".css") ? "text/css" : "text/javascript",
      });
    }
    plugins.push({
      pluginId: fixture.pluginId,
      name: fixture.pluginId,
      revision,
      entryUrl: `${prefix}${path.basename(declaration.entry)}`,
      styles: (declaration.styles ?? []).map((file) => `${prefix}${path.basename(file)}`),
    });
  }
  return {
    assets,
    catalog: {
      revision: plugins.map((entry) => entry.revision).join("-"),
      plugins,
      diagnostics: [],
    },
  };
}
