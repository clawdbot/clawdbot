import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectBuiltBundledPluginStagedRuntimeDependencyErrors,
  collectBundledPluginRootRuntimeMirrorErrors,
  collectBundledPluginRuntimeDependencySpecs,
  collectRootDistBundledRuntimeMirrors,
} from "./lib/bundled-plugin-root-runtime-mirrors.mjs";

function parseArgs(argv) {
  let packageRoot = process.env.OPENCLAW_BUNDLED_RUNTIME_DEPS_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--package-root") {
      packageRoot = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg?.startsWith("--package-root=")) {
      packageRoot = arg.slice("--package-root=".length);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return {
    packageRoot: path.resolve(
      packageRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    ),
  };
}

const { packageRoot } = parseArgs(process.argv.slice(2));
const rootPackageJsonPath = path.join(packageRoot, "package.json");
const builtPluginsDir = path.join(packageRoot, "dist", "extensions");

assert.ok(fs.existsSync(rootPackageJsonPath), `package.json missing from ${packageRoot}`);
assert.ok(fs.existsSync(builtPluginsDir), `built bundled plugins missing from ${builtPluginsDir}`);

const rootPackageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, "utf8"));
const bundledRuntimeDependencySpecs = collectBundledPluginRuntimeDependencySpecs(
  path.join(packageRoot, "extensions"),
);
const requiredRootMirrors = collectRootDistBundledRuntimeMirrors({
  bundledRuntimeDependencySpecs,
  distDir: path.join(packageRoot, "dist"),
});
const errors = [
  ...collectBundledPluginRootRuntimeMirrorErrors({
    bundledRuntimeDependencySpecs,
    requiredRootMirrors,
    rootPackageJson,
  }),
  ...collectBuiltBundledPluginStagedRuntimeDependencyErrors({
    bundledPluginsDir: builtPluginsDir,
  }),
];

assert.deepEqual(errors, [], errors.join("\n"));
process.stdout.write(
  `[build-smoke] bundled runtime dependency smoke passed packageRoot=${packageRoot}\n`,
);
