import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const tempDirs: string[] = [];
const REPO_ROOT = process.cwd();
const require = createRequire(import.meta.url);
const JITI_ENTRY_PATH = require.resolve("jiti");
const matrixWrapperGlobal = globalThis as typeof globalThis & {
  __openclawMatrixWrapperJitiOptions?: unknown;
};
const PLUGIN_SDK_ROOT = ["openclaw", "plugin-sdk"].join("/");
const SCOPED_PLUGIN_SDK_ROOT = ["@openclaw", "plugin-sdk"].join("/");
const GROUP_ACCESS_SUBPATH = `${PLUGIN_SDK_ROOT}/group-access`;
const SCOPED_GROUP_ACCESS_SUBPATH = `${SCOPED_PLUGIN_SDK_ROOT}/group-access`;
const MATRIX_RUNTIME_WRAPPER_SOURCE = fs.readFileSync(
  path.join(REPO_ROOT, "extensions", "matrix", "src", "plugin-entry.runtime.js"),
  "utf8",
);
const PACKAGED_RUNTIME_STUB = [
  "export async function ensureMatrixCryptoRuntime() {}",
  "export async function handleVerifyRecoveryKey() {}",
  "export async function handleVerificationBootstrap() {}",
  "export async function handleVerificationStatus() {}",
  "",
].join("\n");

function makeFixtureRoot(prefix: string) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(fixtureRoot);
  return fixtureRoot;
}

function writeFixtureFile(fixtureRoot: string, relativePath: string, value: string) {
  const fullPath = path.join(fixtureRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, value, "utf8");
}

function writeJitiFixture(fixtureRoot: string) {
  writeFixtureFile(
    fixtureRoot,
    "node_modules/jiti/index.js",
    `module.exports = require(${JSON.stringify(JITI_ENTRY_PATH)});\n`,
  );
}

function writeCapturingJitiFixture(fixtureRoot: string) {
  writeFixtureFile(
    fixtureRoot,
    "node_modules/jiti/index.js",
    [
      "exports.createJiti = function createJiti(_filename, options) {",
      "  globalThis.__openclawMatrixWrapperJitiOptions = options;",
      "  return function jiti() {",
      "    return {",
      "      ensureMatrixCryptoRuntime: async function ensureMatrixCryptoRuntime() {},",
      "      handleVerifyRecoveryKey: async function handleVerifyRecoveryKey() {},",
      "      handleVerificationBootstrap: async function handleVerificationBootstrap() {},",
      "      handleVerificationStatus: async function handleVerificationStatus() {},",
      "    };",
      "  };",
      "};",
      "",
    ].join("\n"),
  );
}

function writeOpenClawPackageFixture(fixtureRoot: string) {
  writeFixtureFile(
    fixtureRoot,
    "package.json",
    JSON.stringify(
      {
        name: "openclaw",
        type: "module",
        exports: {
          "./plugin-sdk": "./dist/plugin-sdk/index.js",
        },
      },
      null,
      2,
    ) + "\n",
  );
  writeFixtureFile(fixtureRoot, "openclaw.mjs", "export {};\n");
  writeFixtureFile(fixtureRoot, "dist/plugin-sdk/index.js", "export {};\n");
}

function writeOpenClawAliasFixture(fixtureRoot: string, extraExports?: Record<string, string>) {
  writeFixtureFile(
    fixtureRoot,
    "package.json",
    JSON.stringify(
      {
        name: "openclaw",
        type: "module",
        exports: {
          "./plugin-sdk": "./dist/plugin-sdk/index.js",
          "./plugin-sdk/group-access": "./dist/plugin-sdk/group-access.js",
          ...extraExports,
        },
      },
      null,
      2,
    ) + "\n",
  );
  writeFixtureFile(fixtureRoot, "src/plugin-sdk/root-alias.cjs", "module.exports = {};\n");
  writeFixtureFile(fixtureRoot, "src/plugin-sdk/group-access.ts", "export {};\n");
  writeFixtureFile(fixtureRoot, "openclaw.mjs", "export {};\n");
  writeFixtureFile(fixtureRoot, "dist/plugin-sdk/index.js", "export {};\n");
  writeFixtureFile(fixtureRoot, "dist/plugin-sdk/root-alias.cjs", "module.exports = {};\n");
  writeFixtureFile(fixtureRoot, "dist/plugin-sdk/group-access.js", "export {};\n");
}

function writeTrustedOpenClawBinFixture(
  fixtureRoot: string,
  packageBin: string | Record<string, string>,
) {
  writeFixtureFile(
    fixtureRoot,
    "package.json",
    JSON.stringify(
      {
        name: "openclaw",
        type: "module",
        bin: packageBin,
        exports: {
          "./plugin-sdk": "./dist/plugin-sdk/index.js",
          "./plugin-sdk/group-access": "./dist/plugin-sdk/group-access.js",
        },
      },
      null,
      2,
    ) + "\n",
  );
  writeFixtureFile(fixtureRoot, "src/plugin-sdk/root-alias.cjs", "module.exports = {};\n");
  writeFixtureFile(fixtureRoot, "src/plugin-sdk/group-access.ts", "export {};\n");
  writeFixtureFile(fixtureRoot, "dist/plugin-sdk/index.js", "export {};\n");
  writeFixtureFile(fixtureRoot, "dist/plugin-sdk/root-alias.cjs", "module.exports = {};\n");
  writeFixtureFile(fixtureRoot, "dist/plugin-sdk/group-access.js", "export {};\n");
}

function writeSourceRuntimeWrapperFixture(fixtureRoot: string) {
  writeFixtureFile(
    fixtureRoot,
    "extensions/matrix/src/plugin-entry.runtime.js",
    MATRIX_RUNTIME_WRAPPER_SOURCE,
  );
  writeFixtureFile(
    fixtureRoot,
    "extensions/matrix/plugin-entry.handlers.runtime.js",
    PACKAGED_RUNTIME_STUB,
  );
}

function importFixtureModule(fixtureRoot: string, relativePath: string) {
  const wrapperUrl = pathToFileURL(path.join(fixtureRoot, relativePath));
  return import(`${wrapperUrl.href}?t=${Date.now()}`);
}

function expectRuntimeWrapperExports(mod: unknown) {
  expect(mod).toMatchObject({
    ensureMatrixCryptoRuntime: expect.any(Function),
    handleVerifyRecoveryKey: expect.any(Function),
    handleVerificationBootstrap: expect.any(Function),
    handleVerificationStatus: expect.any(Function),
  });
}

function writeCapturingSourceRuntimeWrapperFixture(fixtureRoot: string) {
  delete matrixWrapperGlobal.__openclawMatrixWrapperJitiOptions;
  writeOpenClawAliasFixture(fixtureRoot);
  writeCapturingJitiFixture(fixtureRoot);
  writeSourceRuntimeWrapperFixture(fixtureRoot);
}

function expectSourcePluginSdkAliases(fixtureRoot: string) {
  expect(matrixWrapperGlobal.__openclawMatrixWrapperJitiOptions).toMatchObject({
    alias: {
      [PLUGIN_SDK_ROOT]: path.join(fixtureRoot, "src", "plugin-sdk", "root-alias.cjs"),
      [SCOPED_PLUGIN_SDK_ROOT]: path.join(fixtureRoot, "src", "plugin-sdk", "root-alias.cjs"),
      [GROUP_ACCESS_SUBPATH]: path.join(fixtureRoot, "src", "plugin-sdk", "group-access.ts"),
      [SCOPED_GROUP_ACCESS_SUBPATH]: path.join(fixtureRoot, "src", "plugin-sdk", "group-access.ts"),
    },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("loads the source-checkout runtime wrapper through native ESM import", async () => {
  const fixtureRoot = makeFixtureRoot(".tmp-matrix-source-runtime-");

  writeOpenClawPackageFixture(fixtureRoot);
  writeJitiFixture(fixtureRoot);
  writeSourceRuntimeWrapperFixture(fixtureRoot);

  expectRuntimeWrapperExports(
    await importFixtureModule(fixtureRoot, "extensions/matrix/src/plugin-entry.runtime.js"),
  );
}, 240_000);

it("loads the packaged runtime wrapper without recursing through the stable root alias", async () => {
  const fixtureRoot = makeFixtureRoot(".tmp-matrix-runtime-");

  writeOpenClawPackageFixture(fixtureRoot);
  writeJitiFixture(fixtureRoot);
  writeFixtureFile(
    fixtureRoot,
    "dist/plugin-entry.runtime-C88YIa_v.js",
    MATRIX_RUNTIME_WRAPPER_SOURCE,
  );
  writeFixtureFile(
    fixtureRoot,
    "dist/plugin-entry.runtime.js",
    'export * from "./plugin-entry.runtime-C88YIa_v.js";\n',
  );
  writeFixtureFile(
    fixtureRoot,
    "dist/extensions/matrix/plugin-entry.handlers.runtime.js",
    PACKAGED_RUNTIME_STUB,
  );

  expectRuntimeWrapperExports(
    await importFixtureModule(fixtureRoot, "dist/plugin-entry.runtime-C88YIa_v.js"),
  );
}, 240_000);

it("builds scoped and unscoped plugin-sdk aliases for the wrapper jiti loader", async () => {
  const fixtureRoot = makeFixtureRoot(".tmp-matrix-runtime-aliases-");

  writeCapturingSourceRuntimeWrapperFixture(fixtureRoot);
  await importFixtureModule(fixtureRoot, "extensions/matrix/src/plugin-entry.runtime.js");

  expectSourcePluginSdkAliases(fixtureRoot);
}, 240_000);

it("resolves extension-api aliases through the same source extension family", async () => {
  const fixtureRoot = makeFixtureRoot(".tmp-matrix-runtime-extension-api-");

  writeFixtureFile(fixtureRoot, "src/extensionAPI.mts", "export {};\n");
  writeCapturingSourceRuntimeWrapperFixture(fixtureRoot);
  await importFixtureModule(fixtureRoot, "extensions/matrix/src/plugin-entry.runtime.js");

  expect(matrixWrapperGlobal.__openclawMatrixWrapperJitiOptions).toMatchObject({
    alias: {
      "openclaw/extension-api": path.join(fixtureRoot, "src", "extensionAPI.mts"),
    },
  });
}, 240_000);

it("keeps wrapper plugin-sdk aliases deterministic and ignores unsafe subpaths", async () => {
  const fixtureRoot = makeFixtureRoot(".tmp-matrix-runtime-alias-order-");

  delete matrixWrapperGlobal.__openclawMatrixWrapperJitiOptions;
  writeOpenClawAliasFixture(fixtureRoot, {
    "./plugin-sdk/zeta": "./dist/plugin-sdk/zeta.js",
    "./plugin-sdk/../escape": "./dist/plugin-sdk/escape.js",
    "./plugin-sdk/alpha": "./dist/plugin-sdk/alpha.js",
  });
  writeFixtureFile(fixtureRoot, "src/plugin-sdk/alpha.ts", "export {};\n");
  writeFixtureFile(fixtureRoot, "src/plugin-sdk/zeta.ts", "export {};\n");
  writeCapturingJitiFixture(fixtureRoot);
  writeSourceRuntimeWrapperFixture(fixtureRoot);
  await importFixtureModule(fixtureRoot, "extensions/matrix/src/plugin-entry.runtime.js");

  const aliasKeys = Object.keys(
    (
      (matrixWrapperGlobal.__openclawMatrixWrapperJitiOptions ?? {}) as {
        alias?: Record<string, string>;
      }
    ).alias ?? {},
  );
  expect(aliasKeys).toEqual([
    PLUGIN_SDK_ROOT,
    SCOPED_PLUGIN_SDK_ROOT,
    `${PLUGIN_SDK_ROOT}/alpha`,
    `${SCOPED_PLUGIN_SDK_ROOT}/alpha`,
    GROUP_ACCESS_SUBPATH,
    SCOPED_GROUP_ACCESS_SUBPATH,
    `${PLUGIN_SDK_ROOT}/zeta`,
    `${SCOPED_PLUGIN_SDK_ROOT}/zeta`,
  ]);
}, 240_000);

it("ignores nearby untrusted openclaw package stubs when resolving the wrapper root", async () => {
  const fixtureRoot = makeFixtureRoot(".tmp-matrix-runtime-trusted-root-");

  delete matrixWrapperGlobal.__openclawMatrixWrapperJitiOptions;
  writeOpenClawAliasFixture(fixtureRoot);
  writeFixtureFile(
    fixtureRoot,
    "extensions/package.json",
    JSON.stringify(
      {
        name: "openclaw",
        type: "module",
        exports: {
          "./plugin-sdk": "./dist/plugin-sdk/index.js",
          "./plugin-sdk/group-access": "./dist/plugin-sdk/group-access.js",
        },
      },
      null,
      2,
    ) + "\n",
  );
  writeFixtureFile(
    fixtureRoot,
    "extensions/src/plugin-sdk/root-alias.cjs",
    "module.exports = {};\n",
  );
  writeFixtureFile(fixtureRoot, "extensions/src/plugin-sdk/group-access.ts", "export {};\n");
  writeCapturingJitiFixture(fixtureRoot);
  writeSourceRuntimeWrapperFixture(fixtureRoot);
  await importFixtureModule(fixtureRoot, "extensions/matrix/src/plugin-entry.runtime.js");

  expectSourcePluginSdkAliases(fixtureRoot);
}, 240_000);

it("treats string bin hints case-insensitively when trusting wrapper package roots", async () => {
  const fixtureRoot = makeFixtureRoot(".tmp-matrix-runtime-bin-root-");

  delete matrixWrapperGlobal.__openclawMatrixWrapperJitiOptions;
  writeTrustedOpenClawBinFixture(fixtureRoot, "OpenClaw.MJS");
  writeCapturingJitiFixture(fixtureRoot);
  writeSourceRuntimeWrapperFixture(fixtureRoot);
  await importFixtureModule(fixtureRoot, "extensions/matrix/src/plugin-entry.runtime.js");

  expect(matrixWrapperGlobal.__openclawMatrixWrapperJitiOptions).toMatchObject({
    alias: {
      [PLUGIN_SDK_ROOT]: path.join(fixtureRoot, "src", "plugin-sdk", "root-alias.cjs"),
      [SCOPED_PLUGIN_SDK_ROOT]: path.join(fixtureRoot, "src", "plugin-sdk", "root-alias.cjs"),
    },
  });
}, 240_000);
