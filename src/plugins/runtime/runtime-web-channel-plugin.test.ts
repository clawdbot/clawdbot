// Runtime web-channel plugin tests cover web channel plugin activation and runtime behavior.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";

const tempDirs = createTempDirTracker();

afterEach(() => {
  tempDirs.cleanup();
  vi.doUnmock("./runtime-plugin-boundary.js");
  vi.resetModules();
});

describe("runtime web channel plugin", () => {
  it("resolves the default auth dir through the light runtime on each call", async () => {
    let authDir = "/tmp/openclaw-default-auth";
    const resolveDefaultWebAuthDir = vi.fn(() => authDir);
    const resolvePluginRuntimeRecordByEntryBaseNames = vi.fn(() => ({
      origin: "bundled",
      source: "test",
    }));

    vi.doMock("./runtime-plugin-boundary.js", () => ({
      loadPluginBoundaryModule: () => ({ resolveDefaultWebAuthDir }),
      resolvePluginRuntimeModulePath: () => "/tmp/light-runtime-api.js",
      resolvePluginRuntimeRecordByEntryBaseNames,
    }));

    const { resolveWebChannelAuthDir } = await import("./runtime-web-channel-plugin.js");

    expect(resolveWebChannelAuthDir()).toBe("/tmp/openclaw-default-auth");
    authDir = "/tmp/openclaw-profile-auth";
    expect(resolveWebChannelAuthDir()).toBe("/tmp/openclaw-profile-auth");
    expect(resolveDefaultWebAuthDir).toHaveBeenCalledTimes(2);
    expect(resolvePluginRuntimeRecordByEntryBaseNames).toHaveBeenCalledOnce();
  });

  it("reuses the prepared heavy runtime before resolving plugin metadata again", async () => {
    const extractText = vi.fn((value: string) => value);
    const startWebLoginWithQr = vi.fn(async () => "started");
    const resolvePluginRuntimeRecordByEntryBaseNames = vi.fn(() => ({
      origin: "bundled",
      source: "test",
    }));
    vi.doMock("./runtime-plugin-boundary.js", () => ({
      loadPluginBoundaryModule: () => ({ extractText, startWebLoginWithQr }),
      resolvePluginRuntimeModulePath: () => "/tmp/runtime-api.js",
      resolvePluginRuntimeRecordByEntryBaseNames,
    }));

    const runtime = await import("./runtime-web-channel-plugin.js");

    expect(runtime.extractText("first")).toBe("first");
    expect(runtime.extractText("second")).toBe("second");
    await expect(runtime.startWebLoginWithQr()).resolves.toBe("started");
    expect(resolvePluginRuntimeRecordByEntryBaseNames).toHaveBeenCalledOnce();
  });

  it("shares one plugin record across light and heavy runtime activation", async () => {
    const resolvePluginRuntimeRecordByEntryBaseNames = vi.fn(() => ({
      origin: "bundled",
      source: "test",
    }));
    vi.doMock("./runtime-plugin-boundary.js", () => ({
      loadPluginBoundaryModule: (modulePath: string) =>
        modulePath.includes("light-runtime-api")
          ? { resolveDefaultWebAuthDir: () => "/tmp/openclaw-auth" }
          : { startWebLoginWithQr: async () => "started" },
      resolvePluginRuntimeModulePath: (_record: unknown, entryBaseName: string) =>
        `/tmp/${entryBaseName}.js`,
      resolvePluginRuntimeRecordByEntryBaseNames,
    }));

    const runtime = await import("./runtime-web-channel-plugin.js");

    expect(runtime.resolveWebChannelAuthDir()).toBe("/tmp/openclaw-auth");
    await expect(runtime.startWebLoginWithQr()).resolves.toBe("started");
    expect(resolvePluginRuntimeRecordByEntryBaseNames).toHaveBeenCalledOnce();

    const { clearPluginMetadataLifecycleCaches } = await import("../plugin-metadata-lifecycle.js");
    clearPluginMetadataLifecycleCaches();
    expect(runtime.resolveWebChannelAuthDir()).toBe("/tmp/openclaw-auth");
    expect(resolvePluginRuntimeRecordByEntryBaseNames).toHaveBeenCalledTimes(2);
  });

  it.each(["light", "heavy"] as const)(
    "reloads replaced %s runtime artifacts and dependencies after plugin lifecycle clears",
    async (kind) => {
      const pluginRoot = fs.realpathSync(tempDirs.make("openclaw-web-runtime-replacement-"));
      const modulePath = path.join(
        pluginRoot,
        kind === "light" ? "light-runtime-api.js" : "runtime-api.js",
      );
      const dependencyPath = path.join(pluginRoot, "dependency.js");
      fs.writeFileSync(path.join(pluginRoot, "package.json"), '{"type":"commonjs"}\n', "utf8");

      const writeRuntime = (marker: string) => {
        fs.writeFileSync(dependencyPath, `module.exports = ${JSON.stringify(marker)};\n`, "utf8");
        const exportName = kind === "light" ? "resolveDefaultWebAuthDir" : "startWebLoginWithQr";
        fs.writeFileSync(
          modulePath,
          `module.exports = { ${exportName}: () => ${JSON.stringify(marker)} + ":" + require("./dependency.js") };\n`,
          "utf8",
        );
      };
      writeRuntime("retired");

      vi.doMock("./runtime-plugin-boundary.js", async (importOriginal) => ({
        ...(await importOriginal<typeof import("./runtime-plugin-boundary.js")>()),
        resolvePluginRuntimeRecordByEntryBaseNames: () => ({
          origin: "global",
          rootDir: pluginRoot,
          source: path.join(pluginRoot, "index.js"),
        }),
        resolvePluginRuntimeModulePath: () => modulePath,
      }));

      const runtime = await import("./runtime-web-channel-plugin.js");
      const { clearPluginMetadataLifecycleCaches } =
        await import("../plugin-metadata-lifecycle.js");
      const invoke = () =>
        kind === "light"
          ? Promise.resolve(runtime.resolveWebChannelAuthDir())
          : runtime.startWebLoginWithQr();

      await expect(invoke()).resolves.toBe("retired:retired");
      writeRuntime("replacement");
      await expect(invoke()).resolves.toBe("retired:retired");

      clearPluginMetadataLifecycleCaches();

      await expect(invoke()).resolves.toBe("replacement:replacement");
      await expect(invoke()).resolves.toBe("replacement:replacement");
    },
  );

  it("reports heavy runtime load failures as promise rejections", async () => {
    vi.doMock("./runtime-plugin-boundary.js", () => ({
      loadPluginBoundaryModule: () => {
        throw new Error("runtime unavailable");
      },
      resolvePluginRuntimeModulePath: () => "/tmp/runtime-api.js",
      resolvePluginRuntimeRecordByEntryBaseNames: () => ({
        origin: "bundled",
        source: "test",
      }),
    }));
    const runtime = await import("./runtime-web-channel-plugin.js");

    await expect(runtime.loginWeb(false)).rejects.toThrow("runtime unavailable");
    await expect(runtime.monitorWebChannel()).rejects.toThrow("runtime unavailable");
  });

  it("falls back to the older WhatsApp light runtime auth dir export", async () => {
    vi.doMock("./runtime-plugin-boundary.js", () => ({
      loadPluginBoundaryModule: () => ({ WA_WEB_AUTH_DIR: "/tmp/openclaw-legacy-auth" }),
      resolvePluginRuntimeModulePath: () => "/tmp/light-runtime-api.js",
      resolvePluginRuntimeRecordByEntryBaseNames: () => ({
        origin: "external",
        source: "test",
      }),
    }));

    const { resolveWebChannelAuthDir } = await import("./runtime-web-channel-plugin.js");

    expect(resolveWebChannelAuthDir()).toBe("/tmp/openclaw-legacy-auth");
  });

  it("rejects non-string legacy auth dir exports", async () => {
    vi.doMock("./runtime-plugin-boundary.js", () => ({
      loadPluginBoundaryModule: () => ({
        WA_WEB_AUTH_DIR: Object("/tmp/openclaw-string-object-auth"),
      }),
      resolvePluginRuntimeModulePath: () => "/tmp/light-runtime-api.js",
      resolvePluginRuntimeRecordByEntryBaseNames: () => ({
        origin: "external",
        source: "test",
      }),
    }));

    const { resolveWebChannelAuthDir } = await import("./runtime-web-channel-plugin.js");

    expect(() => resolveWebChannelAuthDir()).toThrow(
      "web channel plugin runtime is missing export 'resolveDefaultWebAuthDir'",
    );
  });
});
