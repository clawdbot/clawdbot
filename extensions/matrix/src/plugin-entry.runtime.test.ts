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
  writeFixtureFile(fixtureRoot, "dist/plugin-sdk/index.js", "export {};\n");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("loads the source-checkout runtime wrapper through native ESM import", async () => {
  const fixtureRoot = makeFixtureRoot(".tmp-matrix-source-runtime-");
  const wrapperSource = fs.readFileSync(
    path.join(REPO_ROOT, "extensions", "matrix", "src", "plugin-entry.runtime.js"),
    "utf8",
  );

  writeOpenClawPackageFixture(fixtureRoot);
  writeJitiFixture(fixtureRoot);
  writeFixtureFile(fixtureRoot, "extensions/matrix/src/plugin-entry.runtime.js", wrapperSource);
  writeFixtureFile(
    fixtureRoot,
    "extensions/matrix/plugin-entry.handlers.runtime.js",
    PACKAGED_RUNTIME_STUB,
  );

  const wrapperUrl = pathToFileURL(
    path.join(fixtureRoot, "extensions", "matrix", "src", "plugin-entry.runtime.js"),
  );
  const mod = await import(`${wrapperUrl.href}?t=${Date.now()}`);

  expect(mod).toMatchObject({
    ensureMatrixCryptoRuntime: expect.any(Function),
    handleVerifyRecoveryKey: expect.any(Function),
    handleVerificationBootstrap: expect.any(Function),
    handleVerificationStatus: expect.any(Function),
  });
}, 240_000);

it("loads the packaged runtime wrapper without recursing through the stable root alias", async () => {
  const fixtureRoot = makeFixtureRoot(".tmp-matrix-runtime-");
  const wrapperSource = fs.readFileSync(
    path.join(REPO_ROOT, "extensions", "matrix", "src", "plugin-entry.runtime.js"),
    "utf8",
  );

  writeOpenClawPackageFixture(fixtureRoot);
  writeJitiFixture(fixtureRoot);
  writeFixtureFile(fixtureRoot, "dist/plugin-entry.runtime-C88YIa_v.js", wrapperSource);
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

  const wrapperUrl = pathToFileURL(
    path.join(fixtureRoot, "dist", "plugin-entry.runtime-C88YIa_v.js"),
  );
  const mod = await import(`${wrapperUrl.href}?t=${Date.now()}`);

  expect(mod).toMatchObject({
    ensureMatrixCryptoRuntime: expect.any(Function),
    handleVerifyRecoveryKey: expect.any(Function),
    handleVerificationBootstrap: expect.any(Function),
    handleVerificationStatus: expect.any(Function),
  });
}, 240_000);
