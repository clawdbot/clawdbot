import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installOpenClawPluginSdkNativeResolver,
  resetOpenClawPluginSdkNativeResolverForTest,
} from "./plugin-sdk-native-resolver.js";

afterEach(() => {
  resetOpenClawPluginSdkNativeResolverForTest();
});

function writeJsonFile(targetPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeFakeOpenClawPackage(root: string): { distRoot: string; loaderModulePath: string } {
  writeJsonFile(path.join(root, "package.json"), {
    name: "openclaw",
    type: "module",
    bin: {
      openclaw: "./openclaw.mjs",
    },
    exports: {
      "./cli-entry": "./dist/cli-entry.js",
      "./plugin-sdk": "./dist/plugin-sdk/root-alias.cjs",
      "./plugin-sdk/channel-message": "./dist/plugin-sdk/channel-message.js",
      "./plugin-sdk/source-only": "./dist/plugin-sdk/source-only.js",
    },
  });
  fs.writeFileSync(path.join(root, "openclaw.mjs"), "#!/usr/bin/env node\n", "utf8");
  const distRoot = path.join(root, "dist");
  const pluginSdkDir = path.join(distRoot, "plugin-sdk");
  fs.mkdirSync(pluginSdkDir, { recursive: true });
  fs.writeFileSync(path.join(pluginSdkDir, "root-alias.cjs"), "module.exports = {};\n", "utf8");
  fs.writeFileSync(
    path.join(pluginSdkDir, "channel-message.js"),
    ['export const defineChannelMessageAdapter = () => "adapter";', ""].join("\n"),
    "utf8",
  );
  const loaderModulePath = path.join(distRoot, "plugins", "loader.js");
  fs.mkdirSync(path.dirname(loaderModulePath), { recursive: true });
  fs.writeFileSync(loaderModulePath, "export default {};\n", "utf8");
  return { distRoot, loaderModulePath };
}

function writeExternalPluginEntry(root: string): string {
  writeJsonFile(path.join(root, "package.json"), {
    name: "external-plugin",
    type: "module",
  });
  const entry = path.join(root, "dist", "runtime-api.js");
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, "export default {};\n", "utf8");
  return entry;
}

describe("installOpenClawPluginSdkNativeResolver", () => {
  it("keeps native aliases on JS dist artifacts when source files exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-source-resolver-"));
    const { loaderModulePath } = writeFakeOpenClawPackage(root);
    const sourceChannelMessagePath = path.join(root, "src", "plugin-sdk", "channel-message.ts");
    fs.mkdirSync(path.dirname(sourceChannelMessagePath), { recursive: true });
    fs.writeFileSync(sourceChannelMessagePath, "export const sourceOnly = true;\n", "utf8");
    const externalPluginEntry = writeExternalPluginEntry(path.join(root, "external-plugin"));

    const installedAliases = installOpenClawPluginSdkNativeResolver({
      modulePath: loaderModulePath,
      pluginModulePath: externalPluginEntry,
      pluginSdkResolution: "src",
    });

    expect(installedAliases).toContain("openclaw/plugin-sdk/channel-message");
    const requireFromPlugin = createRequire(externalPluginEntry);
    expect(fs.realpathSync(requireFromPlugin.resolve("openclaw/plugin-sdk/channel-message"))).toBe(
      fs.realpathSync(path.join(root, "dist", "plugin-sdk", "channel-message.js")),
    );
  });

  it("lets built external plugins resolve OpenClaw SDK subpaths with createRequire", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-resolver-"));
    const { distRoot, loaderModulePath } = writeFakeOpenClawPackage(root);
    const externalPluginEntry = writeExternalPluginEntry(path.join(root, "external-plugin"));

    const distMode = fs.statSync(distRoot).mode;
    if (process.platform !== "win32") {
      fs.chmodSync(distRoot, 0o555);
    }

    try {
      const installedAliases = installOpenClawPluginSdkNativeResolver({
        modulePath: loaderModulePath,
        pluginModulePath: externalPluginEntry,
        pluginSdkResolution: "dist",
      });

      expect(installedAliases).toContain("openclaw/plugin-sdk/channel-message");
      expect(fs.existsSync(path.join(distRoot, "extensions"))).toBe(false);
      const requireFromPlugin = createRequire(externalPluginEntry);
      expect(
        fs.realpathSync(requireFromPlugin.resolve("openclaw/plugin-sdk/channel-message")),
      ).toBe(fs.realpathSync(path.join(root, "dist", "plugin-sdk", "channel-message.js")));
      const sdk = requireFromPlugin("openclaw/plugin-sdk/channel-message") as {
        defineChannelMessageAdapter?: () => string;
      };

      expect(sdk.defineChannelMessageAdapter?.()).toBe("adapter");
      expect(() => requireFromPlugin.resolve("openclaw/not-plugin-sdk/channel-message")).toThrow();
    } finally {
      if (process.platform !== "win32") {
        fs.chmodSync(distRoot, distMode);
      }
    }
  });

  it("does not resolve SDK aliases for parents outside registered plugin roots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-guard-"));
    const { loaderModulePath } = writeFakeOpenClawPackage(root);
    const externalPluginEntry = writeExternalPluginEntry(path.join(root, "external-plugin"));
    const unrelatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-outside-"));
    const unrelatedEntry = path.join(unrelatedRoot, "runtime-api.js");
    fs.mkdirSync(path.dirname(unrelatedEntry), { recursive: true });
    fs.writeFileSync(unrelatedEntry, "export default {};\n", "utf8");

    installOpenClawPluginSdkNativeResolver({
      modulePath: loaderModulePath,
      pluginModulePath: externalPluginEntry,
      pluginSdkResolution: "dist",
    });

    const requireFromPlugin = createRequire(externalPluginEntry);
    const requireFromOutside = createRequire(unrelatedEntry);
    expect(requireFromPlugin.resolve("openclaw/plugin-sdk/channel-message")).toBeTruthy();
    expect(() => requireFromOutside.resolve("openclaw/plugin-sdk/channel-message")).toThrow();
  });

  it("does not register source-only SDK subpaths for native resolution", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-source-only-"));
    const { loaderModulePath } = writeFakeOpenClawPackage(root);
    const sourceOnlyPath = path.join(root, "src", "plugin-sdk", "source-only.ts");
    fs.mkdirSync(path.dirname(sourceOnlyPath), { recursive: true });
    fs.writeFileSync(sourceOnlyPath, "export const sourceOnly = true;\n", "utf8");
    const externalPluginEntry = writeExternalPluginEntry(path.join(root, "external-plugin"));

    const installedAliases = installOpenClawPluginSdkNativeResolver({
      modulePath: loaderModulePath,
      pluginModulePath: externalPluginEntry,
      pluginSdkResolution: "src",
    });

    expect(installedAliases).toContain("openclaw/plugin-sdk/channel-message");
    expect(installedAliases).not.toContain("openclaw/plugin-sdk/source-only");
    const requireFromPlugin = createRequire(externalPluginEntry);
    expect(() => requireFromPlugin.resolve("openclaw/plugin-sdk/source-only")).toThrow();
  });
});
