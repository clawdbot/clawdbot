import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  installOpenClawPluginSdkNativeResolver,
  resetOpenClawPluginSdkNativeResolverForTest,
} from "./plugin-sdk-native-resolver.js";

afterEach(() => {
  resetOpenClawPluginSdkNativeResolverForTest();
});

type NativeEsmLazyImportProbe = {
  status: number | null;
  stderr: string;
  stdout: string;
};
let nativeEsmLazyImportProbe: NativeEsmLazyImportProbe;

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
      "./plugin-sdk/agent-runtime": "./dist/plugin-sdk/agent-runtime.js",
      "./plugin-sdk/channel-message": "./dist/plugin-sdk/channel-message.js",
      "./plugin-sdk/channel-outbound": "./dist/plugin-sdk/channel-outbound.js",
      "./plugin-sdk/source-only": "./dist/plugin-sdk/source-only.js",
    },
  });
  fs.writeFileSync(path.join(root, "openclaw.mjs"), "#!/usr/bin/env node\n", "utf8");
  const distRoot = path.join(root, "dist");
  const pluginSdkDir = path.join(distRoot, "plugin-sdk");
  fs.mkdirSync(pluginSdkDir, { recursive: true });
  fs.writeFileSync(path.join(pluginSdkDir, "root-alias.cjs"), "module.exports = {};\n", "utf8");
  fs.writeFileSync(
    path.join(pluginSdkDir, "agent-runtime.js"),
    "export const agentRuntimeSource = import.meta.url;\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginSdkDir, "channel-message.js"),
    ['export * from "./channel-outbound.js";', ""].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginSdkDir, "channel-outbound.js"),
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

function writeNormalizationCoreSource(root: string): string {
  const sourcePath = path.join(root, "packages", "normalization-core", "src", "string-coerce.ts");
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, "export const normalizeOptionalString = () => undefined;\n", "utf8");
  return sourcePath;
}

function addFakePluginSdkDistExport(root: string, subpath: string): string {
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    exports: Record<string, string>;
  };
  const distPath = path.join(root, "dist", "plugin-sdk", `${subpath}.js`);
  packageJson.exports[`./plugin-sdk/${subpath}`] = `./dist/plugin-sdk/${subpath}.js`;
  writeJsonFile(packageJsonPath, packageJson);
  fs.writeFileSync(distPath, `export const ${subpath.replaceAll("-", "_")} = true;\n`, "utf8");
  return distPath;
}

describe("installOpenClawPluginSdkNativeResolver", () => {
  it("resolves installed plugin SDK imports to the dev source root", () => {
    const stableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-stable-"));
    const devRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-dev-source-"));
    const { loaderModulePath } = writeFakeOpenClawPackage(stableRoot);
    writeFakeOpenClawPackage(devRoot);
    fs.mkdirSync(path.join(devRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(devRoot, "extensions"), { recursive: true });
    const externalPluginEntry = writeExternalPluginEntry(path.join(stableRoot, "external-plugin"));
    const previousDevSourceRoot = process.env.OPENCLAW_DEV_SOURCE_ROOT;
    process.env.OPENCLAW_DEV_SOURCE_ROOT = devRoot;

    try {
      const installedAliases = installOpenClawPluginSdkNativeResolver({
        modulePath: loaderModulePath,
        pluginModulePath: externalPluginEntry,
      });

      expect(installedAliases).toContain("openclaw/plugin-sdk/agent-runtime");
      const requireFromPlugin = createRequire(externalPluginEntry);
      expect(fs.realpathSync(requireFromPlugin.resolve("openclaw/plugin-sdk/agent-runtime"))).toBe(
        fs.realpathSync(path.join(devRoot, "dist", "plugin-sdk", "agent-runtime.js")),
      );
    } finally {
      if (previousDevSourceRoot === undefined) {
        delete process.env.OPENCLAW_DEV_SOURCE_ROOT;
      } else {
        process.env.OPENCLAW_DEV_SOURCE_ROOT = previousDevSourceRoot;
      }
    }
  });

  it("resolves installed plugin SDK imports to an explicit dev source root", () => {
    const stableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-stable-"));
    const devRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-dev-source-"));
    const { loaderModulePath } = writeFakeOpenClawPackage(stableRoot);
    writeFakeOpenClawPackage(devRoot);
    fs.mkdirSync(path.join(devRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(devRoot, "extensions"), { recursive: true });
    const externalPluginEntry = writeExternalPluginEntry(path.join(stableRoot, "external-plugin"));

    const installedAliases = installOpenClawPluginSdkNativeResolver({
      modulePath: loaderModulePath,
      pluginModulePath: externalPluginEntry,
      devSourceRoot: devRoot,
    });

    expect(installedAliases).toContain("openclaw/plugin-sdk/agent-runtime");
    const requireFromPlugin = createRequire(externalPluginEntry);
    expect(fs.realpathSync(requireFromPlugin.resolve("openclaw/plugin-sdk/agent-runtime"))).toBe(
      fs.realpathSync(path.join(devRoot, "dist", "plugin-sdk", "agent-runtime.js")),
    );
  });

  it("updates native SDK aliases when the same plugin parent switches dev source roots", () => {
    const stableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-stable-"));
    const devRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-dev-source-"));
    const { loaderModulePath } = writeFakeOpenClawPackage(stableRoot);
    writeFakeOpenClawPackage(devRoot);
    fs.mkdirSync(path.join(devRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(devRoot, "extensions"), { recursive: true });
    const externalPluginEntry = writeExternalPluginEntry(path.join(stableRoot, "external-plugin"));
    const requireFromPlugin = createRequire(externalPluginEntry);

    installOpenClawPluginSdkNativeResolver({
      modulePath: loaderModulePath,
      pluginModulePath: externalPluginEntry,
    });
    expect(fs.realpathSync(requireFromPlugin.resolve("openclaw/plugin-sdk/agent-runtime"))).toBe(
      fs.realpathSync(path.join(stableRoot, "dist", "plugin-sdk", "agent-runtime.js")),
    );

    installOpenClawPluginSdkNativeResolver({
      modulePath: loaderModulePath,
      pluginModulePath: externalPluginEntry,
      devSourceRoot: devRoot,
    });

    expect(fs.realpathSync(requireFromPlugin.resolve("openclaw/plugin-sdk/agent-runtime"))).toBe(
      fs.realpathSync(path.join(devRoot, "dist", "plugin-sdk", "agent-runtime.js")),
    );
  });

  it("removes stale native SDK aliases when a later dev root omits a subpath", () => {
    const stableRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-stable-"));
    const devRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-dev-source-"));
    const { loaderModulePath } = writeFakeOpenClawPackage(stableRoot);
    writeFakeOpenClawPackage(devRoot);
    const stableExtraPath = addFakePluginSdkDistExport(stableRoot, "stable-extra");
    fs.mkdirSync(path.join(devRoot, "src"), { recursive: true });
    fs.mkdirSync(path.join(devRoot, "extensions"), { recursive: true });
    const externalPluginEntry = writeExternalPluginEntry(path.join(stableRoot, "external-plugin"));
    const requireFromPlugin = createRequire(externalPluginEntry);

    installOpenClawPluginSdkNativeResolver({
      modulePath: loaderModulePath,
      pluginModulePath: externalPluginEntry,
    });
    expect(fs.realpathSync(requireFromPlugin.resolve("openclaw/plugin-sdk/stable-extra"))).toBe(
      fs.realpathSync(stableExtraPath),
    );

    installOpenClawPluginSdkNativeResolver({
      modulePath: loaderModulePath,
      pluginModulePath: externalPluginEntry,
      devSourceRoot: devRoot,
    });

    expect(() => requireFromPlugin.resolve("openclaw/plugin-sdk/stable-extra")).toThrow();
  });

  it("keeps native aliases on JS dist artifacts when source files exist", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-source-resolver-"));
    const { loaderModulePath } = writeFakeOpenClawPackage(root);
    const sourceChannelOutboundPath = path.join(root, "src", "plugin-sdk", "channel-outbound.ts");
    fs.mkdirSync(path.dirname(sourceChannelOutboundPath), { recursive: true });
    fs.writeFileSync(sourceChannelOutboundPath, "export const sourceOnly = true;\n", "utf8");
    const externalPluginEntry = writeExternalPluginEntry(path.join(root, "external-plugin"));

    const installedAliases = installOpenClawPluginSdkNativeResolver({
      modulePath: loaderModulePath,
      pluginModulePath: externalPluginEntry,
      pluginSdkResolution: "src",
    });

    expect(installedAliases).toContain("openclaw/plugin-sdk/channel-outbound");
    const requireFromPlugin = createRequire(externalPluginEntry);
    expect(fs.realpathSync(requireFromPlugin.resolve("openclaw/plugin-sdk/channel-outbound"))).toBe(
      fs.realpathSync(path.join(root, "dist", "plugin-sdk", "channel-outbound.js")),
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

      expect(installedAliases).toContain("openclaw/plugin-sdk/channel-outbound");
      expect(fs.existsSync(path.join(distRoot, "extensions"))).toBe(false);
      const requireFromPlugin = createRequire(externalPluginEntry);
      expect(
        fs.realpathSync(requireFromPlugin.resolve("openclaw/plugin-sdk/channel-outbound")),
      ).toBe(fs.realpathSync(path.join(root, "dist", "plugin-sdk", "channel-outbound.js")));
      const sdk = requireFromPlugin("openclaw/plugin-sdk/channel-outbound") as {
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

  beforeAll(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-esm-resolver-"));
    const probePath = path.join(root, "probe.mjs");
    const resolverModuleUrl = pathToFileURL(
      path.join(process.cwd(), "src", "plugins", "plugin-sdk-native-resolver.ts"),
    ).href;
    fs.writeFileSync(
      probePath,
      [
        'import fs from "node:fs";',
        'import path from "node:path";',
        'import { pathToFileURL } from "node:url";',
        `import { installOpenClawPluginSdkNativeResolver, resetOpenClawPluginSdkNativeResolverForTest } from ${JSON.stringify(resolverModuleUrl)};`,
        `const root = ${JSON.stringify(root)};`,
        "const writeJson = (targetPath, value) => {",
        "  fs.mkdirSync(path.dirname(targetPath), { recursive: true });",
        '  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\\n`, "utf8");',
        "};",
        'writeJson(path.join(root, "package.json"), {',
        '  name: "openclaw",',
        '  type: "module",',
        '  bin: { openclaw: "./openclaw.mjs" },',
        "  exports: {",
        '    "./plugin-sdk": "./dist/plugin-sdk/root-alias.cjs",',
        '    "./plugin-sdk/channel-outbound": "./dist/plugin-sdk/channel-outbound.js",',
        "  },",
        "});",
        'fs.writeFileSync(path.join(root, "openclaw.mjs"), "#!/usr/bin/env node\\n", "utf8");',
        'fs.mkdirSync(path.join(root, "dist", "plugin-sdk"), { recursive: true });',
        'fs.writeFileSync(path.join(root, "dist", "plugin-sdk", "root-alias.cjs"), "module.exports = {};\\n", "utf8");',
        'fs.writeFileSync(path.join(root, "dist", "plugin-sdk", "channel-outbound.js"), "export const defineChannelMessageAdapter = () => \\"adapter\\";\\n", "utf8");',
        'const loaderModulePath = path.join(root, "dist", "plugins", "loader.js");',
        "fs.mkdirSync(path.dirname(loaderModulePath), { recursive: true });",
        'fs.writeFileSync(loaderModulePath, "export default {};\\n", "utf8");',
        'const pluginRoot = path.join(root, "external-plugin");',
        'writeJson(path.join(pluginRoot, "package.json"), { name: "external-plugin", type: "module" });',
        'const entryPath = path.join(pluginRoot, "dist", "runtime-api.js");',
        'const lazyPath = path.join(pluginRoot, "dist", "lazy.js");',
        "fs.mkdirSync(path.dirname(entryPath), { recursive: true });",
        "fs.writeFileSync(",
        "  entryPath,",
        '  "import { defineChannelMessageAdapter } from \\"openclaw/plugin-sdk/channel-outbound\\"; export const eager = defineChannelMessageAdapter(); export const loadLazy = () => import(\\"./lazy.js\\");\\n",',
        '  "utf8",',
        ");",
        "fs.writeFileSync(",
        "  lazyPath,",
        '  "import { defineChannelMessageAdapter } from \\"openclaw/plugin-sdk/channel-outbound\\"; export const lazy = defineChannelMessageAdapter();\\n",',
        '  "utf8",',
        ");",
        "installOpenClawPluginSdkNativeResolver({",
        "  modulePath: loaderModulePath,",
        "  pluginModulePath: entryPath,",
        '  pluginSdkResolution: "dist",',
        "});",
        "const module = await import(pathToFileURL(entryPath).href);",
        "const lazy = await module.loadLazy();",
        "resetOpenClawPluginSdkNativeResolverForTest();",
        "console.log(`${module.eager}:${lazy.lazy}`);",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync(process.execPath, ["--import", "tsx", probePath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    fs.rmSync(root, { recursive: true, force: true });
    nativeEsmLazyImportProbe = {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  });

  it("keeps SDK aliases available for native ESM lazy imports", () => {
    expect(nativeEsmLazyImportProbe.stderr).toBe("");
    expect(nativeEsmLazyImportProbe.status).toBe(0);
    expect(nativeEsmLazyImportProbe.stdout.trim()).toBe("adapter:adapter");
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
    expect(requireFromPlugin.resolve("openclaw/plugin-sdk/channel-outbound")).toBeTruthy();
    expect(() => requireFromOutside.resolve("openclaw/plugin-sdk/channel-outbound")).toThrow();
  });

  it("resolves internal core packages only for OpenClaw-owned source parents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-core-internal-"));
    const { loaderModulePath } = writeFakeOpenClawPackage(root);
    const normalizationSource = writeNormalizationCoreSource(root);
    const externalPluginEntry = writeExternalPluginEntry(path.join(root, "external-plugin"));
    const coreSourceParent = path.join(root, "src", "config", "plugin-web-search-config.ts");
    fs.mkdirSync(path.dirname(coreSourceParent), { recursive: true });
    fs.writeFileSync(coreSourceParent, "export default {};\n", "utf8");

    const installedAliases = installOpenClawPluginSdkNativeResolver({
      modulePath: loaderModulePath,
      pluginModulePath: externalPluginEntry,
      pluginSdkResolution: "dist",
    });

    expect(installedAliases).toContain("@openclaw/normalization-core/string-coerce");
    const requireFromCoreSource = createRequire(coreSourceParent);
    const requireFromPlugin = createRequire(externalPluginEntry);
    expect(
      fs.realpathSync(requireFromCoreSource.resolve("@openclaw/normalization-core/string-coerce")),
    ).toBe(fs.realpathSync(normalizationSource));
    expect(() => requireFromPlugin.resolve("@openclaw/normalization-core/string-coerce")).toThrow();
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

    expect(installedAliases).toContain("openclaw/plugin-sdk/channel-outbound");
    expect(installedAliases).not.toContain("openclaw/plugin-sdk/source-only");
    const requireFromPlugin = createRequire(externalPluginEntry);
    expect(() => requireFromPlugin.resolve("openclaw/plugin-sdk/source-only")).toThrow();
  });

  it("scopes private SSRF SDK aliases to bundled local IPC native parents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-ssrf-"));
    const { loaderModulePath } = writeFakeOpenClawPackage(root);
    const internalPath = path.join(root, "dist", "plugin-sdk", "ssrf-runtime-internal.js");
    fs.writeFileSync(internalPath, "export const ssrfInternal = true;\n", "utf8");
    const ollamaEntry = path.join(root, "dist", "extensions", "ollama", "index.js");
    const runtimeOllamaEntry = path.join(root, "dist-runtime", "extensions", "ollama", "index.js");
    const browserEntry = path.join(root, "dist", "extensions", "browser", "index.js");
    const runtimeBrowserEntry = path.join(
      root,
      "dist-runtime",
      "extensions",
      "browser",
      "index.js",
    );
    const otherEntry = path.join(root, "dist", "extensions", "demo", "index.js");
    fs.mkdirSync(path.dirname(ollamaEntry), { recursive: true });
    fs.mkdirSync(path.dirname(runtimeOllamaEntry), { recursive: true });
    fs.mkdirSync(path.dirname(browserEntry), { recursive: true });
    fs.mkdirSync(path.dirname(runtimeBrowserEntry), { recursive: true });
    fs.mkdirSync(path.dirname(otherEntry), { recursive: true });
    fs.writeFileSync(ollamaEntry, "export default {};\n", "utf8");
    fs.writeFileSync(runtimeOllamaEntry, "export default {};\n", "utf8");
    fs.writeFileSync(browserEntry, "export default {};\n", "utf8");
    fs.writeFileSync(runtimeBrowserEntry, "export default {};\n", "utf8");
    fs.writeFileSync(otherEntry, "export default {};\n", "utf8");

    const installedAliases = installOpenClawPluginSdkNativeResolver({
      modulePath: loaderModulePath,
      pluginModulePath: ollamaEntry,
      pluginSdkResolution: "dist",
    });
    installOpenClawPluginSdkNativeResolver({
      modulePath: loaderModulePath,
      pluginModulePath: runtimeOllamaEntry,
      pluginSdkResolution: "dist",
    });
    installOpenClawPluginSdkNativeResolver({
      modulePath: loaderModulePath,
      pluginModulePath: browserEntry,
      pluginSdkResolution: "dist",
    });
    installOpenClawPluginSdkNativeResolver({
      modulePath: loaderModulePath,
      pluginModulePath: runtimeBrowserEntry,
      pluginSdkResolution: "dist",
    });
    installOpenClawPluginSdkNativeResolver({
      modulePath: loaderModulePath,
      pluginModulePath: otherEntry,
      pluginSdkResolution: "dist",
    });

    expect(installedAliases).toContain("openclaw/plugin-sdk/ssrf-runtime-internal");
    const requireFromOllama = createRequire(ollamaEntry);
    expect(
      fs.realpathSync(requireFromOllama.resolve("openclaw/plugin-sdk/ssrf-runtime-internal")),
    ).toBe(fs.realpathSync(internalPath));

    const requireFromRuntimeOllama = createRequire(runtimeOllamaEntry);
    expect(
      fs.realpathSync(
        requireFromRuntimeOllama.resolve("openclaw/plugin-sdk/ssrf-runtime-internal"),
      ),
    ).toBe(fs.realpathSync(internalPath));

    const requireFromBrowser = createRequire(browserEntry);
    expect(
      fs.realpathSync(requireFromBrowser.resolve("openclaw/plugin-sdk/ssrf-runtime-internal")),
    ).toBe(fs.realpathSync(internalPath));

    const requireFromRuntimeBrowser = createRequire(runtimeBrowserEntry);
    expect(
      fs.realpathSync(
        requireFromRuntimeBrowser.resolve("openclaw/plugin-sdk/ssrf-runtime-internal"),
      ),
    ).toBe(fs.realpathSync(internalPath));

    const requireFromOther = createRequire(otherEntry);
    expect(() => requireFromOther.resolve("openclaw/plugin-sdk/ssrf-runtime-internal")).toThrow();
  });
});
