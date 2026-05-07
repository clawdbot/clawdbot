import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../..");
const require = createRequire(import.meta.url);
const uiRoot = path.resolve(repoRoot, "ui");
const fromHere = (p) => path.resolve(here, p);
const outputFile = path.resolve(here, "..", "a2ui", "a2ui.bundle.js");

const a2uiLitIndex = require.resolve("@a2ui/lit");
const a2uiLitUi = require.resolve("@a2ui/lit/ui");
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

export default {
  input: fromHere("bootstrap.js"),
  experimental: {
    attachDebugInfo: "none",
  },
  treeshake: false,
  resolve: {
    alias: {
      "@a2ui/lit": a2uiLitIndex,
      "@a2ui/lit/ui": a2uiLitUi,
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
    file: outputFile,
    format: "esm",
    codeSplitting: false,
    sourcemap: false,
  },
};
