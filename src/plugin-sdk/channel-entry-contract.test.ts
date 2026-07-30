// Channel entry contract tests cover SDK channel entrypoint exports and package boundaries.
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PluginModuleLoaderFactory } from "../plugins/plugin-module-loader-cache.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { OpenClawPluginApi, PluginRegistrationMode } from "../plugins/types.js";
import { withMockedWindowsPlatform } from "../test-utils/vitest-spies.js";
import {
  defineBundledChannelEntry,
  defineBundledChannelSetupEntry,
  loadBundledEntryExportSync,
} from "./channel-entry-contract.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const pluginModuleLoaderJitiFactoryOverrideKey = Symbol.for(
  "openclaw.pluginModuleLoaderJitiFactoryOverride",
);

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("jiti");
  vi.doUnmock("../plugins/native-module-require.js");
  vi.unstubAllEnvs();
  delete (
    globalThis as typeof globalThis & {
      [pluginModuleLoaderJitiFactoryOverrideKey]?: PluginModuleLoaderFactory;
    }
  )[pluginModuleLoaderJitiFactoryOverrideKey];
});

function stubPluginModuleLoaderJitiFactory(createJiti: PluginModuleLoaderFactory): void {
  (
    globalThis as typeof globalThis & {
      [pluginModuleLoaderJitiFactoryOverrideKey]?: PluginModuleLoaderFactory;
    }
  )[pluginModuleLoaderJitiFactoryOverrideKey] = createJiti;
}

function writeJson(targetPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createApi(registrationMode: PluginRegistrationMode): OpenClawPluginApi {
  return {
    registrationMode,
    runtime: { registrationMode } as unknown as PluginRuntime,
    registerChannel: vi.fn(),
    registerTool: vi.fn(),
  } as unknown as OpenClawPluginApi;
}

function writeBundledChannelFixture(params: {
  pluginRoot: string;
  pluginId: string;
  runtimeMarker: string;
}) {
  fs.mkdirSync(params.pluginRoot, { recursive: true });
  const importerPath = path.join(params.pluginRoot, "index.js");
  fs.writeFileSync(importerPath, "export default {};\n", "utf8");
  fs.writeFileSync(
    path.join(params.pluginRoot, "plugin.cjs"),
    `module.exports = {
  channelPlugin: {
    id: ${JSON.stringify(params.pluginId)},
    meta: {
      id: ${JSON.stringify(params.pluginId)},
      label: ${JSON.stringify(params.pluginId)},
      selectionLabel: ${JSON.stringify(params.pluginId)},
      docsPath: ${JSON.stringify(`/channels/${params.pluginId}`)},
      blurb: "bundled channel",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => null,
    },
    outbound: { deliveryMode: "direct" },
  },
};
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(params.pluginRoot, "runtime.cjs"),
    `module.exports = {
  setRuntime: () => {
    require("node:fs").writeFileSync(${JSON.stringify(params.runtimeMarker)}, "loaded", "utf8");
  },
};
`,
    "utf8",
  );
  return { importerPath };
}

function createBundledChannelEntry(params: {
  importerPath: string;
  pluginId: string;
  registerCliMetadata?: (api: OpenClawPluginApi) => void;
  registerFull?: (api: OpenClawPluginApi) => void;
}) {
  return defineBundledChannelEntry({
    id: params.pluginId,
    name: params.pluginId,
    description: "bundled channel entry test",
    importMetaUrl: pathToFileURL(params.importerPath).href,
    plugin: { specifier: "./plugin.cjs", exportName: "channelPlugin" },
    runtime: { specifier: "./runtime.cjs", exportName: "setRuntime" },
    registerCliMetadata: params.registerCliMetadata,
    registerFull: params.registerFull,
  });
}

describe("defineBundledChannelEntry", () => {
  it("runs tool registrations without channel sidecar hydration during tool discovery", () => {
    const tempRoot = tempDirs.make("openclaw-bundled-entry-tools-");
    const runtimeMarker = path.join(tempRoot, "runtime-loaded");
    const pluginId = "bundled-tool-discovery";
    const { importerPath } = writeBundledChannelFixture({
      pluginRoot: path.join(tempRoot, "dist", "extensions", pluginId),
      pluginId,
      runtimeMarker,
    });
    const registerCliMetadata = vi.fn<(api: OpenClawPluginApi) => void>();
    const registerFull = vi.fn<(api: OpenClawPluginApi) => void>((api) => {
      api.registerTool(
        {
          name: "channel_tool",
          label: "Channel Tool",
          description: "channel tool",
          parameters: {},
          execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
        },
        { name: "channel_tool" },
      );
    });
    const entry = createBundledChannelEntry({
      importerPath,
      pluginId,
      registerCliMetadata,
      registerFull,
    });

    const api = createApi("tool-discovery");
    entry.register(api);

    expect(api.registerChannel).not.toHaveBeenCalled();
    expect(registerCliMetadata).not.toHaveBeenCalled();
    expect(registerFull).toHaveBeenCalledWith(api);
    expect(api.registerTool).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(runtimeMarker)).toBe(false);
  });

  it("loads runtime sidecars during discovery registration", () => {
    const tempRoot = tempDirs.make("openclaw-bundled-entry-runtime-");
    const runtimeMarker = path.join(tempRoot, "runtime-loaded");
    const pluginId = "bundled-discovery";
    const { importerPath } = writeBundledChannelFixture({
      pluginRoot: path.join(tempRoot, "dist", "extensions", pluginId),
      pluginId,
      runtimeMarker,
    });
    const registerCliMetadata = vi.fn<(api: OpenClawPluginApi) => void>();
    const registerFull = vi.fn<(api: OpenClawPluginApi) => void>();
    const entry = createBundledChannelEntry({
      importerPath,
      pluginId,
      registerCliMetadata,
      registerFull,
    });

    const api = createApi("discovery");
    entry.register(api);

    expect(api.registerChannel).toHaveBeenCalledTimes(1);
    expect(registerCliMetadata).toHaveBeenCalledWith(api);
    expect(registerFull).not.toHaveBeenCalled();
    expect(fs.existsSync(runtimeMarker)).toBe(true);
  });

  it("keeps setup-runtime and full registration wired to runtime sidecars", () => {
    const tempRoot = tempDirs.make("openclaw-bundled-entry-runtime-");
    const runtimeMarker = path.join(tempRoot, "runtime-loaded");
    const pluginId = "bundled-runtime";
    const { importerPath } = writeBundledChannelFixture({
      pluginRoot: path.join(tempRoot, "dist", "extensions", pluginId),
      pluginId,
      runtimeMarker,
    });
    const registerCliMetadata = vi.fn<(api: OpenClawPluginApi) => void>();
    const registerFull = vi.fn<(api: OpenClawPluginApi) => void>();
    const entry = createBundledChannelEntry({
      importerPath,
      pluginId,
      registerCliMetadata,
      registerFull,
    });

    entry.register(createApi("setup-runtime"));
    expect(fs.existsSync(runtimeMarker)).toBe(true);
    expect(registerCliMetadata).not.toHaveBeenCalled();
    expect(registerFull).not.toHaveBeenCalled();

    fs.rmSync(runtimeMarker, { force: true });
    const fullApi = createApi("full");
    entry.register(fullApi);
    expect(fs.existsSync(runtimeMarker)).toBe(true);
    expect(registerCliMetadata).toHaveBeenCalledWith(fullApi);
    expect(registerFull).toHaveBeenCalledWith(fullApi);
  });
});

describe("defineBundledChannelSetupEntry", () => {
  it("exposes setup-runtime registrations without loading the full channel entry", () => {
    const tempRoot = tempDirs.make("openclaw-bundled-setup-entry-");
    const runtimeMarker = path.join(tempRoot, "runtime-loaded");
    const setupRuntimeRegister = vi.fn<(api: OpenClawPluginApi) => void>();
    const pluginId = "bundled-setup-runtime";
    const { importerPath } = writeBundledChannelFixture({
      pluginRoot: path.join(tempRoot, "dist", "extensions", pluginId),
      pluginId,
      runtimeMarker,
    });
    const entry = defineBundledChannelSetupEntry({
      importMetaUrl: pathToFileURL(importerPath).href,
      plugin: { specifier: "./plugin.cjs", exportName: "channelPlugin" },
      runtime: { specifier: "./runtime.cjs", exportName: "setRuntime" },
      registerSetupRuntime: setupRuntimeRegister,
    });

    const api = createApi("setup-runtime");
    expect(entry.loadSetupPlugin().id).toBe(pluginId);
    entry.setChannelRuntime?.(api.runtime);
    entry.registerSetupRuntime?.(api);

    expect(fs.existsSync(runtimeMarker)).toBe(true);
    expect(setupRuntimeRegister).toHaveBeenCalledWith(api);
  });
});

async function expectBuiltArtifactNodeRequireFastPath(
  scope: string,
  artifactRoot = "dist",
): Promise<void> {
  vi.stubEnv("OPENCLAW_DIAGNOSTICS", "plugin.load-profile");
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

  try {
    const channelEntryContract = await importFreshModule<
      typeof import("./channel-entry-contract.js")
    >(import.meta.url, `./channel-entry-contract.js?scope=${scope}`);

    const tempRoot = tempDirs.make("openclaw-channel-entry-contract-");

    const pluginRoot = path.join(tempRoot, artifactRoot, "extensions", "telegram");
    fs.mkdirSync(pluginRoot, { recursive: true });

    const importerPath = path.join(pluginRoot, "index.js");
    const sidecarPath = path.join(pluginRoot, "fast-path-sidecar.cjs");
    fs.writeFileSync(importerPath, "export default {};\n", "utf8");
    // CommonJS so `nodeRequire` succeeds without falling back to the source loader, even
    // inside built plugin artifacts with a `type: "module"` package boundary.
    fs.writeFileSync(sidecarPath, "module.exports = { sentinel: 7 };\n", "utf8");

    expect(
      channelEntryContract.loadBundledEntryExportSync<number>(pathToFileURL(importerPath).href, {
        specifier: "./fast-path-sidecar.cjs",
        exportName: "sentinel",
      }),
    ).toBe(7);

    const profileLine = errorSpy.mock.calls
      .map((args) => String(args[0] ?? ""))
      .find((line) => line.startsWith("[plugin-load-profile] phase=bundled-entry-module-load"));
    if (profileLine === undefined) {
      throw new Error("expected a bundled-entry-module-load profile line");
    }
    expect(profileLine).toMatch(/sourceLoaderCreateMs=\d/u);
    expect(profileLine).toMatch(/sourceLoaderCallMs=\d/u);
    expect(profileLine).not.toMatch(/sourceLoaderCreateMs=-/);
    expect(profileLine).not.toMatch(/sourceLoaderCallMs=-/);
  } finally {
    errorSpy.mockRestore();
  }
}

function runCompiledEsmSidecarFastPathProbe(): SpawnSyncReturns<string> {
  const tempRoot = tempDirs.make("openclaw-channel-entry-contract-");
  const probePath = path.join(tempRoot, "probe.mjs");
  const channelEntryContractModuleUrl = pathToFileURL(
    path.join(process.cwd(), "src", "plugin-sdk", "channel-entry-contract.ts"),
  ).href;

  writeJson(path.join(tempRoot, "package.json"), {
    name: "openclaw",
    type: "module",
    bin: { openclaw: "./openclaw.mjs" },
    exports: {
      "./plugin-sdk/channel-outbound": "./dist/plugin-sdk/channel-outbound.js",
    },
  });
  fs.writeFileSync(path.join(tempRoot, "openclaw.mjs"), "#!/usr/bin/env node\n", "utf8");
  fs.mkdirSync(path.join(tempRoot, "dist", "plugin-sdk"), { recursive: true });
  fs.writeFileSync(
    path.join(tempRoot, "dist", "plugin-sdk", "channel-outbound.js"),
    'export const defineChannelMessageAdapter = () => "adapter";\n',
    "utf8",
  );

  const pluginRoot = path.join(tempRoot, "dist", "extensions", "slack");
  fs.mkdirSync(pluginRoot, { recursive: true });
  const importerPath = path.join(pluginRoot, "index.js");
  fs.writeFileSync(importerPath, "export default {};\n", "utf8");
  fs.writeFileSync(
    path.join(pluginRoot, "sidecar.js"),
    'import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";\nexport const sentinel = defineChannelMessageAdapter();\n',
    "utf8",
  );

  fs.writeFileSync(
    probePath,
    [
      `import { loadBundledEntryExportSync } from ${JSON.stringify(channelEntryContractModuleUrl)};`,
      `const value = loadBundledEntryExportSync(${JSON.stringify(pathToFileURL(importerPath).href)}, {`,
      '  specifier: "./sidecar.js",',
      '  exportName: "sentinel",',
      "});",
      "console.log(value);",
      "",
    ].join("\n"),
    "utf8",
  );

  return spawnSync(process.execPath, ["--import", "tsx", probePath], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, OPENCLAW_DIAGNOSTICS: "plugin.load-profile" },
  });
}

describe("loadBundledEntryExportSync", () => {
  let compiledEsmSidecarFastPathResult: SpawnSyncReturns<string>;

  beforeAll(() => {
    compiledEsmSidecarFastPathResult = runCompiledEsmSidecarFastPathProbe();
  });

  it("includes importer and resolved path context when a bundled sidecar is missing", () => {
    const tempRoot = tempDirs.make("openclaw-channel-entry-contract-");

    const pluginRoot = path.join(tempRoot, "dist", "extensions", "telegram");
    fs.mkdirSync(pluginRoot, { recursive: true });

    const importerPath = path.join(pluginRoot, "index.js");
    fs.writeFileSync(importerPath, "export default {};\n", "utf8");

    let thrown: unknown;
    try {
      loadBundledEntryExportSync(pathToFileURL(importerPath).href, {
        specifier: "./src/secret-contract.js",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('bundled plugin entry "./src/secret-contract.js" failed to open');
    expect(message).toContain(`from "${importerPath}"`);
    expect(message).toContain(`resolved "${path.join(pluginRoot, "src", "secret-contract.js")}"`);
    expect(message).toContain(`plugin root "${pluginRoot}"`);
    expect(message).toContain('reason "path"');
    expect(message).toContain("ENOENT");
  });

  it("keeps Windows dist sidecar loads off source-transform loading", async () => {
    const createJiti = vi.fn(() => vi.fn(() => ({ load: 0 })));
    stubPluginModuleLoaderJitiFactory(createJiti as unknown as PluginModuleLoaderFactory);

    await withMockedWindowsPlatform(async () => {
      const channelEntryContract = await importFreshModule<
        typeof import("./channel-entry-contract.js")
      >(import.meta.url, "./channel-entry-contract.js?scope=windows-dist-jiti");
      const tempRoot = tempDirs.make("openclaw-channel-entry-contract-");

      const pluginRoot = path.join(tempRoot, "dist", "extensions", "telegram");
      fs.mkdirSync(pluginRoot, { recursive: true });

      const importerPath = path.join(pluginRoot, "index.js");
      const helperPath = path.join(pluginRoot, "helper.cjs");
      fs.writeFileSync(importerPath, "export default {};\n", "utf8");
      fs.writeFileSync(helperPath, "module.exports = { load: 42 };\n", "utf8");

      expect(
        channelEntryContract.loadBundledEntryExportSync<number>(pathToFileURL(importerPath).href, {
          specifier: "./helper.cjs",
          exportName: "load",
        }),
      ).toBe(42);
      expect(createJiti).not.toHaveBeenCalled();
    });
  });

  it("normalizes Windows absolute sidecar paths before module loads them", async () => {
    const tempRoot = tempDirs.make("openclaw-channel-entry-contract-");
    const openedFdPath = path.join(tempRoot, "opened");
    fs.writeFileSync(openedFdPath, "opened\n", "utf8");
    const jitiLoad = vi.fn(() => ({ load: 42 }));
    const createJiti = vi.fn(() => jitiLoad);
    vi.doMock("../infra/boundary-file-read.js", () => ({
      openRootFileSync: () => ({
        ok: true,
        path: "C:\\Users\\alice\\openclaw\\dist\\extensions\\feishu\\helper.ts",
        fd: fs.openSync(openedFdPath, "r"),
      }),
    }));

    await withMockedWindowsPlatform(async () => {
      try {
        const channelEntryContract = await importFreshModule<
          typeof import("./channel-entry-contract.js")
        >(import.meta.url, "./channel-entry-contract.js?scope=windows-safe-jiti-path");

        expect(
          channelEntryContract.loadBundledEntryExportSync<number>(
            "file:///C:/Users/alice/openclaw/dist/extensions/feishu/index.js",
            {
              specifier: "./helper.ts",
              exportName: "load",
            },
            { createLoaderForTest: createJiti as never },
          ),
        ).toBe(42);
        expect(jitiLoad).toHaveBeenCalledWith(
          "file:///C:/Users/alice/openclaw/dist/extensions/feishu/helper.ts",
        );
      } finally {
        vi.doUnmock("../infra/boundary-file-read.js");
        vi.doUnmock("jiti");
      }
    });
  });

  it("transforms OpenClaw SDK dependencies after a native built sidecar load declines", async () => {
    const sourceLoad = vi.fn(() => ({ sentinel: 42 }));
    const createJiti = vi.fn((_filename: string, _options?: Record<string, unknown>) => sourceLoad);
    vi.doMock("../plugins/native-module-require.js", () => ({
      tryNativeRequireJavaScriptModule: vi.fn(() => ({ ok: false })),
    }));

    const channelEntryContract = await importFreshModule<
      typeof import("./channel-entry-contract.js")
    >(import.meta.url, "./channel-entry-contract.js?scope=native-esm-race-fallback");
    const tempRoot = fs.realpathSync(tempDirs.make("openclaw-channel-entry-contract-"));
    const pluginRoot = path.join(tempRoot, "dist", "extensions", "whatsapp");
    fs.mkdirSync(pluginRoot, { recursive: true });
    const importerPath = path.join(pluginRoot, "setup-entry.js");
    const sidecarPath = path.join(pluginRoot, "setup-plugin-api.js");
    fs.writeFileSync(importerPath, "export default {};\n", "utf8");
    fs.writeFileSync(sidecarPath, "export const sentinel = 42;\n", "utf8");

    expect(
      channelEntryContract.loadBundledEntryExportSync<number>(
        pathToFileURL(importerPath).href,
        {
          specifier: "./setup-plugin-api.js",
          exportName: "sentinel",
        },
        { createLoaderForTest: createJiti as never },
      ),
    ).toBe(42);
    const jitiOptions = createJiti.mock.calls[0]?.[1] as
      | { nativeModules?: string[]; tryNative?: boolean }
      | undefined;
    expect(jitiOptions?.tryNative).toBe(false);
    expect(jitiOptions?.nativeModules).toEqual([]);
    expect(sourceLoad).toHaveBeenCalledWith(sidecarPath);
  });

  it("loads packaged telegram setup sidecars from dist-facing api modules", () => {
    const tempRoot = tempDirs.make("openclaw-channel-entry-contract-");

    const pluginRoot = path.join(tempRoot, "dist", "extensions", "telegram");
    fs.mkdirSync(pluginRoot, { recursive: true });

    const importerPath = path.join(pluginRoot, "setup-entry.js");
    const setupApiPath = path.join(pluginRoot, "setup-plugin-api.js");
    const secretsApiPath = path.join(pluginRoot, "secret-contract-api.js");

    fs.writeFileSync(importerPath, "export default {};\n", "utf8");
    fs.writeFileSync(
      setupApiPath,
      'export const telegramSetupPlugin = { id: "telegram" };\n',
      "utf8",
    );
    fs.writeFileSync(
      secretsApiPath,
      [
        "export const collectRuntimeConfigAssignments = () => [];",
        "export const secretTargetRegistryEntries = [];",
        'export const channelSecrets = { TELEGRAM_TOKEN: { env: "TELEGRAM_TOKEN" } };',
        "",
      ].join("\n"),
      "utf8",
    );

    expect(
      loadBundledEntryExportSync<{ id: string }>(pathToFileURL(importerPath).href, {
        specifier: "./setup-plugin-api.js",
        exportName: "telegramSetupPlugin",
      }),
    ).toEqual({ id: "telegram" });

    expect(
      loadBundledEntryExportSync<Record<string, unknown>>(pathToFileURL(importerPath).href, {
        specifier: "./secret-contract-api.js",
        exportName: "channelSecrets",
      }),
    ).toEqual({
      TELEGRAM_TOKEN: {
        env: "TELEGRAM_TOKEN",
      },
    });
  });

  it("reuses resolved bundled sidecar paths before cached module exports", async () => {
    const tempRoot = tempDirs.make("openclaw-channel-entry-contract-");

    const pluginRoot = path.join(tempRoot, "dist", "extensions", "telegram");
    fs.mkdirSync(pluginRoot, { recursive: true });

    const importerPath = path.join(pluginRoot, "index.js");
    const helperPath = path.join(pluginRoot, "helper.cjs");
    fs.writeFileSync(importerPath, "export default {};\n", "utf8");
    fs.writeFileSync(helperPath, "module.exports = { sentinel: 42 };\n", "utf8");

    const openRootFileSync = vi.fn(() => ({
      ok: true,
      path: helperPath,
      fd: fs.openSync(helperPath, "r"),
    }));
    vi.doMock("../infra/boundary-file-read.js", () => ({
      openRootFileSync,
    }));

    try {
      const channelEntryContract = await importFreshModule<
        typeof import("./channel-entry-contract.js")
      >(import.meta.url, "./channel-entry-contract.js?scope=resolved-sidecar-cache");

      const ref = {
        specifier: "./helper.cjs",
        exportName: "sentinel",
      };
      expect(
        channelEntryContract.loadBundledEntryExportSync<number>(
          pathToFileURL(importerPath).href,
          ref,
        ),
      ).toBe(42);
      expect(
        channelEntryContract.loadBundledEntryExportSync<number>(
          pathToFileURL(importerPath).href,
          ref,
        ),
      ).toBe(42);
      expect(openRootFileSync).toHaveBeenCalledTimes(1);
    } finally {
      vi.doUnmock("../infra/boundary-file-read.js");
    }
  });

  it("emits non-negative source-loader sub-step timings on the built-artifact load path", async () => {
    // Built artifacts prefer `nodeRequire`, but Node can still reject a sidecar
    // and fall back through jiti. The profile line must never report negative
    // or missing source-loader sub-step timings either way.
    await expectBuiltArtifactNodeRequireFastPath("built-artifact-profile-fast-path");
  });

  it("keeps dist-runtime built sidecar loads on the nodeRequire fast-path", async () => {
    await expectBuiltArtifactNodeRequireFastPath("dist-runtime-profile-fast-path", "dist-runtime");
  });

  it("keeps compiled ESM sidecars with SDK imports on the nodeRequire fast-path", async () => {
    const result = compiledEsmSidecarFastPathResult;

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("adapter");
    expect(result.stderr).toMatch(/sourceLoaderCreateMs=0(?:\.0+)?(?:\s|$)/u);
    expect(result.stderr).toMatch(/sourceLoaderCallMs=0(?:\.0+)?(?:\s|$)/u);
  });

  it("can disable source-tree fallback for dist bundled entry checks", () => {
    stubPluginModuleLoaderJitiFactory(
      vi.fn(() => vi.fn(() => ({ sentinel: 42 }))) as unknown as PluginModuleLoaderFactory,
    );
    const tempRoot = tempDirs.make("openclaw-channel-entry-contract-");

    fs.writeFileSync(path.join(tempRoot, "package.json"), '{"name":"openclaw"}\n', "utf8");
    const pluginRoot = path.join(tempRoot, "dist", "extensions", "telegram");
    const sourceRoot = path.join(tempRoot, "extensions", "telegram", "src");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.mkdirSync(sourceRoot, { recursive: true });

    const importerPath = path.join(pluginRoot, "index.js");
    fs.writeFileSync(importerPath, "export default {};\n", "utf8");
    fs.writeFileSync(
      path.join(sourceRoot, "secret-contract.ts"),
      "export const sentinel = 42;\n",
      "utf8",
    );

    expect(
      loadBundledEntryExportSync<number>(pathToFileURL(importerPath).href, {
        specifier: "./src/secret-contract.js",
        exportName: "sentinel",
      }),
    ).toBe(42);

    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK", "1");

    expect(() =>
      loadBundledEntryExportSync<number>(pathToFileURL(importerPath).href, {
        specifier: "./src/secret-contract.js",
        exportName: "sentinel",
      }),
    ).toThrow(`resolved "${path.join(pluginRoot, "src", "secret-contract.js")}"`);
  });
});
