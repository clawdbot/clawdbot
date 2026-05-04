import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isJavaScriptModulePath,
  tryNativeRequireJavaScriptModule,
} from "./native-module-require.js";

const tempDirs: string[] = [];

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
});

describe("isJavaScriptModulePath", () => {
  it("only accepts JavaScript runtime extensions", () => {
    expect(isJavaScriptModulePath("/plugin/index.js")).toBe(true);
    expect(isJavaScriptModulePath("/plugin/index.mjs")).toBe(true);
    expect(isJavaScriptModulePath("/plugin/index.cjs")).toBe(true);
    expect(isJavaScriptModulePath("/plugin/index.ts")).toBe(false);
  });
});
