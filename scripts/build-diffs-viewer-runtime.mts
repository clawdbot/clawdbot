#!/usr/bin/env node

// Builds browser runtime bundles for the diffs viewer assets.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "esbuild";
import { writeGeneratedTextAsset } from "./lib/generated-text-asset.mts";

const modulePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(modulePath), "..");
const pierreDiffsEmptySideEffectNamespace = "openclaw-diffs-empty-side-effect";
const pierreDiffsEmptySideEffectPath = "pierre-diffs-parse-decorations-side-effect";

const targets = {
  curated: {
    entry: "extensions/diffs/src/viewer-client.ts",
    output: "extensions/diffs/assets/viewer-runtime.js",
    shikiAlias: "scripts/diffs-shiki-curated.ts",
    languagePackAvailable: false,
  },
  full: {
    entry: "extensions/diffs/src/viewer-client.ts",
    output: "extensions/diffs-language-pack/assets/viewer-runtime.js",
    languagePackAvailable: true,
  },
};

function toPosixPath(value: string) {
  return value.replaceAll("\\", "/");
}

/**
 * Creates the esbuild plugin that neutralizes Pierre diffs' browser side-effect import.
 */
export function createPierreDiffsSideEffectImportPlugin(): {
  name: string;
  setup(buildContext: unknown): void;
};
export function createPierreDiffsSideEffectImportPlugin() {
  return {
    name: "openclaw-diffs-pierre-side-effect-imports",
    setup(buildContext) {
      buildContext.onResolve({ filter: /^diff$/ }, (args) => {
        const importer = toPosixPath(args.importer);
        if (!importer.endsWith("/@pierre/diffs/dist/utils/parseDiffDecorations.js")) {
          return undefined;
        }
        return {
          path: pierreDiffsEmptySideEffectPath,
          namespace: pierreDiffsEmptySideEffectNamespace,
          sideEffects: true,
        };
      });
      buildContext.onLoad(
        {
          filter: /^pierre-diffs-parse-decorations-side-effect$/,
          namespace: pierreDiffsEmptySideEffectNamespace,
        },
        () => ({
          contents: "export {};\n",
          loader: "js",
        }),
      );
    },
  } satisfies Plugin;
}

/**
 * Builds one configured diffs viewer runtime target.
 */
async function buildDiffsViewerRuntime(targetName: string | undefined) {
  const target = Object.entries(targets).find(([name]) => name === targetName)?.[1];
  if (!target) {
    throw new Error(
      `Usage: node --import tsx scripts/build-diffs-viewer-runtime.mts ${Object.keys(targets).join("|")}`,
    );
  }

  const outputPath = path.join(repoRoot, target.output);
  const shikiAlias = "shikiAlias" in target ? target.shikiAlias : undefined;
  const result = await build({
    entryPoints: [path.join(repoRoot, target.entry)],
    bundle: true,
    platform: "browser",
    target: "es2020",
    format: "esm",
    minify: true,
    define: {
      __OPENCLAW_DIFFS_LANGUAGE_PACK__: String(target.languagePackAvailable),
      NaN: "Number.NaN",
    },
    legalComments: "none",
    outfile: outputPath,
    write: false,
    plugins: [
      createPierreDiffsSideEffectImportPlugin(),
      ...(shikiAlias
        ? [
            {
              name: "openclaw-diffs-curated-shiki",
              setup(buildContext) {
                buildContext.onResolve({ filter: /^shiki$/ }, () => ({
                  path: path.join(repoRoot, shikiAlias),
                }));
              },
            } satisfies Plugin,
          ]
        : []),
    ],
  });

  const outputFile = result.outputFiles?.[0];
  if (!outputFile) {
    throw new Error(`esbuild did not produce ${target.output}`);
  }

  const runtime = outputFile.text.replace(/[ \t]+$/gm, "");
  await writeGeneratedTextAsset(outputPath, runtime);
}

if (process.argv[1] === modulePath) {
  await buildDiffsViewerRuntime(process.argv[2]);
}
