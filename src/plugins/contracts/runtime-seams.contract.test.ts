import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";
import { TEST_UNDICI_RUNTIME_DEPS_KEY } from "../../infra/net/undici-runtime.js";
import * as activationCheck from "../../plugin-sdk/facade-activation-check.runtime.js";
import * as facadeRuntime from "../../plugin-sdk/facade-runtime.js";

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: ({ config }: { config?: unknown }) => ({
    config: config ?? {},
    autoEnabledReasons: {},
  }),
}));

const originalBundledPluginsDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const originalGlobalFetch = globalThis.fetch;
const tempDirs: string[] = [];

function createInstalledRuntimePluginDir(
  pluginId: string,
  marker: string,
): {
  bundledDir: string;
  stateDir: string;
  pluginRoot: string;
} {
  const bundledDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `openclaw-runtime-contract-bundled-${pluginId}-`),
  );
  const stateDir = fs.mkdtempSync(
    path.join(os.tmpdir(), `openclaw-runtime-contract-state-${pluginId}-`),
  );
  tempDirs.push(bundledDir, stateDir);
  const pluginRoot = path.join(stateDir, "extensions", pluginId);
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, "runtime-api.js"),
    `export const marker = ${JSON.stringify(marker)};\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "package.json"),
    JSON.stringify({
      name: `@openclaw/${pluginId}`,
      version: "0.0.0",
      openclaw: {
        extensions: ["./runtime-api.js"],
        channel: { id: pluginId },
      },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      channels: [pluginId],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
    "utf8",
  );
  return {
    bundledDir,
    stateDir,
    pluginRoot,
  };
}

afterEach(() => {
  clearRuntimeConfigSnapshot();
  facadeRuntime.resetFacadeRuntimeStateForTest();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis as object, TEST_UNDICI_RUNTIME_DEPS_KEY);
  if (originalBundledPluginsDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
  } else {
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledPluginsDir;
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  if (originalGlobalFetch) {
    (globalThis as Record<string, unknown>).fetch = originalGlobalFetch;
  } else {
    Reflect.deleteProperty(globalThis as object, "fetch");
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("shared runtime seam contracts", () => {
  it("allows activated runtime facades when the resolved plugin root matches an installed-style manifest record", async () => {
    const pluginId = "line-contract-fixture";
    const { bundledDir, stateDir, pluginRoot } = createInstalledRuntimePluginDir(
      pluginId,
      "line-ok",
    );
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledDir;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    setRuntimeConfigSnapshot({
      plugins: {
        entries: {
          [pluginId]: {
            enabled: true,
          },
        },
      },
    });
    facadeRuntime.resetFacadeRuntimeStateForTest();

    const location = {
      modulePath: path.join(pluginRoot, "runtime-api.js"),
      boundaryRoot: pluginRoot,
    };
    expect(
      activationCheck.resolveBundledPluginPublicSurfaceAccess({
        dirName: pluginId,
        artifactBasename: "runtime-api.js",
        location,
        sourceExtensionsRoot: bundledDir,
        resolutionKey: `test:${pluginId}`,
      }).allowed,
    ).toBe(true);
    expect(
      facadeRuntime.__testing.loadFacadeModuleAtLocationSync<{ marker: string }>({
        location,
        trackedPluginId: pluginId,
      }).marker,
    ).toBe("line-ok");
    expect(facadeRuntime.listImportedBundledPluginFacadeIds()).toEqual([pluginId]);
  });

  it("keeps guarded fetch on mocked global fetches even when a dispatcher is attached", async () => {
    class MockAgent {
      constructor(readonly options: unknown) {}
    }
    class MockEnvHttpProxyAgent {
      constructor(readonly options: unknown) {}
    }
    class MockProxyAgent {
      constructor(readonly options: unknown) {}
    }

    const runtimeFetch = vi.fn(async () => new Response("runtime", { status: 200 }));
    const globalFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const requestInit = init as RequestInit & { dispatcher?: unknown };
      expect(requestInit.dispatcher).toBeInstanceOf(MockAgent);
      return new Response("mock", { status: 200 });
    });

    (globalThis as Record<string, unknown>).fetch = globalFetch as typeof fetch;
    (globalThis as Record<string, unknown>)[TEST_UNDICI_RUNTIME_DEPS_KEY] = {
      Agent: MockAgent,
      EnvHttpProxyAgent: MockEnvHttpProxyAgent,
      ProxyAgent: MockProxyAgent,
      fetch: runtimeFetch,
    };

    const lookupFn = vi.fn(
      async () => ({ address: "93.184.216.34", family: 4 }) as const,
    ) as unknown as NonNullable<Parameters<typeof fetchWithSsrFGuard>[0]["lookupFn"]>;

    const result = await fetchWithSsrFGuard({
      url: "https://public.example/resource",
      lookupFn,
    });

    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(runtimeFetch).not.toHaveBeenCalled();
    expect(await result.response.text()).toBe("mock");
    await result.release();
  });
});
