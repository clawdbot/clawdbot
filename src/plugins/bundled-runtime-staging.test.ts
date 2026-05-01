import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundledRuntimeDepsInstallParams } from "./bundled-runtime-deps-install.js";
import { resolveBundledRuntimeDependencyInstallRoot } from "./bundled-runtime-deps-roots.js";
import { clearPreparedBundledPluginRuntimeLoadRoots } from "./bundled-runtime-root.js";
import { prepareBundledRuntimeLoadRootForPlugin } from "./bundled-runtime-staging.js";
import { writeBundledPluginRuntimeDepsPackage } from "./test-helpers/bundled-runtime-deps-fixtures.js";
import type { PluginLogger } from "./types.js";

const mocks = vi.hoisted(() => ({
  installBundledRuntimeDeps: vi.fn(),
}));

vi.mock("./bundled-runtime-deps-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bundled-runtime-deps-install.js")>()),
  installBundledRuntimeDeps: mocks.installBundledRuntimeDeps,
}));

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-staging-test-"));
  tempRoots.push(root);
  return root;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createLogger(): PluginLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as PluginLogger;
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.installBundledRuntimeDeps.mockReset();
  clearPreparedBundledPluginRuntimeLoadRoots();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("prepareBundledRuntimeLoadRootForPlugin", () => {
  it("forces sync package-manager repair after writing the generated install manifest", () => {
    const packageRoot = makeTempRoot();
    const stageDir = makeTempRoot();
    const pluginRoot = path.join(packageRoot, "dist", "extensions", "telegram");
    const modulePath = path.join(pluginRoot, "index.js");
    const env = { ...process.env, OPENCLAW_PLUGIN_STAGE_DIR: stageDir };
    writeJson(path.join(packageRoot, "package.json"), {
      name: "openclaw",
      version: "2026.4.30",
      type: "module",
    });
    writeBundledPluginRuntimeDepsPackage({
      packageRoot,
      pluginId: "telegram",
      deps: { "telegram-runtime": "1.0.0" },
      enabledByDefault: true,
    });
    fs.writeFileSync(modulePath, "export {};\n", "utf8");
    const installRoot = resolveBundledRuntimeDependencyInstallRoot(pluginRoot, { env });
    writeJson(path.join(installRoot, "node_modules", "telegram-runtime", "package.json"), {
      name: "telegram-runtime",
      version: "1.0.0",
    });
    mocks.installBundledRuntimeDeps.mockImplementation(
      (params: BundledRuntimeDepsInstallParams) => {
        expect(fs.existsSync(path.join(params.installRoot, "package.json"))).toBe(true);
      },
    );

    prepareBundledRuntimeLoadRootForPlugin({
      pluginId: "telegram",
      pluginRoot,
      modulePath,
      env,
      config: {} as OpenClawConfig,
      installMissingDeps: true,
      shouldLog: false,
      logger: createLogger(),
    });

    expect(mocks.installBundledRuntimeDeps).toHaveBeenCalledWith(
      expect.objectContaining({
        installRoot,
        missingSpecs: ["telegram-runtime@1.0.0"],
        installSpecs: ["telegram-runtime@1.0.0"],
        force: true,
      }),
    );
  });
});
