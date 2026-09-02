// Resource loader tests cover prompt loading and transforms.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withMockedWindowsPlatform } from "../../test-utils/vitest-spies.js";
import { clearExtensionCache } from "./extensions/loader.js";
import { DefaultPackageManager } from "./package-manager.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SettingsManager } from "./settings-manager.js";
import type { SourceScope } from "./source-info.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type ExtensionCacheTestState = {
  factoryRuns: number;
  moduleLoads: number;
};

function extensionCacheTestState(): ExtensionCacheTestState {
  return (
    globalThis as typeof globalThis & { openclawExtensionCacheTestState: ExtensionCacheTestState }
  ).openclawExtensionCacheTestState;
}

function extensionSource(command: string): string {
  return `
const state = (globalThis.openclawExtensionCacheTestState ??= { factoryRuns: 0, moduleLoads: 0 });
state.moduleLoads += 1;

export default function extension(api) {
  state.factoryRuns += 1;
  api.registerCommand(${JSON.stringify(command)}, {
    description: "cache probe",
    handler() {},
  });
}
`;
}

function sourceMetadata(path: string, source: string, scope: SourceScope) {
  return { path, source, scope, origin: "package" as const, baseDir: path };
}

afterEach(() => {
  clearExtensionCache();
  Reflect.deleteProperty(globalThis, "openclawExtensionCacheTestState");
});

describe("DefaultResourceLoader", () => {
  it("does not load a direct local extension disabled by its package filter", async () => {
    const root = tempDirs.make("openclaw-resource-loader-filter-");
    const extensionPath = join(root, "extension.ts");
    await writeFile(extensionPath, "export default function extension() {}\n");
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({
        packages: [{ source: extensionPath, extensions: [] }],
      }),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });

    await loader.reload();

    expect(loader.getExtensions().extensions).toEqual([]);
  });

  it("skips ambient package resolution while preserving explicit resource paths", async () => {
    const root = tempDirs.make("openclaw-resource-loader-explicit-");
    const promptDir = join(root, "explicit-prompts");
    const promptPath = join(promptDir, "explicit.md");
    await mkdir(promptDir);
    await writeFile(promptPath, "Explicit prompt");
    const resolvePackages = vi.spyOn(DefaultPackageManager.prototype, "resolve");

    try {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        additionalPromptTemplatePaths: [promptDir],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });

      await loader.reload();

      expect(resolvePackages).not.toHaveBeenCalled();
      expect(loader.getPrompts().prompts).toEqual([
        expect.objectContaining({ name: "explicit", filePath: promptPath }),
      ]);
    } finally {
      resolvePackages.mockRestore();
    }
  });

  it("reuses extension modules between loaders and refreshes them on reload", async () => {
    const root = tempDirs.make("openclaw-resource-loader-extension-");
    const extensionPath = join(root, "extension.ts");
    await writeFile(extensionPath, extensionSource("before-reload"));
    const createLoader = () =>
      new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        additionalExtensionPaths: [extensionPath],
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      });

    const firstLoader = createLoader();
    await firstLoader.reload();
    const secondLoader = createLoader();
    await secondLoader.reload();

    expect(extensionCacheTestState()).toEqual({ factoryRuns: 2, moduleLoads: 1 });
    expect(secondLoader.getExtensions().extensions[0]?.commands.has("before-reload")).toBe(true);

    await writeFile(extensionPath, extensionSource("after-reload"));
    await secondLoader.reload();

    expect(extensionCacheTestState()).toEqual({ factoryRuns: 3, moduleLoads: 2 });
    expect(secondLoader.getExtensions().extensions[0]?.commands.has("after-reload")).toBe(true);
  });

  it("does not use unreadable prompt file paths as prompt content", async () => {
    const root = tempDirs.make("openclaw-resource-loader-");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: root,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        systemPrompt: root,
        appendSystemPrompt: [root],
      });

      await loader.reload();

      expect(loader.getSystemPrompt()).toBeUndefined();
      expect(loader.getAppendSystemPrompt()).toEqual([]);
      expect(consoleError).toHaveBeenCalledTimes(2);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("inherits Windows source metadata across case-variant resource roots", async () => {
    const root = tempDirs.make("openclaw-resource-loader-scope-");
    const variantAgentDir = join(root, "AGENT");
    const variantPackageDir = join(root, "PACKAGE-SOURCE");
    const defaultSkillDir = join(root, "agent", "skills", "default");
    await mkdir(defaultSkillDir, { recursive: true });

    withMockedWindowsPlatform(() => {
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir: variantAgentDir,
      });
      const cases = [
        loader["getDefaultSourceInfoForPath"](defaultSkillDir),
        loader["findSourceInfoForPath"](
          join(root, "package-source", "extra", "SKILL.md"),
          new Map([[variantPackageDir, sourceMetadata(variantPackageDir, "extension", "project")]]),
        ),
        loader["findSourceInfoForPath"](
          join(root, "package-source", "package", "SKILL.md"),
          undefined,
          new Map([[variantPackageDir, sourceMetadata(variantPackageDir, "package", "user")]]),
        ),
      ];

      expect(cases).toMatchObject([
        { source: "local", scope: "user", baseDir: join(variantAgentDir, "skills") },
        { source: "extension", scope: "project", baseDir: variantPackageDir },
        { source: "package", scope: "user", baseDir: variantPackageDir },
      ]);
    });
  });
});
