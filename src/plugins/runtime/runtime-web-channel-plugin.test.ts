// Runtime web-channel plugin tests cover the public monitor facade and plugin lifecycle.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";

const tempDirs = createTempDirTracker();

afterEach(async () => {
  const { clearPluginMetadataLifecycleCaches } = await import("../plugin-metadata-lifecycle.js");
  clearPluginMetadataLifecycleCaches();
  tempDirs.cleanup();
  vi.doUnmock("./runtime-plugin-boundary.js");
  vi.resetModules();
});

describe("runtime web channel plugin", () => {
  it("forwards library monitor calls lazily with exact arguments and runtime receiver", async () => {
    const result = { marker: "complete" };
    const monitorWebChannel = vi.fn(async (..._args: unknown[]) => result);
    const runtimeModule = { monitorWebChannel };
    const loadPluginBoundaryModule = vi.fn(() => runtimeModule);
    vi.doMock("./runtime-plugin-boundary.js", () => ({
      loadPluginBoundaryModule,
      resolvePluginRuntimeModulePath: () => "/tmp/runtime-api.js",
      resolvePluginRuntimeRecordByEntryBaseNames: () => ({
        origin: "bundled",
        source: "test",
      }),
    }));

    const library = await import("../../library.js");
    expect(loadPluginBoundaryModule).not.toHaveBeenCalled();
    const args = [
      true,
      vi.fn(),
      false,
      vi.fn(),
      { log: vi.fn() },
      new AbortController().signal,
      { accountId: "work" },
    ];
    await expect(library.monitorWebChannel(...args)).resolves.toBe(result);
    expect(monitorWebChannel).toHaveBeenCalledOnce();
    expect(monitorWebChannel.mock.contexts[0]).toBe(runtimeModule);
    const [receivedArgs] = monitorWebChannel.mock.calls;
    expect(receivedArgs).toHaveLength(args.length);
    for (const [index, arg] of args.entries()) {
      expect(receivedArgs?.[index]).toBe(arg);
    }

    const monitorError = new Error("monitor failed");
    monitorWebChannel.mockRejectedValueOnce(monitorError);
    await expect(library.monitorWebChannel(...args)).rejects.toBe(monitorError);
  });

  it("reloads replaced monitor artifacts and dependencies after plugin lifecycle clears", async () => {
    const pluginRoot = fs.realpathSync(tempDirs.make("openclaw-web-runtime-replacement-"));
    const modulePath = path.join(pluginRoot, "runtime-api.js");
    const dependencyPath = path.join(pluginRoot, "dependency.js");
    fs.writeFileSync(path.join(pluginRoot, "package.json"), '{"type":"commonjs"}\n', "utf8");

    const writeRuntime = (marker: string) => {
      fs.writeFileSync(dependencyPath, `module.exports = ${JSON.stringify(marker)};\n`, "utf8");
      fs.writeFileSync(
        modulePath,
        `module.exports = { monitorWebChannel: () => ${JSON.stringify(marker)} + ":" + require("./dependency.js") };\n`,
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
    const { clearPluginMetadataLifecycleCaches } = await import("../plugin-metadata-lifecycle.js");
    await expect(runtime.monitorWebChannel()).resolves.toBe("retired:retired");
    writeRuntime("replacement");
    await expect(runtime.monitorWebChannel()).resolves.toBe("retired:retired");

    clearPluginMetadataLifecycleCaches();

    await expect(runtime.monitorWebChannel()).resolves.toBe("replacement:replacement");
    await expect(runtime.monitorWebChannel()).resolves.toBe("replacement:replacement");
  });

  it("reports heavy runtime load failures as promise rejections", async () => {
    const loadError = new Error("runtime unavailable");
    const loadPluginBoundaryModule = vi.fn(() => {
      throw loadError;
    });
    vi.doMock("./runtime-plugin-boundary.js", () => ({
      loadPluginBoundaryModule,
      resolvePluginRuntimeModulePath: () => "/tmp/runtime-api.js",
      resolvePluginRuntimeRecordByEntryBaseNames: () => ({
        origin: "bundled",
        source: "test",
      }),
    }));
    const runtime = await import("./runtime-web-channel-plugin.js");

    expect(loadPluginBoundaryModule).not.toHaveBeenCalled();
    await expect(runtime.monitorWebChannel()).rejects.toBe(loadError);
  });
});
