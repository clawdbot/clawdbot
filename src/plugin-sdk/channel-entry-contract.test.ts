import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.ts";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { OpenClawPluginApi, PluginRegistrationMode } from "../plugins/types.js";
import { defineBundledChannelEntry, loadBundledEntryExportSync } from "./channel-entry-contract.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  vi.resetModules();
  vi.doUnmock("jiti");
  vi.unstubAllEnvs();
});

function createApi(registrationMode: PluginRegistrationMode): OpenClawPluginApi {
  return {
    registrationMode,
    runtime: { registrationMode } as unknown as PluginRuntime,
    registerChannel: vi.fn(),
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
  it("keeps runtime sidecars out of discovery registration", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-entry-runtime-"));
    tempDirs.push(tempRoot);
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
    expect(fs.existsSync(runtimeMarker)).toBe(false);
  });

  it("keeps setup-runtime and full registration wired to runtime sidecars", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bundled-entry-runtime-"));
    tempDirs.push(tempRoot);
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

async function expectBuiltArtifactNodeRequireFastPath(
  scope: string,
  artifactRoot = "dist",
): Promise<void> {
  vi.stubEnv("OPENCLAW_PLUGIN_LOAD_PROFILE", "1");
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

  try {
    const channelEntryContract = await importFreshModule<
      typeof import("./channel-entry-contract.js")
    >(import.meta.url, `./channel-entry-contract.js?scope=${scope}`);

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-entry-contract-"));
    tempDirs.push(tempRoot);

    const pluginRoot = path.join(tempRoot, artifactRoot, "extensions", "telegram");
    fs.mkdirSync(pluginRoot, { recursive: true });

    const importerPath = path.join(pluginRoot, "index.js");
    const sidecarPath = path.join(pluginRoot, "fast-path-sidecar.js");
    fs.writeFileSync(importerPath, "export default {};\n", "utf8");
    // CommonJS so `nodeRequire` succeeds without falling back to jiti.
    fs.writeFileSync(sidecarPath, "module.exports = { sentinel: 7 };\n", "utf8");

    expect(
      channelEntryContract.loadBundledEntryExportSync<number>(pathToFileURL(importerPath).href, {
        specifier: "./fast-path-sidecar.js",
        exportName: "sentinel",
      }),
    ).toBe(7);

    const profileLine = errorSpy.mock.calls
      .map((args) => String(args[0] ?? ""))
      .find((line) => line.startsWith("[plugin-load-profile] phase=bundled-entry-module-load"));
    expect(profileLine, "expected a bundled-entry-module-load profile line").toBeDefined();
    expect(profileLine).toContain("getJitiMs=0.0");
    expect(profileLine).toContain("jitiCallMs=0.0");
    expect(profileLine).not.toMatch(/getJitiMs=-/);
    expect(profileLine).not.toMatch(/jitiCallMs=-/);
  } finally {
    errorSpy.mockRestore();
  }
}

describe("loadBundledEntryExportSync", () => {
  it("includes importer and resolved path context when a bundled sidecar is missing", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-entry-contract-"));
    tempDirs.push(tempRoot);

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

  it("keeps Windows dist sidecar loads off Jiti native import", async () => {
    const createJiti = vi.fn(() => vi.fn(() => ({ load: 42 })));
    vi.doMock("jiti", () => ({
      createJiti,
    }));
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");

    try {
      const channelEntryContract = await importFreshModule<
        typeof import("./channel-entry-contract.js")
      >(import.meta.url, "./channel-entry-contract.js?scope=windows-dist-jiti");
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-entry-contract-"));
      tempDirs.push(tempRoot);

      const pluginRoot = path.join(tempRoot, "dist", "extensions", "telegram");
      fs.mkdirSync(pluginRoot, { recursive: true });

      const importerPath = path.join(pluginRoot, "index.js");
      const helperPath = path.join(pluginRoot, "helper.ts");
      fs.writeFileSync(importerPath, "export default {};\n", "utf8");
      fs.writeFileSync(helperPath, "export const load = 42;\n", "utf8");

      expect(
        channelEntryContract.loadBundledEntryExportSync<number>(pathToFileURL(importerPath).href, {
          specifier: "./helper.ts",
          exportName: "load",
        }),
      ).toBe(42);
      expect(createJiti).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          tryNative: false,
        }),
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("loads packaged telegram setup sidecars from dist-facing api modules", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-entry-contract-"));
    tempDirs.push(tempRoot);

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

  it("emits zero jiti sub-step timings on the built-artifact nodeRequire fast-path", async () => {
    // The built-artifact fast-path goes through `nodeRequire` directly and never
    // touches jiti. The plugin-load-profile line must reflect that with
    // `getJitiMs=0.0 jitiCallMs=0.0` rather than negative or full-elapsed
    // values that would mis-attribute nodeRequire time to jiti sub-steps.
    await expectBuiltArtifactNodeRequireFastPath("built-artifact-profile-fast-path");
  });

  it("keeps dist-runtime built sidecar loads on the nodeRequire fast-path", async () => {
    await expectBuiltArtifactNodeRequireFastPath("dist-runtime-profile-fast-path", "dist-runtime");
  });

  it("can disable source-tree fallback for dist bundled entry checks", () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-entry-contract-"));
    tempDirs.push(tempRoot);

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
