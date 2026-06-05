#!/usr/bin/env node

// Builds browser runtime bundles for the diffs viewer assets.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const modulePath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(modulePath), "..");
const pierreDiffsEmptySideEffectNamespace = "openclaw-diffs-empty-side-effect";
const pierreDiffsEmptySideEffectPath = "pierre-diffs-parse-decorations-side-effect";

const targets = {
  curated: {
    entry: "extensions/diffs/src/viewer-client.ts",
    output: "extensions/diffs/assets/viewer-runtime.js",
    shikiAlias: "scripts/diffs-shiki-curated.ts",
  },
  full: {
    entry: "extensions/diffs/src/viewer-client.ts",
    output: "extensions/diffs-language-pack/assets/viewer-runtime.js",
  },
};

function toPosixPath(value) {
  return String(value ?? "").replaceAll("\\", "/");
}

/**
 * Creates the esbuild plugin that neutralizes Pierre diffs' browser side-effect import.
 */
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
  };
}

/**
 * Builds one configured diffs viewer runtime target.
 */
export async function buildDiffsViewerRuntime(targetName) {
  const target = targets[targetName];
  if (!target) {
    throw new Error(
      `Usage: node scripts/build-diffs-viewer-runtime.mjs ${Object.keys(targets).join("|")}`,
    );
  }

  const outputPath = path.join(repoRoot, target.output);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const result = await build({
    entryPoints: [path.join(repoRoot, target.entry)],
    bundle: true,
    platform: "browser",
    target: "es2020",
    format: "esm",
    minify: true,
    define: {
      NaN: "Number.NaN",
    },
    legalComments: "none",
    outfile: outputPath,
    write: false,
    plugins: [
      createPierreDiffsSideEffectImportPlugin(),
      ...(target.shikiAlias
        ? [
            {
              name: "openclaw-diffs-curated-shiki",
              setup(buildContext) {
                buildContext.onResolve({ filter: /^shiki$/ }, () => ({
                  path: path.join(repoRoot, target.shikiAlias),
                }));
              },
            },
          ]
        : []),
    ],
  });

  const outputFile = result.outputFiles?.[0];
  if (!outputFile) {
    throw new Error(`esbuild did not produce ${target.output}`);
  }

  const runtime = outputFile.text.replace(/[ \t]+$/gm, "");
  let previousRuntime = null;
  try {
    previousRuntime = await fs.readFile(outputPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  if (previousRuntime !== runtime) {
    await fs.writeFile(outputPath, runtime);
  }
}

if (process.argv[1] === modulePath) {
  await buildDiffsViewerRuntime(process.argv[2]);
}
