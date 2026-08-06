// Resource loader tests cover prompt loading and transforms.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearExtensionCache } from "./extensions/loader.js";
import { DefaultResourceLoader } from "./resource-loader.js";

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

afterEach(() => {
  clearExtensionCache();
  Reflect.deleteProperty(globalThis, "openclawExtensionCacheTestState");
});

describe("DefaultResourceLoader", () => {
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
});
