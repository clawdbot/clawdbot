import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { TSDOWN_UNIFIED_CONFIG_GROUP } from "../../scripts/lib/tsdown-config-groups.mts";
import buildConfigs from "../../tsdown.config.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const builds = useAutoCleanupTempDirTracker(afterAll);
const fixtures = useAutoCleanupTempDirTracker(afterEach);
const helper = path.resolve("scripts/verify-mac-node-worker-fs.mjs");
const dependency = path.dirname(
  createRequire(import.meta.url).resolve("@openclaw/fs-safe/package.json"),
);

// This verifier consumes Mach-O Mac worker payloads; exercise both Mac slices
// with their selected Node executables in package proof, not simulated platforms.
describe.skipIf(process.platform !== "darwin")("Mac worker bundled filesystem proof", () => {
  let compiled: string;
  beforeAll(async () => {
    compiled = builds.make("openclaw-worker-fs-build-");
    const selected = buildConfigs.find((config) => config.name === TSDOWN_UNIFIED_CONFIG_GROUP);
    expect(selected).toBeDefined();
    const bundles = await build({
      ...selected,
      config: false,
      entry: {
        "plugin-sdk/memory-core-host-engine-fs": "src/plugin-sdk/memory-core-host-engine-fs.ts",
        // A second real entry keeps the shared loader at the package's dist root,
        // as in the production unified graph. No replacement SDK facade.
        "fs-safe": "src/infra/fs-safe.ts",
      },
      outDir: path.join(compiled, "dist"),
      dts: false,
      logLevel: "silent",
    });
    for (const bundle of bundles) {
      await bundle[Symbol.asyncDispose]();
    }
    // Seed genuine assets even before the producer repair lands; negative fixtures
    // must remove them explicitly rather than depend on today's build omission.
    fs.cpSync(path.join(dependency, "dist/native"), path.join(compiled, "dist/native"), {
      recursive: true,
    });
    fs.writeFileSync(path.join(compiled, "package.json"), '{"type":"module"}');
  });

  function fixture() {
    const directory = fixtures.make("openclaw-worker-fs-proof-");
    const runtime = path.join(directory, "runtime");
    const packageRoot = path.join(runtime, "lib/node_modules/openclaw");
    fs.cpSync(compiled, packageRoot, { recursive: true });
    fs.rmSync(path.join(packageRoot, "dist/native"), { recursive: true });
    const home = path.join(directory, "home");
    fs.mkdirSync(home);
    const dependencyRoot = path.join(packageRoot, "node_modules/@openclaw/fs-safe");
    fs.cpSync(dependency, dependencyRoot, { recursive: true });
    const target = `${process.platform}-${process.arch}/fs-safe-native.node`;
    return {
      runtime,
      packageRoot,
      home,
      native: path.join(packageRoot, "dist/native", target),
      dependencyNative: path.join(dependencyRoot, "dist/native", target),
    };
  }

  function probe(packageRoot: string, home: string, args = [helper, packageRoot, home]) {
    const result = spawnSync(process.execPath, args, {
      cwd: home,
      env: { HOME: home, TMPDIR: home, FS_SAFE_NATIVE_MODE: "require" },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    return result;
  }

  it("rejects an omitted OpenClaw native path even when direct dependency hashing succeeds", () => {
    const { runtime, packageRoot, home, native, dependencyNative } = fixture();
    const direct = probe(packageRoot, home, [
      "--input-type=module",
      "--eval",
      `
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const require = createRequire(process.argv[1] + "/package.json");
const { sha256File } = await import(pathToFileURL(require.resolve("@openclaw/fs-safe/durability")));
fs.writeFileSync("direct-proof", "direct dependency");
assert.deepEqual(await sha256File("direct-proof"), {
  bytes: 17, digest: createHash("sha256").update("direct dependency").digest("hex"),
});
console.log(JSON.stringify(Object.keys(require.cache).filter(file => file.endsWith("fs-safe-native.node"))));
`,
      packageRoot,
    ]);
    expect(direct.status, direct.stderr).toBe(0);
    expect(JSON.parse(direct.stdout)).toEqual([dependencyNative]);
    expect(fs.existsSync(native)).toBe(false);

    const result = probe(packageRoot, home);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("helper-unavailable");
    expect(result.stderr).toContain("MODULE_NOT_FOUND");
    expect(result.stderr).toContain(native);

    const node = path.join(runtime, "bin/node");
    fs.mkdirSync(path.dirname(node));
    fs.copyFileSync(process.execPath, node, fs.constants.COPYFILE_FICLONE);
    // Shared Homebrew Node needs its adjacent libnode at the relocated rpath;
    // official static Node distributions have no matching library to copy.
    for (const library of fs.globSync(path.resolve(process.execPath, "../../lib/libnode*.dylib"))) {
      fs.copyFileSync(
        library,
        path.join(runtime, "lib", path.basename(library)),
        fs.constants.COPYFILE_FICLONE,
      );
    }
    const buildInfo = path.join(home, "expected-build-info.json");
    const info = JSON.stringify({
      version: "fixture",
      commit: "fixture",
      builtAt: "2026-08-28T00:00:00.000Z",
      buildId: "fixture",
    });
    fs.writeFileSync(buildInfo, info);
    fs.writeFileSync(path.join(packageRoot, "dist/build-info.json"), info);
    // Host Node may link external dylibs. Isolate that audit at its owner boundary,
    // not its otool framing. The actual SDK subprocess inherits no loader hooks.
    const portabilityUrl = pathToFileURL(
      path.resolve("scripts/lib/mac-worker-portability.mjs"),
    ).href;
    const preloader = path.join(home, "portability.mjs");
    fs.writeFileSync(
      preloader,
      `import { registerHooks } from "node:module";
const target = ${JSON.stringify(portabilityUrl)};
const stub = "data:text/javascript," + encodeURIComponent("export function auditMacWorkerPortability() { return 0; }");
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    return resolved.url === target ? { url: stub, shortCircuit: true } : resolved;
  },
});
`,
    );
    const verifier = spawnSync(
      node,
      [
        "--import",
        pathToFileURL(preloader).href,
        path.resolve("scripts/verify-mac-node-worker.mjs"),
        runtime,
        buildInfo,
      ],
      { cwd: home, env: { HOME: home, TMPDIR: home }, encoding: "utf8", timeout: 30_000 },
    );
    expect(verifier.error).toBeUndefined();
    expect(verifier.status, verifier.stderr).toBe(1);
    expect(verifier.stderr).toContain(`Cannot find module '${native}'`);
    expect(verifier.stderr).toContain("helper-unavailable");
    expect(verifier.stderr).toContain("MODULE_NOT_FOUND");
  });

  it("accepts completed SDK write/create bytes and exactly the bundled native cache path", () => {
    const { packageRoot, home, native } = fixture();
    // Disposable fixture only: the build's native-asset producer is a separate repair.
    fs.cpSync(path.join(dependency, "dist/native"), path.join(packageRoot, "dist/native"), {
      recursive: true,
    });
    const result = probe(packageRoot, home);
    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(path.join(home, "native-write-proof"), "utf8")).toBe(
      "bundled worker write proof\n",
    );
    expect(fs.readFileSync(path.join(home, "native-create-proof"), "utf8")).toBe(
      "bundled worker create proof\n",
    );
    expect(JSON.parse(result.stdout)).toEqual({
      architecture: process.arch,
      nativeModule: native,
      writeBytes: 27,
      createBytes: 28,
    });
  });

  it.each(["dependency", "wrong-target"])("rejects a native cache path from %s", (location) => {
    const { packageRoot, home, native, dependencyNative } = fixture();
    let misplaced = dependencyNative;
    if (location === "wrong-target") {
      misplaced = path.join(packageRoot, "dist/native/wrong-target/fs-safe-native.node");
      fs.mkdirSync(path.dirname(misplaced), { recursive: true });
      fs.copyFileSync(dependencyNative, misplaced);
    }
    fs.mkdirSync(path.dirname(native), { recursive: true });
    fs.symlinkSync(misplaced, native);
    const result = probe(packageRoot, home);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("Bundled fs-safe native module path mismatch");
    expect(result.stderr).toContain(misplaced);
    // The real operations succeeded; only their dependency/wrong-target origin rejects proof.
    expect(fs.readFileSync(path.join(home, "native-write-proof"), "utf8")).toBe(
      "bundled worker write proof\n",
    );
    expect(fs.readFileSync(path.join(home, "native-create-proof"), "utf8")).toBe(
      "bundled worker create proof\n",
    );
  });
});
