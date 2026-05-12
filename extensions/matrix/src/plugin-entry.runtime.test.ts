import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const tempDirs: string[] = [];
const REPO_ROOT = process.cwd();
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

function writeSourceRuntimeWrapperFixture(
  fixtureRoot: string,
  options: { runtimeExtension?: ".js" | ".ts" } = {},
) {
  const runtimeExtension = options.runtimeExtension ?? ".js";
  writeFixtureFile(
    fixtureRoot,
    "extensions/matrix/src/plugin-entry.runtime.js",
    MATRIX_RUNTIME_WRAPPER_SOURCE,
  );
  writeFixtureFile(
    fixtureRoot,
    `extensions/matrix/plugin-entry.handlers.runtime${runtimeExtension}`,
    PACKAGED_RUNTIME_STUB,
  );
}

function importFixtureModule(fixtureRoot: string, relativePath: string) {
  const wrapperUrl = pathToFileURL(path.join(fixtureRoot, relativePath));
  return import(`${wrapperUrl.href}?t=${Date.now()}`);
}

function expectRuntimeWrapperExports(mod: unknown) {
  const exports = mod as Record<string, unknown>;
  expect(exports.ensureMatrixCryptoRuntime).toBeTypeOf("function");
  expect(exports.handleVerifyRecoveryKey).toBeTypeOf("function");
  expect(exports.handleVerificationBootstrap).toBeTypeOf("function");
  expect(exports.handleVerificationStatus).toBeTypeOf("function");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("loads the source-checkout runtime wrapper through native ESM import", async () => {
  const fixtureRoot = makeFixtureRoot(".tmp-matrix-source-runtime-");

  writeOpenClawPackageFixture(fixtureRoot);
  writeSourceRuntimeWrapperFixture(fixtureRoot);

  expectRuntimeWrapperExports(
    await importFixtureModule(fixtureRoot, "extensions/matrix/src/plugin-entry.runtime.js"),
  );
}, 240_000);

it("loads the packaged runtime wrapper without recursing through the stable root alias", async () => {
  const fixtureRoot = makeFixtureRoot(".tmp-matrix-runtime-");

  writeOpenClawPackageFixture(fixtureRoot);
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

it("does not load when only a TypeScript Matrix runtime shim exists", async () => {
  const fixtureRoot = makeFixtureRoot(".tmp-matrix-runtime-ts-only-");

  writeOpenClawPackageFixture(fixtureRoot);
  writeSourceRuntimeWrapperFixture(fixtureRoot, { runtimeExtension: ".ts" });

  await expect(
    importFixtureModule(fixtureRoot, "extensions/matrix/src/plugin-entry.runtime.js"),
  ).rejects.toThrow("Cannot resolve matrix plugin runtime module plugin-entry.handlers.runtime");
}, 240_000);
