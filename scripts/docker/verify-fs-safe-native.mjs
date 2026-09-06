import assert from "node:assert/strict";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  let packageRoot;
  let mode;
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--package-root") {
      packageRoot = value;
    } else if (key === "--mode") {
      mode = value;
    } else {
      throw new Error(`unknown argument: ${key ?? ""}`);
    }
  }
  if (!packageRoot || (mode !== "require" && mode !== "fallback")) {
    throw new Error(
      "usage: verify-fs-safe-native.mjs --package-root <path> --mode <require|fallback>",
    );
  }
  // createRequire keeps symlinked bases; pnpm dependencies belong to the physical package.
  return { mode, packageRoot: fs.realpathSync(packageRoot) };
}

const { mode, packageRoot } = parseArgs(process.argv.slice(2));
const requireFromPackage = createRequire(path.join(packageRoot, "package.json"));
const fsSafeManifestPath = requireFromPackage.resolve("@openclaw/fs-safe/package.json");
const fsSafeManifest = JSON.parse(await fsPromises.readFile(fsSafeManifestPath, "utf8"));
const requireFromFsSafe = createRequire(fsSafeManifestPath);
const platformPackageNames = Object.keys(fsSafeManifest.optionalDependencies ?? {}).filter((name) =>
  name.startsWith("@openclaw/fs-safe-"),
);
const installedPlatformPackages = platformPackageNames.flatMap((name) => {
  try {
    const manifest = requireFromFsSafe.resolve(`${name}/package.json`);
    return [{ name, root: fs.realpathSync(path.dirname(manifest)) }];
  } catch {
    return [];
  }
});

const configPath = requireFromPackage.resolve("@openclaw/fs-safe/config");
const durabilityPath = requireFromPackage.resolve("@openclaw/fs-safe/durability");
const { configureFsSafeNative } = await import(pathToFileURL(configPath).href);
const { sha256File } = await import(pathToFileURL(durabilityPath).href);
configureFsSafeNative({ mode: mode === "require" ? "require" : "off" });

const temporaryRoot = await fsPromises.mkdtemp(path.join(os.tmpdir(), "openclaw-fs-safe-proof-"));
try {
  const fixture = path.join(temporaryRoot, "fixture.txt");
  await fsPromises.writeFile(fixture, "fs-safe native package proof");
  const result = await sha256File(fixture);
  assert.match(result.digest, /^[a-f0-9]{64}$/u);

  const loadedNativeModules = Object.keys(requireFromPackage.cache).filter((file) =>
    file.endsWith("fs-safe-native.node"),
  );
  if (mode === "require") {
    assert.ok(
      installedPlatformPackages.length > 0,
      "expected at least one fs-safe platform package",
    );
    assert.equal(
      loadedNativeModules.length,
      1,
      "expected exactly one loaded fs-safe native binding",
    );
    const loadedNativeRoot = fs.realpathSync(path.dirname(loadedNativeModules[0]));
    assert.ok(
      installedPlatformPackages.some(({ root }) => root === loadedNativeRoot),
      "loaded fs-safe native binding did not come from an installed platform package",
    );
  } else {
    assert.equal(
      installedPlatformPackages.length,
      0,
      "fallback install contains a platform package",
    );
    assert.equal(loadedNativeModules.length, 0, "fallback loaded an fs-safe native binding");
  }
} finally {
  await fsPromises.rm(temporaryRoot, { recursive: true, force: true });
}
