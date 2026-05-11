import fs from "node:fs";
import path from "node:path";
import { bundledDistPluginFile } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { stageBundledPluginRuntime } from "../../scripts/stage-bundled-plugin-runtime.mjs";
import type { PluginModuleLoaderCache } from "./plugin-module-loader-cache.js";
import { loadPluginBoundaryModule } from "./runtime/runtime-plugin-boundary.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

type LightModule = {
  getActiveWebListener: (accountId?: string | null) => unknown;
};

type HeavyModule = {
  registerControllerForTest: (
    accountId: string | null | undefined,
    listener: { sendMessage: () => Promise<{ messageId: string }> } | null,
  ) => void;
};

const tempDirs: string[] = [];

function writeRuntimeFixtureText(rootDir: string, relativePath: string, value: string) {
  fs.mkdirSync(path.dirname(path.join(rootDir, relativePath)), { recursive: true });
  fs.writeFileSync(path.join(rootDir, relativePath), value, "utf8");
}

function createBundledWhatsAppRuntimeFixture() {
  const rootDir = makeTrackedTempDir("openclaw-whatsapp-boundary", tempDirs);
  for (const [relativePath, value] of Object.entries({
    "package.json": JSON.stringify(
      {
        name: "openclaw",
        type: "module",
        bin: {
          openclaw: "openclaw.mjs",
        },
        exports: {
          "./plugin-sdk": {
            default: "./dist/plugin-sdk/index.js",
          },
        },
      },
      null,
      2,
    ),
    "openclaw.mjs": "export {};\n",
    [bundledDistPluginFile("whatsapp", "index.js")]: "export default {};\n",
    [bundledDistPluginFile("whatsapp", "light-runtime-api.js")]:
      'export { getActiveWebListener } from "../../active-listener.js";\n',
    [bundledDistPluginFile("whatsapp", "runtime-api.js")]:
      'export { registerControllerForTest } from "../../connection-controller-registry.js";\n',
    "dist/connection-controller-registry.js": [
      'const key = Symbol.for("openclaw.whatsapp.connectionControllerRegistry");',
      "const g = globalThis;",
      "if (!g[key]) {",
      "  g[key] = { controllers: new Map() };",
      "}",
      "const state = g[key];",
      "export function getRegisteredWhatsAppConnectionController(accountId) {",
      "  return state.controllers.get(accountId) ?? null;",
      "}",
      "export function registerControllerForTest(accountId, listener) {",
      '  const id = accountId ?? "default";',
      "  if (!listener) {",
      "    state.controllers.delete(id);",
      "    return;",
      "  }",
      "  state.controllers.set(id, {",
      "    getActiveListener() {",
      "      return listener;",
      "    },",
      "  });",
      "}",
      "",
    ].join("\n"),
    "dist/active-listener.js": [
      'import { getRegisteredWhatsAppConnectionController } from "./connection-controller-registry.js";',
      "export function getActiveWebListener(accountId) {",
      '  return getRegisteredWhatsAppConnectionController(accountId ?? "default")?.getActiveListener() ?? null;',
      "}",
      "",
    ].join("\n"),
  })) {
    writeRuntimeFixtureText(rootDir, relativePath, value);
  }
  stageBundledPluginRuntime({ repoRoot: rootDir });

  return path.join(rootDir, "dist-runtime", "extensions", "whatsapp");
}

function createExternalTypeScriptRuntimePackageFixture() {
  const rootDir = makeTrackedTempDir("openclaw-external-boundary-ts", tempDirs);
  writeRuntimeFixtureText(
    rootDir,
    "package.json",
    JSON.stringify(
      {
        name: "openclaw-external-ts-runtime",
        type: "module",
      },
      null,
      2,
    ),
  );
  writeRuntimeFixtureText(
    rootDir,
    "runtime-api.ts",
    [
      'import { marker } from "./runtime-helper.js";',
      "export const ok = true;",
      "export const loadedVia = marker;",
      "",
    ].join("\n"),
  );
  writeRuntimeFixtureText(
    rootDir,
    "runtime-helper.ts",
    'export const marker = "jiti-source-package";\n',
  );
  return path.join(rootDir, "runtime-api.ts");
}

function loadWhatsAppBoundaryModules(runtimePluginDir: string) {
  const loaders: PluginModuleLoaderCache = new Map();
  return {
    light: loadPluginBoundaryModule<LightModule>(
      path.join(runtimePluginDir, "light-runtime-api.js"),
      loaders,
      { origin: "bundled" },
    ),
    heavy: loadPluginBoundaryModule<HeavyModule>(
      path.join(runtimePluginDir, "runtime-api.js"),
      loaders,
      { origin: "bundled" },
    ),
  };
}

function createListener(messageId = "msg-1") {
  return {
    sendMessage: async () => ({ messageId }),
  };
}

function expectSharedWhatsAppListenerState(runtimePluginDir: string, accountId: string) {
  const { light, heavy } = loadWhatsAppBoundaryModules(runtimePluginDir);
  const listener = createListener();

  heavy.registerControllerForTest(accountId, listener);
  expect(light.getActiveWebListener(accountId)).toBe(listener);
  heavy.registerControllerForTest(accountId, null);
}

afterEach(() => {
  cleanupTrackedTempDirs(tempDirs);
});

describe("runtime plugin boundary whatsapp seam", () => {
  it("shares listener state between staged light and heavy runtime modules", () => {
    expectSharedWhatsAppListenerState(createBundledWhatsAppRuntimeFixture(), "work");
  });

  it("rejects bundled TypeScript runtime modules instead of using the source loader", () => {
    const rootDir = makeTrackedTempDir("openclaw-bundled-boundary-ts", tempDirs);
    const modulePath = path.join(rootDir, "runtime-api.ts");
    writeRuntimeFixtureText(rootDir, "runtime-api.ts", "export const ok = true;\n");
    const loaders: PluginModuleLoaderCache = new Map();

    expect(() =>
      loadPluginBoundaryModule<{ ok: boolean }>(modulePath, loaders, { origin: "bundled" }),
    ).toThrow(/must be built JavaScript/u);
    expect(loaders.size).toBe(0);
  });

  it("keeps the TypeScript source package fallback available for non-bundled plugins", () => {
    const modulePath = createExternalTypeScriptRuntimePackageFixture();
    const loaders: PluginModuleLoaderCache = new Map();

    expect(
      loadPluginBoundaryModule<{ ok: boolean; loadedVia: string }>(modulePath, loaders, {
        origin: "workspace",
      }),
    ).toEqual({ ok: true, loadedVia: "jiti-source-package" });
    expect(loaders.size).toBe(1);
  });
});
