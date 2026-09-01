/**
 * Rolldown config for bundling the Canvas A2UI app into a single browser asset.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const require = createRequire(import.meta.url);
const uiRoot = path.resolve(repoRoot, "ui");
const fromHere = (p) => path.resolve(here, p);
const outputFile = process.env.OPENCLAW_A2UI_BUNDLE_OUT
  ? path.resolve(process.env.OPENCLAW_A2UI_BUNDLE_OUT)
  : path.resolve(here, "..", "a2ui", "a2ui.bundle.js");
const outputV09File = process.env.OPENCLAW_A2UI_BUNDLE_OUT
  ? `${outputFile}.v0.9.js`
  : path.resolve(here, "..", "a2ui", "a2ui-v0.9.bundle.js");

const a2uiLitIndex = require.resolve("@a2ui/lit");
const a2uiLitUi = require.resolve("@a2ui/lit/ui");
const a2uiLitV09 = require.resolve("@a2ui/lit/v0_9");
const a2uiWebCoreV09 = require.resolve("@a2ui/web_core/v0_9");
const a2uiThemeContext = path.resolve(path.dirname(a2uiLitUi), "context/theme.js");
const uiNodeModules = path.resolve(uiRoot, "node_modules");
const repoNodeModules = path.resolve(repoRoot, "node_modules");

function resolveUiDependency(moduleId) {
  const candidates = [
    path.resolve(uiNodeModules, moduleId),
    path.resolve(repoNodeModules, moduleId),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const fallbackCandidates = candidates.join(", ");
  throw new Error(
    `A2UI bundle config cannot resolve ${moduleId}. Checked: ${fallbackCandidates}. ` +
      "Keep dependency installed in ui workspace or repo root before bundling.",
  );
}

const createConfig = (input, file) => ({
  input,
  experimental: {
    attachDebugInfo: "none",
  },
  treeshake: false,
  resolve: {
    alias: {
      "@a2ui/lit": a2uiLitIndex,
      "@a2ui/lit/ui": a2uiLitUi,
      "@a2ui/lit/v0_9": a2uiLitV09,
      "@a2ui/web_core/v0_9": a2uiWebCoreV09,
      "@openclaw/a2ui-theme-context": a2uiThemeContext,
      "@lit/context": resolveUiDependency("@lit/context"),
      "@lit/context/": resolveUiDependency("@lit/context/"),
      "@lit-labs/signals": resolveUiDependency("@lit-labs/signals"),
      "@lit-labs/signals/": resolveUiDependency("@lit-labs/signals/"),
      lit: resolveUiDependency("lit"),
      "lit/": resolveUiDependency("lit/"),
      "signal-utils/": resolveUiDependency("signal-utils/"),
    },
  },
  output: {
    file,
    format: "esm",
    codeSplitting: false,
    sourcemap: false,
  },
});

export default [
  createConfig(fromHere("bootstrap.js"), outputFile),
  createConfig(fromHere("bootstrap-v0.9.js"), outputV09File),
];
