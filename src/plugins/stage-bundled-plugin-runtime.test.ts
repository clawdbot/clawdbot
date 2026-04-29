import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bundledDistPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageBundledPluginRuntime } from "../../scripts/stage-bundled-plugin-runtime.mjs";
import { discoverOpenClawPlugins } from "./discovery.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function makeRepoRoot(prefix: string): string {
  return makeTrackedTempDir(prefix, tempDirs);
}

function createDistPluginDir(repoRoot: string, pluginId: string) {
  const distPluginDir = path.join(repoRoot, "dist", "extensions", pluginId);
  fs.mkdirSync(distPluginDir, { recursive: true });
  return distPluginDir;
}

function writeRepoFile(repoRoot: string, relativePath: string, value: string) {
  const fullPath = path.join(repoRoot, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, value, "utf8");
}

function setupRepoFiles(repoRoot: string, files: Readonly<Record<string, string>>) {
  for (const [relativePath, value] of Object.entries(files)) {
    writeRepoFile(repoRoot, relativePath, value);
  }
}

function distRuntimeImportPath(pluginId: string, relativePath = "index.js"): string {
  return `../../../${bundledDistPluginFile(pluginId, relativePath)}`;
}

function expectRuntimePluginWrapperContains(params: {
  repoRoot: string;
  pluginId: string;
  relativePath?: string;
  expectedImport: string;
}) {
  const runtimePath = path.join(
    params.repoRoot,
    "dist-runtime",
    "extensions",
    params.pluginId,
    params.relativePath ?? "index.js",
  );
  expect(fs.existsSync(runtimePath)).toBe(true);
  expect(fs.readFileSync(runtimePath, "utf8")).toContain(params.expectedImport);
}

function expectRuntimePluginWrapperForwardsDefault(params: {
  repoRoot: string;
  pluginId: string;
  expectedImport: string;
}) {
  const runtimePath = path.join(
    params.repoRoot,
    "dist-runtime",
    "extensions",
    params.pluginId,
    "index.js",
  );
  expect(fs.readFileSync(runtimePath, "utf8")).toContain(
    `import defaultModule from "${params.expectedImport}";`,
  );
}

function expectRuntimeArtifactText(params: {
  repoRoot: string;
  pluginId: string;
  relativePath: string;
  expectedText: string;
  symbolicLink: boolean;
}) {
  const runtimePath = path.join(
    params.repoRoot,
    "dist-runtime",
    "extensions",
    params.pluginId,
    params.relativePath,
  );
  expect(fs.lstatSync(runtimePath).isSymbolicLink()).toBe(params.symbolicLink);
  expect(fs.readFileSync(runtimePath, "utf8")).toBe(params.expectedText);
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("stageBundledPluginRuntime", () => {
  it("stages bundled dist plugins as runtime wrappers and links staged dist node_modules", () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-");
    const distPluginDir = createDistPluginDir(repoRoot, "diffs");
    fs.mkdirSync(path.join(repoRoot, "dist"), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, "dist", "plugin-sdk"), { recursive: true });
    fs.mkdirSync(path.join(distPluginDir, "node_modules", "@pierre", "diffs"), {
      recursive: true,
    });
    setupRepoFiles(repoRoot, {
      "dist/plugin-sdk/index.js": "export const sdk = true;\n",
      "dist/plugin-sdk/channel-entry-contract.js":
        "export { contract } from '../channel-entry-contract-abc.js';\n",
      "dist/channel-entry-contract-abc.js": "export const contract = true;\n",
      [bundledDistPluginFile("diffs", "index.js")]: "export default {}\n",
      [bundledDistPluginFile("diffs", "node_modules/@pierre/diffs/index.js")]:
        "export default {}\n",
    });

    stageBundledPluginRuntime({ repoRoot });

    const runtimePluginDir = path.join(repoRoot, "dist-runtime", "extensions", "diffs");
    expectRuntimePluginWrapperContains({
      repoRoot,
      pluginId: "diffs",
      expectedImport: distRuntimeImportPath("diffs"),
    });
    expectRuntimePluginWrapperForwardsDefault({
      repoRoot,
      pluginId: "diffs",
      expectedImport: distRuntimeImportPath("diffs"),
    });
    expect(fs.lstatSync(path.join(runtimePluginDir, "node_modules")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(runtimePluginDir, "node_modules"))).toBe(
      fs.realpathSync(path.join(distPluginDir, "node_modules")),
    );
    expect(fs.existsSync(path.join(distPluginDir, "node_modules"))).toBe(true);
    expect(
      fs
        .lstatSync(
          path.join(repoRoot, "dist", "extensions", "node_modules", "openclaw", "plugin-sdk"),
        )
        .isSymbolicLink(),
    ).toBe(false);
    expect(
      fs.readFileSync(
        path.join(repoRoot, "dist", "extensions", "node_modules", "openclaw", "package.json"),
        "utf8",
      ),
    ).toContain('"./plugin-sdk": "./plugin-sdk/index.js"');
    expect(
      fs.readFileSync(
        path.join(repoRoot, "dist", "extensions", "node_modules", "openclaw", "package.json"),
        "utf8",
      ),
    ).toContain('"./plugin-sdk/*": "./plugin-sdk/*.js"');
    expect(
      fs.readFileSync(
        path.join(
          repoRoot,
          "dist",
          "extensions",
          "node_modules",
          "openclaw",
          "plugin-sdk",
          "channel-entry-contract.js",
        ),
        "utf8",
      ),
    ).toContain("../../../../plugin-sdk/channel-entry-contract.js");
    expect(fs.existsSync(path.join(runtimePluginDir, "node_modules", "openclaw"))).toBe(false);
  });

  it("keeps extension-local plugin-sdk wrappers resolving canonical dist chunks", async () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-sdk-wrapper-");
    createDistPluginDir(repoRoot, "diffs");
    setupRepoFiles(repoRoot, {
      "dist/plugin-sdk/channel-entry-contract.js":
        "export { contract } from '../channel-entry-contract-abc.js';\n",
      "dist/channel-entry-contract-abc.js": "export const contract = true;\n",
      [bundledDistPluginFile("diffs", "index.js")]: "export default {}\n",
    });

    stageBundledPluginRuntime({ repoRoot });

    const wrapperPath = path.join(
      repoRoot,
      "dist",
      "extensions",
      "node_modules",
      "openclaw",
      "plugin-sdk",
      "channel-entry-contract.js",
    );
    const wrapperModule = await import(`${pathToFileURL(wrapperPath).href}?t=${Date.now()}`);
    expect(wrapperModule.contract).toBe(true);
  });

  it("writes wrappers that forward plugin entry imports into canonical dist files", async () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-chunks-");
    createDistPluginDir(repoRoot, "diffs");
    setupRepoFiles(repoRoot, {
      "dist/chunk-abc.js": "export const value = 1;\n",
      [bundledDistPluginFile("diffs", "index.js")]: "export { value } from '../../chunk-abc.js';\n",
    });

    stageBundledPluginRuntime({ repoRoot });

    const runtimeEntryPath = path.join(repoRoot, "dist-runtime", "extensions", "diffs", "index.js");
    expectRuntimePluginWrapperContains({
      repoRoot,
      pluginId: "diffs",
      expectedImport: distRuntimeImportPath("diffs"),
    });
    expect(fs.existsSync(path.join(repoRoot, "dist-runtime", "chunk-abc.js"))).toBe(false);

    const runtimeModule = await import(`${pathToFileURL(runtimeEntryPath).href}?t=${Date.now()}`);
    expect(runtimeModule.value).toBe(1);
  });

  it("stages root runtime sidecars that bundled plugin boundaries resolve directly", () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-sidecars-");
    createDistPluginDir(repoRoot, "whatsapp");
    setupRepoFiles(repoRoot, {
      [bundledDistPluginFile("whatsapp", "index.js")]: "export default {};\n",
      [bundledDistPluginFile("whatsapp", "light-runtime-api.js")]: "export const light = true;\n",
      [bundledDistPluginFile("whatsapp", "runtime-api.js")]: "export const heavy = true;\n",
    });

    stageBundledPluginRuntime({ repoRoot });

    expectRuntimePluginWrapperContains({
      repoRoot,
      pluginId: "whatsapp",
      relativePath: "light-runtime-api.js",
      expectedImport: distRuntimeImportPath("whatsapp", "light-runtime-api.js"),
    });
    expectRuntimePluginWrapperContains({
      repoRoot,
      pluginId: "whatsapp",
      relativePath: "runtime-api.js",
      expectedImport: distRuntimeImportPath("whatsapp", "runtime-api.js"),
    });
  });

  it("keeps plugin command registration on the canonical dist graph when loaded from dist-runtime", async () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-commands-");
    const distPluginDir = path.join(repoRoot, "dist", "extensions", "demo");
    const distCommandsDir = path.join(repoRoot, "dist", "plugins");
    fs.mkdirSync(distPluginDir, { recursive: true });
    fs.mkdirSync(distCommandsDir, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "package.json"), '{ "type": "module" }\n', "utf8");
    fs.writeFileSync(
      path.join(distCommandsDir, "commands.js"),
      [
        "const registry = globalThis.__openclawTestPluginCommands ??= new Map();",
        "export function registerPluginCommand(pluginId, command) {",
        "  registry.set(`/${command.name.toLowerCase()}`, { ...command, pluginId });",
        "}",
        "export function clearPluginCommands() {",
        "  registry.clear();",
        "}",
        "export function getPluginCommandSpecs(provider) {",
        "  if (provider && provider !== 'telegram' && provider !== 'discord') return [];",
        "  return Array.from(registry.values()).map((command) => ({",
        "    name: command.nativeNames?.[provider] ?? command.nativeNames?.default ?? command.name,",
        "    description: command.description,",
        "    acceptsArgs: command.acceptsArgs ?? false,",
        "  }));",
        "}",
        "export function matchPluginCommand(commandBody) {",
        "  const [commandName, ...rest] = commandBody.trim().split(/\\s+/u);",
        "  const command = registry.get(commandName.toLowerCase());",
        "  if (!command) return null;",
        "  return { command, args: rest.length > 0 ? rest.join(' ') : undefined };",
        "}",
        "export async function executePluginCommand(params) {",
        "  return params.command.handler({ args: params.args });",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(distPluginDir, "index.js"),
      [
        "import { registerPluginCommand } from '../../plugins/commands.js';",
        "",
        "export function registerDemoCommand() {",
        "  registerPluginCommand('demo-plugin', {",
        "    name: 'pair',",
        "    description: 'Pair a device',",
        "    acceptsArgs: true,",
        "    nativeNames: { telegram: 'pair', discord: 'pair' },",
        "    handler: async ({ args }) => ({ text: `paired:${args ?? ''}` }),",
        "  });",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    stageBundledPluginRuntime({ repoRoot });

    const runtimeEntryPath = path.join(repoRoot, "dist-runtime", "extensions", "demo", "index.js");
    const canonicalCommandsPath = path.join(repoRoot, "dist", "plugins", "commands.js");

    expect(fs.existsSync(path.join(repoRoot, "dist-runtime", "plugins", "commands.js"))).toBe(
      false,
    );

    const runtimeModule = await import(`${pathToFileURL(runtimeEntryPath).href}?t=${Date.now()}`);
    const commandsModule = (await import(
      `${pathToFileURL(canonicalCommandsPath).href}?t=${Date.now()}`
    )) as {
      clearPluginCommands: () => void;
      getPluginCommandSpecs: (provider?: string) => Array<{
        name: string;
        description: string;
        acceptsArgs: boolean;
      }>;
      matchPluginCommand: (commandBody: string) => {
        command: { handler: ({ args }: { args?: string }) => Promise<{ text: string }> };
        args?: string;
      } | null;
      executePluginCommand: (params: {
        command: { handler: ({ args }: { args?: string }) => Promise<{ text: string }> };
        args?: string;
      }) => Promise<{ text: string }>;
    };

    commandsModule.clearPluginCommands();
    runtimeModule.registerDemoCommand();

    expect(commandsModule.getPluginCommandSpecs("telegram")).toEqual([
      { name: "pair", description: "Pair a device", acceptsArgs: true },
    ]);
    expect(commandsModule.getPluginCommandSpecs("discord")).toEqual([
      { name: "pair", description: "Pair a device", acceptsArgs: true },
    ]);

    const match = commandsModule.matchPluginCommand("/pair now");
    expect(match).not.toBeNull();
    expect(match?.args).toBe("now");
    await expect(
      commandsModule.executePluginCommand({
        command: match!.command,
        args: match?.args,
      }),
    ).resolves.toEqual({ text: "paired:now" });
  });

  it("copies package metadata files but symlinks other non-js plugin artifacts into the runtime overlay", () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-assets-");
    createDistPluginDir(repoRoot, "diffs");
    setupRepoFiles(repoRoot, {
      [bundledDistPluginFile("diffs", "package.json")]: JSON.stringify(
        { name: "@openclaw/diffs", openclaw: { extensions: ["./index.js"] } },
        null,
        2,
      ),
      [bundledDistPluginFile("diffs", "openclaw.plugin.json")]: "{}\n",
      [bundledDistPluginFile("diffs", "assets/info.txt")]: "ok\n",
    });

    stageBundledPluginRuntime({ repoRoot });

    expectRuntimeArtifactText({
      repoRoot,
      pluginId: "diffs",
      relativePath: "openclaw.plugin.json",
      expectedText: "{}\n",
      symbolicLink: false,
    });
    expectRuntimeArtifactText({
      repoRoot,
      pluginId: "diffs",
      relativePath: "assets/info.txt",
      expectedText: "ok\n",
      symbolicLink: true,
    });
    const runtimePackagePath = path.join(
      repoRoot,
      "dist-runtime",
      "extensions",
      "diffs",
      "package.json",
    );
    expect(fs.lstatSync(runtimePackagePath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(runtimePackagePath, "utf8")).toContain('"extensions": [');
  });

  it("copies bundled plugin skill trees into the runtime overlay", () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-skills-");
    createDistPluginDir(repoRoot, "feishu");
    setupRepoFiles(repoRoot, {
      [bundledDistPluginFile("feishu", "index.js")]: "export default {}\n",
      [bundledDistPluginFile("feishu", "skills/feishu-doc/SKILL.md")]:
        "---\nname: feishu-doc\n---\n",
      [bundledDistPluginFile("feishu", "skills/feishu-doc/fixture.txt")]: "# Feishu Doc\n",
    });

    stageBundledPluginRuntime({ repoRoot });

    const runtimeRoot = path.join(repoRoot, "dist-runtime");
    const runtimeSkillPath = path.join(
      runtimeRoot,
      "extensions",
      "feishu",
      "skills",
      "feishu-doc",
      "fixture.txt",
    );

    expect(fs.lstatSync(runtimeSkillPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(runtimeSkillPath, "utf8")).toBe("# Feishu Doc\n");
    expect(path.relative(fs.realpathSync(runtimeRoot), fs.realpathSync(runtimeSkillPath))).toBe(
      path.join("extensions", "feishu", "skills", "feishu-doc", "fixture.txt"),
    );
  });

  it("preserves package metadata needed for bundled plugin discovery from dist-runtime", () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-discovery-");
    const runtimeExtensionsDir = path.join(repoRoot, "dist-runtime", "extensions");
    createDistPluginDir(repoRoot, "demo");
    setupRepoFiles(repoRoot, {
      [bundledDistPluginFile("demo", "package.json")]: JSON.stringify(
        {
          name: "@openclaw/demo",
          openclaw: {
            extensions: ["./main.js"],
            setupEntry: "./setup.js",
            startup: {
              deferConfiguredChannelFullLoadUntilAfterListen: true,
            },
          },
        },
        null,
        2,
      ),
      [bundledDistPluginFile("demo", "openclaw.plugin.json")]: JSON.stringify(
        {
          id: "demo",
          channels: ["demo"],
          configSchema: { type: "object" },
        },
        null,
        2,
      ),
      [bundledDistPluginFile("demo", "main.js")]: "export default {};\n",
      [bundledDistPluginFile("demo", "setup.js")]: "export default {};\n",
    });

    stageBundledPluginRuntime({ repoRoot });

    const env = {
      ...process.env,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: runtimeExtensionsDir,
    };
    const discovery = discoverOpenClawPlugins({
      env,
    });
    const manifestRegistry = loadPluginManifestRegistry({
      env,
      candidates: discovery.candidates,
      diagnostics: discovery.diagnostics,
    });
    const expectedRuntimeMainPath = fs.realpathSync(
      path.join(runtimeExtensionsDir, "demo", "main.js"),
    );
    const expectedRuntimeSetupPath = fs.realpathSync(
      path.join(runtimeExtensionsDir, "demo", "setup.js"),
    );

    expect(discovery.candidates).toHaveLength(1);
    expect(fs.realpathSync(discovery.candidates[0]?.source ?? "")).toBe(expectedRuntimeMainPath);
    expect(fs.realpathSync(discovery.candidates[0]?.setupSource ?? "")).toBe(
      expectedRuntimeSetupPath,
    );
    expect(fs.realpathSync(manifestRegistry.plugins[0]?.setupSource ?? "")).toBe(
      expectedRuntimeSetupPath,
    );
    expect(manifestRegistry.plugins[0]?.startupDeferConfiguredChannelFullLoadUntilAfterListen).toBe(
      true,
    );
  });

  it("removes stale runtime plugin directories that are no longer in dist", () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-stale-");
    const staleRuntimeDir = path.join(repoRoot, "dist-runtime", "extensions", "stale");
    fs.mkdirSync(staleRuntimeDir, { recursive: true });
    fs.writeFileSync(path.join(staleRuntimeDir, "index.js"), "stale\n", "utf8");
    fs.mkdirSync(path.join(repoRoot, "dist", "extensions"), { recursive: true });

    stageBundledPluginRuntime({ repoRoot });

    expect(fs.existsSync(staleRuntimeDir)).toBe(false);
  });

  it("removes dist-runtime when the built bundled plugin tree is absent", () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-missing-");
    const runtimeRoot = path.join(repoRoot, "dist-runtime", "extensions", "diffs");
    fs.mkdirSync(runtimeRoot, { recursive: true });

    stageBundledPluginRuntime({ repoRoot });

    expect(fs.existsSync(path.join(repoRoot, "dist-runtime"))).toBe(false);
  });

  it("tolerates EEXIST when an identical runtime symlink is materialized concurrently", () => {
    const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-eexist-");
    createDistPluginDir(repoRoot, "feishu");
    setupRepoFiles(repoRoot, {
      [bundledDistPluginFile("feishu", "index.js")]: "export default {}\n",
      [bundledDistPluginFile("feishu", "assets/fixture.txt")]: "# Feishu Doc\n",
    });

    const realSymlinkSync = fs.symlinkSync.bind(fs);
    const symlinkSpy = vi.spyOn(fs, "symlinkSync").mockImplementation(((target, link, type) => {
      const linkPath = String(link);
      if (linkPath.endsWith(path.join("assets", "fixture.txt"))) {
        const err = Object.assign(new Error("file already exists"), { code: "EEXIST" });
        realSymlinkSync(String(target), linkPath, type);
        throw err;
      }
      return realSymlinkSync(String(target), linkPath, type);
    }) as typeof fs.symlinkSync);

    expect(() => stageBundledPluginRuntime({ repoRoot })).not.toThrow();

    const runtimeAssetPath = path.join(
      repoRoot,
      "dist-runtime",
      "extensions",
      "feishu",
      "assets",
      "fixture.txt",
    );
    expect(fs.lstatSync(runtimeAssetPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(runtimeAssetPath, "utf8")).toBe("# Feishu Doc\n");

    symlinkSpy.mockRestore();
  });

  it.each(["EACCES", "ENOSYS"] as const)(
    "falls back to copying runtime assets when Windows symlink creation fails with %s",
    (code) => {
      const repoRoot = makeRepoRoot("openclaw-stage-bundled-runtime-win-copy-");
      createDistPluginDir(repoRoot, "feishu");
      setupRepoFiles(repoRoot, {
        [bundledDistPluginFile("feishu", "index.js")]: "export default {}\n",
        [bundledDistPluginFile("feishu", "assets/fixture.txt")]: "# Feishu Doc\n",
      });

      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
      const realSymlinkSync = fs.symlinkSync.bind(fs);
      const symlinkSpy = vi.spyOn(fs, "symlinkSync").mockImplementation(((target, link, type) => {
        const linkPath = String(link);
        if (linkPath.endsWith(path.join("assets", "fixture.txt"))) {
          throw Object.assign(new Error("symlink failed"), { code });
        }
        return realSymlinkSync(String(target), linkPath, type);
      }) as typeof fs.symlinkSync);

      stageBundledPluginRuntime({ repoRoot });

      const runtimeAssetPath = path.join(
        repoRoot,
        "dist-runtime",
        "extensions",
        "feishu",
        "assets",
        "fixture.txt",
      );
      expect(fs.lstatSync(runtimeAssetPath).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(runtimeAssetPath, "utf8")).toBe("# Feishu Doc\n");

      symlinkSpy.mockRestore();
      platformSpy.mockRestore();
    },
  );
});
