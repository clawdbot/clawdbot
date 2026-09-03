/** Tests native module require behavior for plugin runtime loading. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearPluginModuleRequireCache,
  isJavaScriptModulePath,
  tryNativeRequireJavaScriptModule,
} from "./native-module-require.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
type NativeEsmGraphProbe = {
  status: number | null;
  stderr: string;
  stdout: string;
};
let nativeEsmGraphProbe: NativeEsmGraphProbe;

describe("tryNativeRequireJavaScriptModule", () => {
  it("loads native CommonJS modules", () => {
    const dir = tempDirs.make("openclaw-native-require-");
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(modulePath, 'module.exports = { marker: "native" };\n', "utf8");

    const result = tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true });

    expect(result).toEqual({ ok: true, moduleExport: { marker: "native" } });
  });

  it("declines modules that need source-transform fallback", () => {
    const dir = tempDirs.make("openclaw-native-require-");
    const modulePath = path.join(dir, "plugin.mjs");
    fs.writeFileSync(
      modulePath,
      'await Promise.resolve();\nexport const marker = "esm";\n',
      "utf8",
    );

    expect(tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true })).toEqual({
      ok: false,
    });
  });

  it("declines an in-flight ESM require race for source-transform fallback", () => {
    const modulePath = path.join(tempDirs.make("openclaw-native-require-"), "plugin.cjs");
    fs.writeFileSync(modulePath, "module.exports = {};\n", "utf8");
    const error = Object.assign(new Error("ESM is still loading"), {
      code: "ERR_REQUIRE_ESM_RACE_CONDITION",
    });
    type ModuleLoad = (
      request: string,
      parent: NodeJS.Module | undefined,
      isMain: boolean,
    ) => unknown;
    const originalLoad = Reflect.get(Module, "_load") as ModuleLoad;
    Reflect.set(Module, "_load", () => {
      throw error;
    });

    try {
      expect(tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true })).toEqual({
        ok: false,
      });
    } finally {
      Reflect.set(Module, "_load", originalLoad);
    }
  });

  it("declines missing target modules so callers can try source fallback", () => {
    const modulePath = path.join(tempDirs.make("openclaw-native-require-"), "missing.cjs");

    expect(tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true })).toEqual({
      ok: false,
    });
  });

  it("propagates missing dependency errors from existing modules", () => {
    const dir = tempDirs.make("openclaw-native-require-");
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(modulePath, 'require("./missing-dependency.cjs");\n', "utf8");

    expect(() => tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true })).toThrow(
      "missing-dependency.cjs",
    );
  });

  it("declines missing dependency errors when source-transform fallback is available", () => {
    const dir = tempDirs.make("openclaw-native-require-");
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(modulePath, 'require("openclaw/plugin-sdk/core");\n', "utf8");

    expect(
      tryNativeRequireJavaScriptModule(modulePath, {
        allowWindows: true,
        fallbackOnMissingDependency: true,
      }),
    ).toEqual({ ok: false });
  });

  beforeAll(() => {
    const dir = tempDirs.make("openclaw-native-require-");
    const sdkPath = path.join(dir, "sdk.js");
    const modulePath = path.join(dir, "plugin.mjs");
    const probePath = path.join(dir, "probe.mjs");
    const nativeRequireModuleUrl = pathToFileURL(
      path.join(process.cwd(), "src", "plugins", "native-module-require.ts"),
    ).href;
    fs.writeFileSync(
      sdkPath,
      'export const defineChannelMessageAdapter = () => "adapter";\n',
      "utf8",
    );
    fs.writeFileSync(
      modulePath,
      'import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";\nexport const marker = defineChannelMessageAdapter();\n',
      "utf8",
    );
    fs.writeFileSync(
      probePath,
      [
        `import { tryNativeRequireJavaScriptModule } from ${JSON.stringify(nativeRequireModuleUrl)};`,
        `const result = tryNativeRequireJavaScriptModule(${JSON.stringify(modulePath)}, {`,
        "  allowWindows: true,",
        `  aliasMap: { "openclaw/plugin-sdk/channel-outbound": ${JSON.stringify(sdkPath)} },`,
        "});",
        "if (!result.ok) {",
        '  throw new Error("native require declined ESM graph");',
        "}",
        "console.log(result.moduleExport.marker);",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(process.execPath, ["--import", "tsx", probePath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    nativeEsmGraphProbe = {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  });

  it("loads native ESM graphs with temporary SDK aliases", () => {
    expect(nativeEsmGraphProbe.stderr).toBe("");
    expect(nativeEsmGraphProbe.status).toBe(0);
    expect(nativeEsmGraphProbe.stdout.trim()).toBe("adapter");
  });

  it("declines missing dependency errors when the caller can use source transform fallback", () => {
    const dir = tempDirs.make("openclaw-native-require-");
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(modulePath, 'require("./helper.js");\n', "utf8");
    fs.writeFileSync(path.join(dir, "helper.ts"), "export const loaded = true;\n", "utf8");

    expect(
      tryNativeRequireJavaScriptModule(modulePath, {
        allowWindows: true,
        fallbackOnNativeError: true,
      }),
    ).toEqual({ ok: false });
  });

  it("propagates real module evaluation errors instead of falling back", () => {
    const dir = tempDirs.make("openclaw-native-require-");
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(
      modulePath,
      'throw new Error("plugin exploded during native load");\n',
      "utf8",
    );

    expect(() => tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true })).toThrow(
      "plugin exploded during native load",
    );
  });

  it("declines real module evaluation errors when the caller can use source transform fallback", () => {
    const dir = tempDirs.make("openclaw-native-require-");
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(
      modulePath,
      'throw new Error("plugin exploded during native load");\n',
      "utf8",
    );

    expect(
      tryNativeRequireJavaScriptModule(modulePath, {
        allowWindows: true,
        fallbackOnNativeError: true,
      }),
    ).toEqual({ ok: false });
  });

  it("loads and evicts path and file-URL modules through plain Node", async () => {
    const dir = tempDirs.make("openclaw-native-require-");
    const ownerPath = path.join(dir, "native-require.mjs");
    // tsx's CommonJS hook accepts file URLs and masks Node's native contract.
    await build({
      entryPoints: [path.resolve("src/plugins/native-module-require.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: ownerPath,
      logLevel: "silent",
    });
    const modulePath = path.join(dir, "space # percent% plugin.cjs");
    const probePath = path.join(dir, "probe.mjs");
    fs.writeFileSync(
      probePath,
      `import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { clearPluginModuleRequireCache as clear, tryNativeRequireJavaScriptModule as load } from ${JSON.stringify(pathToFileURL(ownerPath).href)};
const modulePath = ${JSON.stringify(modulePath)};
for (const target of [modulePath, pathToFileURL(modulePath).href]) {
  fs.writeFileSync(modulePath, 'module.exports = { marker: "before" };\\n');
  assert.deepEqual(load(target, { allowWindows: true }), { ok: true, moduleExport: { marker: "before" } });
  fs.writeFileSync(modulePath, 'module.exports = { marker: "after" };\\n');
  assert.deepEqual(load(target, { allowWindows: true }), { ok: true, moduleExport: { marker: "before" } });
  clear(target);
  assert.deepEqual(load(target, { allowWindows: true }), { ok: true, moduleExport: { marker: "after" } });
  clear(target);
}
assert.deepEqual(load(pathToFileURL(modulePath + ".missing.cjs").href, { allowWindows: true }), { ok: false });
fs.writeFileSync(modulePath, 'require("./missing-dependency.cjs");\\n');
assert.throws(() => load(pathToFileURL(modulePath).href, { allowWindows: true }), /missing-dependency\\.cjs/);
console.log("native path + file URL load/cache reload; missing target/dependency controls passed");
`,
    );
    const result = spawnSync(process.execPath, [probePath], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: "" },
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(
      "native path + file URL load/cache reload; missing target/dependency controls passed",
    );
  });

  it("retains terminal ESM failures across eviction and alias changes until a new path loads", async () => {
    const dir = tempDirs.make("openclaw-native-failed-generation-");
    const ownerPath = path.join(dir, "native-require.mjs");
    await build({
      entryPoints: [path.resolve("src/plugins/native-module-require.ts")],
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: ownerPath,
      logLevel: "silent",
    });
    const probePath = path.join(dir, "probe.mjs");
    fs.writeFileSync(
      probePath,
      `import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { clearPluginModuleRequireCache as clear, tryNativeRequireJavaScriptModule as load } from ${JSON.stringify(pathToFileURL(ownerPath).href)};
const dir = ${JSON.stringify(dir)};
const brokenPath = path.join(dir, "broken.mjs");
const missingApi = path.join(dir, "missing-api.mjs");
const currentApi = path.join(dir, "current-api.mjs");
fs.writeFileSync(missingApi, "export const existing = 1;\\n");
fs.writeFileSync(currentApi, "export const required = 2;\\n");
const pluginSource = 'import { required } from "fixture-api"; export const value = required;\\n';
fs.writeFileSync(brokenPath, pluginSource);
const aliasDir = path.join(dir, "alias");
fs.symlinkSync(dir, aliasDir, process.platform === "win32" ? "junction" : "dir");
const options = { allowWindows: true, aliasMap: { "fixture-api": missingApi } };
let initial;
assert.throws(() => load(brokenPath, options), error => {
  initial = error;
  return error instanceof SyntaxError;
});
for (const target of [brokenPath, pathToFileURL(brokenPath).href, "./broken.mjs", path.join(aliasDir, "broken.mjs")]) {
  clear(brokenPath, { dependencyRoot: dir });
  assert.throws(() => load(target, {
    ...options,
    aliasMap: { "fixture-api": currentApi },
    fallbackOnNativeError: true,
  }), error => error === initial);
}
const newPath = path.join(dir, "new-generation.mjs");
fs.writeFileSync(newPath, pluginSource);
const repaired = load(newPath, { ...options, aliasMap: { "fixture-api": currentApi } });
assert.equal(repaired.ok, true);
assert.equal(repaired.moduleExport.value, 2);
const retryPath = path.join(dir, "retry.cjs");
fs.writeFileSync(retryPath, 'if (!globalThis.__pluginDependencyReady) throw new Error("dependency not ready"); module.exports = { ready: true };\\n');
assert.throws(() => load(retryPath, { allowWindows: true }), /dependency not ready/);
globalThis.__pluginDependencyReady = true;
const retried = load(path.join(aliasDir, "retry.cjs"), { allowWindows: true });
assert.equal(retried.ok, true);
assert.equal(retried.moduleExport.ready, true);
delete globalThis.__pluginDependencyReady;
clear(retryPath);
fs.writeFileSync(retryPath, 'throw Object.assign(new Error("fresh race"), { code: "ERR_REQUIRE_ESM_RACE_CONDITION" });\\n');
assert.deepEqual(load(retryPath, { allowWindows: true }), { ok: false });
const aliasRequest = path.join(dir, "alias-request.cjs");
const aliasFirst = path.join(dir, "alias-first.cjs");
const aliasSecond = path.join(dir, "alias-second.cjs");
fs.writeFileSync(aliasFirst, 'module.exports = "first";\\n');
fs.writeFileSync(aliasSecond, 'module.exports = "second";\\n');
assert.deepEqual(load(aliasRequest, {
  allowWindows: true,
  aliasMap: { [aliasRequest]: aliasFirst, [aliasFirst]: aliasSecond },
}), { ok: true, moduleExport: "first" });
console.log("terminal error retained; new generation recovered");
`,
    );
    // tsx changes named-import linking, so this contract needs an unhooked Node process.
    const result = spawnSync(process.execPath, [probePath], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: "" },
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("terminal error retained; new generation recovered");
  });

  it("clears local dependencies loaded by a native JavaScript module", () => {
    const dir = tempDirs.make("openclaw-native-require-");
    const modulePath = path.join(dir, "plugin.cjs");
    const helperPath = path.join(dir, "helper.cjs");
    fs.writeFileSync(modulePath, 'module.exports = require("./helper.cjs");\n', "utf8");
    fs.writeFileSync(helperPath, 'module.exports = { marker: "before" };\n', "utf8");
    expect(tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true })).toEqual({
      ok: true,
      moduleExport: { marker: "before" },
    });

    fs.writeFileSync(helperPath, 'module.exports = { marker: "after" };\n', "utf8");
    clearPluginModuleRequireCache(modulePath, { dependencyRoot: dir });

    expect(tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true })).toEqual({
      ok: true,
      moduleExport: { marker: "after" },
    });
  });

  it("releases retired native module graphs, including local cycles", () => {
    const dir = tempDirs.make("openclaw-native-retirement-");
    const modulePath = path.join(dir, "plugin.cjs");
    const probePath = path.join(dir, "probe.mjs");
    fs.writeFileSync(modulePath, 'exports.helper = require("./helper.cjs");\n');
    fs.writeFileSync(path.join(dir, "helper.cjs"), 'exports.entry = require("./plugin.cjs");\n');
    const ownerUrl = pathToFileURL(path.resolve("src/plugins/native-module-require.ts")).href;
    fs.writeFileSync(
      probePath,
      `import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { clearPluginModuleRequireCache, tryNativeRequireJavaScriptModule } from ${JSON.stringify(ownerUrl)};
const modulePath = ${JSON.stringify(modulePath)};
function loadAndRetire() {
  const result = tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true });
  assert.equal(result.ok, true);
  assert.equal(result.moduleExport.helper.entry, result.moduleExport);
  const ref = new WeakRef(result.moduleExport);
  clearPluginModuleRequireCache(modulePath);
  return ref;
}
const retired = Array.from({ length: 12 }, loadAndRetire);
await setImmediate();
for (let index = 0; index < 5; index++) {
  global.gc();
  await setImmediate();
}
assert.equal(retired.filter(ref => ref.deref() !== undefined).length, 0);
`,
    );
    const result = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", probePath], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 30_000,
    });

    expect(result.status, result.stderr).toBe(0);
  });
});

describe("isJavaScriptModulePath", () => {
  it("only accepts JavaScript runtime extensions", () => {
    expect(isJavaScriptModulePath("/plugin/index.js")).toBe(true);
    expect(isJavaScriptModulePath("/plugin/index.mjs")).toBe(true);
    expect(isJavaScriptModulePath("/plugin/index.cjs")).toBe(true);
    expect(isJavaScriptModulePath("/plugin/index.ts")).toBe(false);
  });
});
