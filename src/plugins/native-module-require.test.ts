/** Tests native module require behavior for plugin runtime loading. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clearNativeRequireJavaScriptModuleCache,
  isJavaScriptModulePath,
  tryNativeRequireJavaScriptModule,
} from "./native-module-require.js";

const tempDirs: string[] = [];
type NativeEsmGraphProbe = {
  status: number | null;
  stderr: string;
  stdout: string;
};
let nativeEsmGraphProbe: NativeEsmGraphProbe;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-native-require-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("tryNativeRequireJavaScriptModule", () => {
  it("loads native CommonJS modules", () => {
    const dir = makeTempDir();
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(modulePath, 'module.exports = { marker: "native" };\n', "utf8");

    const result = tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true });

    expect(result).toEqual({ ok: true, moduleExport: { marker: "native" } });
  });

  it("declines modules that need source-transform fallback", () => {
    const dir = makeTempDir();
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

  it("declines missing target modules so callers can try source fallback", () => {
    const modulePath = path.join(makeTempDir(), "missing.cjs");

    expect(tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true })).toEqual({
      ok: false,
    });
  });

  it("propagates missing dependency errors from existing modules", () => {
    const dir = makeTempDir();
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(modulePath, 'require("./missing-dependency.cjs");\n', "utf8");

    expect(() => tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true })).toThrow(
      "missing-dependency.cjs",
    );
  });

  it("declines missing dependency errors when source-transform fallback is available", () => {
    const dir = makeTempDir();
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(modulePath, 'require("openclaw/plugin-sdk");\n', "utf8");

    expect(
      tryNativeRequireJavaScriptModule(modulePath, {
        allowWindows: true,
        fallbackOnMissingDependency: true,
      }),
    ).toEqual({ ok: false });
  });

  beforeAll(() => {
    const dir = makeTempDir();
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
    const dir = makeTempDir();
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
    const dir = makeTempDir();
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
    const dir = makeTempDir();
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

  it("clears loaded JavaScript modules from the native require cache", () => {
    const dir = makeTempDir();
    const modulePath = path.join(dir, "plugin.cjs");
    fs.writeFileSync(modulePath, 'module.exports = { marker: "before" };\n', "utf8");
    expect(tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true })).toEqual({
      ok: true,
      moduleExport: { marker: "before" },
    });

    fs.writeFileSync(modulePath, 'module.exports = { marker: "after" };\n', "utf8");
    clearNativeRequireJavaScriptModuleCache(modulePath);

    expect(tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true })).toEqual({
      ok: true,
      moduleExport: { marker: "after" },
    });
  });

  it("clears local dependencies loaded by a native JavaScript module", () => {
    const dir = makeTempDir();
    const modulePath = path.join(dir, "plugin.cjs");
    const helperPath = path.join(dir, "helper.cjs");
    fs.writeFileSync(modulePath, 'module.exports = require("./helper.cjs");\n', "utf8");
    fs.writeFileSync(helperPath, 'module.exports = { marker: "before" };\n', "utf8");
    expect(tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true })).toEqual({
      ok: true,
      moduleExport: { marker: "before" },
    });

    fs.writeFileSync(helperPath, 'module.exports = { marker: "after" };\n', "utf8");
    clearNativeRequireJavaScriptModuleCache(modulePath, { dependencyRoot: dir });

    expect(tryNativeRequireJavaScriptModule(modulePath, { allowWindows: true })).toEqual({
      ok: true,
      moduleExport: { marker: "after" },
    });
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
