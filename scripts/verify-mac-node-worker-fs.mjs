#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [packageArg, home] = process.argv.slice(2);
if (!packageArg || !home) {
  throw new Error("Usage: verify-mac-node-worker-fs.mjs <package-root> <proof-home>");
}
assert.equal(process.env.HOME, home);
assert.equal(process.env.TMPDIR, home);
assert.equal(process.env.FS_SAFE_NATIVE_MODE, "require");
const packageRoot = fs.realpathSync(packageArg);
const { root } = await import(
  pathToFileURL(path.join(packageRoot, "dist/plugin-sdk/memory-core-host-engine-fs.js")).href
);
const scoped = await root(home);
const written = "bundled worker write proof\n";
const created = "bundled worker create proof\n";
fs.writeFileSync(path.join(home, "native-write-proof"), "before replacement\n");
await scoped.write("native-write-proof", written);
await scoped.create("native-create-proof", created);
assert.deepEqual(fs.readFileSync(path.join(home, "native-write-proof")), Buffer.from(written));
assert.deepEqual(fs.readFileSync(path.join(home, "native-create-proof")), Buffer.from(created));

// Resolve from fs-safe's dependency scope, including pnpm's nested install layout.
const requireFromPackage = createRequire(path.join(packageRoot, "package.json"));
const requireFromFsSafe = createRequire(
  requireFromPackage.resolve("@openclaw/fs-safe/package.json"),
);
const nativeModule = requireFromFsSafe.resolve(
  `@openclaw/fs-safe-${process.platform}-${process.arch}`,
);
assert(
  nativeModule.startsWith(packageRoot + path.sep),
  "fs-safe native package is outside the worker payload",
);
const loaded = Object.keys(createRequire(import.meta.url).cache).filter(
  (file) => path.basename(file) === "fs-safe-native.node",
);
assert.deepEqual(loaded, [nativeModule], "Installed fs-safe native module path mismatch");
console.log(
  JSON.stringify({
    architecture: process.arch,
    nativeModule,
    writeBytes: Buffer.byteLength(written),
    createBytes: Buffer.byteLength(created),
  }),
);
