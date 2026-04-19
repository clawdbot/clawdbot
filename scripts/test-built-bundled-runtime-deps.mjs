import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  collectBuiltBundledPluginStagedRuntimeDependencyErrors,
  collectBundledPluginRootRuntimeMirrorErrors,
  collectBundledPluginRuntimeDependencySpecs,
  collectRootDistBundledRuntimeMirrors,
} from "./lib/bundled-plugin-root-runtime-mirrors.mjs";
import { parsePackageRootArg } from "./lib/package-root-args.mjs";

const { packageRoot } = parsePackageRootArg(
  process.argv.slice(2),
  "OPENCLAW_BUNDLED_RUNTIME_DEPS_ROOT",
);
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
