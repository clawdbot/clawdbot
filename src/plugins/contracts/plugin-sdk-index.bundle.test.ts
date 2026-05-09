import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildPluginSdkEntrySources, pluginSdkEntrypoints } from "../../plugin-sdk/entrypoints.js";
import { createSuiteTempRootTracker } from "../test-helpers/fs-fixtures.js";
import { resolveBundledPluginFile } from "./test-helpers/bundled-plugin-roots.js";

const require = createRequire(import.meta.url);
const tsdownModuleUrl = pathToFileURL(require.resolve("tsdown")).href;
const bundledRepresentativeEntrypoints = ["browser-config"] as const;
const bundleTempRootTracker = createSuiteTempRootTracker(
  "openclaw-plugin-sdk-build",
  path.join(process.cwd(), "node_modules", ".cache"),
);
const matrixRuntimeCoverageEntries = {
  "matrix-runtime-sdk": resolveBundledPluginFile({
    pluginId: "matrix",
    relativePath: "src/matrix/sdk.ts",
  }),
} as const;
const bundledCoverageEntrySources = {
  ...buildPluginSdkEntrySources(bundledRepresentativeEntrypoints),
  ...matrixRuntimeCoverageEntries,
};
const bareMatrixSdkImportPattern = /(?:from|require|import)\s*\(?\s*["']matrix-js-sdk["']/;

async function listBuiltJsFiles(rootDir: string): Promise<string[]> {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        return await listBuiltJsFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".js") ? [entryPath] : [];
    }),
  );
  return nested.flat();
}

async function expectBuiltJsFile(outDir: string, entry: string): Promise<void> {
  const stat = await fs.stat(path.join(outDir, `${entry}.js`));
  expect(stat.isFile()).toBe(true);
  expect(stat.size).toBeGreaterThan(0);
}

describe("plugin-sdk bundled exports", () => {
  afterAll(() => {
    bundleTempRootTracker.cleanup();
  });

  it("emits importable bundled subpath entries", { timeout: 120_000 }, async () => {
    const bundleTempRoot = bundleTempRootTracker.ensureSuiteTempRoot();
    const outDir = path.join(bundleTempRoot, "bundle");
    await fs.rm(outDir, { recursive: true, force: true });
    await fs.mkdir(outDir, { recursive: true });

    const { build } = await import(tsdownModuleUrl);
    await build({
      clean: false,
      config: false,
      dts: false,
      deps: {
        // Match the production host build contract: Matrix SDK packages stay
        // external so the heavy runtime surface does not fold multiple
        // matrix-js-sdk entrypoints into one bundle artifact.
        neverBundle: ["@lancedb/lancedb", "@matrix-org/matrix-sdk-crypto-nodejs", "matrix-js-sdk"],
      },
      // Full plugin-sdk coverage belongs to `pnpm build`, package contract
      // guardrails, and `plugin-sdk-subpaths.test.ts`. This file only keeps the expensive
      // bundler path honest across representative entrypoint families plus the
      // Matrix SDK runtime import surface that historically crashed plugin
      // loading when bare and deep SDK entrypoints mixed.
      entry: bundledCoverageEntrySources,
      env: { NODE_ENV: "production" },
      fixedExtension: false,
      logLevel: "error",
      outDir,
      platform: "node",
    });

    expect(pluginSdkEntrypoints.length).toBeGreaterThan(bundledRepresentativeEntrypoints.length);
    await Promise.all(
      bundledRepresentativeEntrypoints.map(async (entry) => {
        await expectBuiltJsFile(outDir, entry);
      }),
    );
    await Promise.all(
      Object.keys(matrixRuntimeCoverageEntries).map(async (entry) => {
        await expectBuiltJsFile(outDir, entry);
      }),
    );
    const builtJsFiles = await listBuiltJsFiles(outDir);
    const filesWithBareMatrixSdkImports = (
      await Promise.all(
        builtJsFiles.map(async (filePath) => {
          const contents = await fs.readFile(filePath, "utf8");
          return bareMatrixSdkImportPattern.test(contents) ? filePath : null;
        }),
      )
    ).filter((filePath): filePath is string => filePath !== null);
    expect(filesWithBareMatrixSdkImports).toStrictEqual([]);

    // Export list and package-specifier coverage already live in
    // plugin-sdk-package-contract-guardrails.test.ts and plugin-sdk-subpaths.test.ts. Keep this file
    // focused on the expensive part: can tsdown emit working bundle artifacts?
    const importResults = await Promise.all(
      bundledRepresentativeEntrypoints.map(async (entry) => [
        entry,
        typeof (await import(pathToFileURL(path.join(outDir, `${entry}.js`)).href)),
      ]),
    );
    expect(Object.fromEntries(importResults)).toEqual(
      Object.fromEntries(bundledRepresentativeEntrypoints.map((entry) => [entry, "object"])),
    );
  });
});
