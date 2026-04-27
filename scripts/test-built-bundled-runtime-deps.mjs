import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

function packageNodeModulesPath(nodeModulesDir, packageName) {
  return path.join(nodeModulesDir, ...packageName.split("/"));
}

function stageBrowserRuntimeDependencyStub(stageNodeModulesDir, packageName) {
  const packageDir = packageNodeModulesPath(stageNodeModulesDir, packageName);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, "package.json"),
    `${JSON.stringify(
      {
        name: packageName,
        version: "0.0.0",
        main: "./index.cjs",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  if (packageName === "playwright-core") {
    fs.writeFileSync(
      path.join(packageDir, "index.cjs"),
      [
        "module.exports = {",
        "  chromium: { marker: 'stub-chromium' },",
        "  devices: { 'Stub Device': { marker: 'stub-device' } },",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    return;
  }

  if (packageName === "typebox") {
    fs.writeFileSync(
      path.join(packageDir, "index.cjs"),
      [
        "const createSchema = (kind, value = {}) => ({ kind, ...value });",
        "const Type = new Proxy(function Type() {}, {",
        "  get(_target, prop) {",
        "    if (prop === Symbol.toStringTag) {",
        "      return 'Type';",
        "    }",
        "    return (...args) => createSchema(String(prop), { args });",
        "  },",
        "});",
        "module.exports = { Type };",
        "",
      ].join("\n"),
      "utf8",
    );
    return;
  }

  fs.writeFileSync(path.join(packageDir, "index.cjs"), "module.exports = {};\n", "utf8");
}

function findBuiltBrowserEntryPath(distDir) {
  const candidates = fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^pw-ai-(?!state-).*\.js$/u.test(entry.name))
    .map((entry) => path.join(distDir, entry.name))
    .toSorted((left, right) => left.localeCompare(right));
  if (candidates.length === 0) {
    throw new assert.AssertionError({
      message: `missing built pw-ai entry under ${distDir}`,
    });
  }
  return candidates[0];
}

function createBuiltBrowserImportSmokeFixture(packageRoot) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-built-browser-smoke-"));
  const tempDistDir = path.join(tempRoot, "dist");
  const tempNodeModulesDir = path.join(tempRoot, "node_modules");
  const stageNodeModulesDir = path.join(
    tempRoot,
    ".openclaw",
    "plugin-runtime-deps",
    "browser",
    "node_modules",
  );

  fs.cpSync(path.join(packageRoot, "dist"), tempDistDir, {
    recursive: true,
    dereference: true,
  });
  fs.copyFileSync(path.join(packageRoot, "package.json"), path.join(tempRoot, "package.json"));
  fs.cpSync(path.join(packageRoot, "node_modules"), tempNodeModulesDir, {
    recursive: true,
    dereference: true,
  });
  fs.rmSync(path.join(tempNodeModulesDir, "playwright-core"), {
    force: true,
    recursive: true,
  });

  assert.ok(!fs.existsSync(path.join(tempNodeModulesDir, "playwright-core")));
  fs.mkdirSync(stageNodeModulesDir, { recursive: true });
  assert.deepEqual(fs.readdirSync(stageNodeModulesDir), []);

  const browserPackageJson = JSON.parse(
    fs.readFileSync(path.join(tempDistDir, "extensions", "browser", "package.json"), "utf8"),
  );
  const browserRuntimeDeps = new Map(
    [
      ...Object.entries(browserPackageJson.dependencies ?? {}),
      ...Object.entries(browserPackageJson.optionalDependencies ?? {}),
    ].filter((entry) => typeof entry[1] === "string" && entry[1].length > 0),
  );
  const missingBrowserRuntimeDeps = [...browserRuntimeDeps.keys()]
    .filter((packageName) => {
      const rootSentinel = path.join(tempNodeModulesDir, ...packageName.split("/"), "package.json");
      const stagedSentinel = path.join(
        stageNodeModulesDir,
        ...packageName.split("/"),
        "package.json",
      );
      return !fs.existsSync(rootSentinel) && !fs.existsSync(stagedSentinel);
    })
    .toSorted((left, right) => left.localeCompare(right));

  for (const packageName of missingBrowserRuntimeDeps) {
    stageBrowserRuntimeDependencyStub(stageNodeModulesDir, packageName);
  }

  return {
    entryPath: findBuiltBrowserEntryPath(tempDistDir),
    stageNodeModulesDir,
    tempRoot,
  };
}

function runNodeEval(params) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", params.source], {
    cwd: params.cwd,
    encoding: "utf8",
    env: params.env,
  });
}

function runBuiltBrowserImportSmoke(packageRoot) {
  const fixture = createBuiltBrowserImportSmokeFixture(packageRoot);
  try {
    assert.ok(fs.existsSync(fixture.entryPath), `missing built pw-ai entry: ${fixture.entryPath}`);
    assert.ok(
      !fs.existsSync(path.join(fixture.tempRoot, "node_modules", "playwright-core")),
      "package-root playwright-core should be absent in the smoke fixture",
    );
    assert.ok(
      fs.existsSync(path.join(fixture.stageNodeModulesDir, "playwright-core", "package.json")),
      "staged playwright-core should be present in the smoke fixture",
    );

    const rootEsmResult = runNodeEval({
      cwd: fixture.tempRoot,
      env: { ...process.env, NODE_PATH: fixture.stageNodeModulesDir },
      source:
        "await import('playwright-core')" +
        ".then(() => { process.exitCode = 1; })" +
        ".catch((error) => { if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error; });",
    });
    assert.equal(
      rootEsmResult.status,
      0,
      [
        "[build-smoke] native ESM unexpectedly resolved staged playwright-core",
        rootEsmResult.stdout.trim(),
        rootEsmResult.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );

    const builtImportResult = runNodeEval({
      cwd: fixture.tempRoot,
      env: { ...process.env, NODE_PATH: fixture.stageNodeModulesDir },
      source: `await import(${JSON.stringify(pathToFileURL(fixture.entryPath).href)});`,
    });
    assert.equal(
      builtImportResult.status,
      0,
      [
        "[build-smoke] built browser pw-ai import failed",
        `status=${String(builtImportResult.status)}`,
        `signal=${String(builtImportResult.signal)}`,
        builtImportResult.stdout.trim(),
        builtImportResult.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } finally {
    fs.rmSync(fixture.tempRoot, { recursive: true, force: true });
  }
}

runBuiltBrowserImportSmoke(packageRoot);

process.stdout.write(
  `[build-smoke] bundled runtime dependency smoke passed packageRoot=${packageRoot}\n`,
);
