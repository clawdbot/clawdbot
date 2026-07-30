// Verifies graceful plugin init failure handling and reporting.
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const fixtureTempDirs: string[] = [];
const fixtureRoot = makeTrackedTempDir("openclaw-plugin-graceful", fixtureTempDirs);
let tempDirIndex = 0;
const { loadOpenClawPlugins, clearPluginLoaderCache } = await import("./loader.test-fixtures.js");

afterAll(() => {
  cleanupTrackedTempDirs(fixtureTempDirs);
});

function makeTempDir() {
  const dir = path.join(fixtureRoot, `case-${tempDirIndex++}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writePlugin(params: { id: string; body: string; dir?: string }): {
  id: string;
  file: string;
  dir: string;
} {
  const dir = params.dir ?? makeTempDir();
  fs.mkdirSync(dir, { recursive: true });
  const filename = `${params.id}.cjs`;
  const file = path.join(dir, filename);
  fs.writeFileSync(file, params.body, "utf-8");
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: params.id,
      name: params.id,
      version: "1.0.0",
      main: filename,
      configSchema: { type: "object" },
    }),
    "utf-8",
  );
  return { id: params.id, file, dir };
}

function readPluginId(pluginPath: string): string {
  const manifestPath = path.join(path.dirname(pluginPath), "openclaw.plugin.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { id: string };
  return manifest.id;
}

async function loadPlugins(pluginPaths: string[], warnings?: string[]) {
  clearPluginLoaderCache();
  const allow = pluginPaths.map((pluginPath) => readPluginId(pluginPath));
  return loadOpenClawPlugins({
    cache: false,
    config: {
      plugins: {
        enabled: true,
        load: { paths: pluginPaths },
        allow,
      },
    },
    installRecords: {},
    logger: {
      info: () => {},
      debug: () => {},
      error: () => {},
      warn: (message: string) => warnings?.push(message),
    },
    onlyPluginIds: allow,
    workspaceDir: fixtureRoot,
  });
}

type LoadedPluginRegistry = Awaited<ReturnType<typeof loadPlugins>>;
type LoadedPluginEntry = LoadedPluginRegistry["plugins"][number];

function requirePluginEntry(registry: LoadedPluginRegistry, pluginId: string): LoadedPluginEntry {
  const entry = registry.plugins.find((plugin) => plugin.id === pluginId);
  if (!entry) {
    throw new Error(`expected ${pluginId} registry entry`);
  }
  return entry;
}

function requireWarning(warnings: string[], text: string): string {
  const warning = warnings.find((candidate) => candidate.includes(text));
  if (!warning) {
    throw new Error(`expected warning containing ${text}`);
  }
  return warning;
}

describe("graceful plugin initialization failure", () => {
  it("marks plugin entry errored when register throws", async () => {
    const plugin = writePlugin({
      id: "throws-on-register",
      body: `module.exports = { id: "throws-on-register", register() { throw new Error("config schema mismatch"); } };`,
    });

    const registry = await loadPlugins([plugin.file]);
    expect(requirePluginEntry(registry, "throws-on-register").status).toBe("error");
  });

  it("keeps loading other plugins after one register failure", async () => {
    const failing = writePlugin({
      id: "plugin-fail",
      body: `module.exports = { id: "plugin-fail", register() { throw new Error("boom"); } };`,
    });
    const working = writePlugin({
      id: "plugin-ok",
      body: `module.exports = { id: "plugin-ok", register() {} };`,
    });

    const registry = await loadPlugins([failing.file, working.file]);

    expect(registry.plugins.find((plugin) => plugin.id === "plugin-ok")?.status).toBe("loaded");
  });

  it("records failed register metadata", async () => {
    const plugin = writePlugin({
      id: "register-error",
      body: `module.exports = { id: "register-error", register() { throw new Error("brutal config fail"); } };`,
    });

    const before = new Date();
    const registry = await loadPlugins([plugin.file]);
    const after = new Date();

    const failed = requirePluginEntry(registry, "register-error");
    expect(failed.status).toBe("error");
    expect(failed.failurePhase).toBe("register");
    expect(failed.error).toContain("brutal config fail");
    expect(failed.failedAt).toBeInstanceOf(Date);
    expect(failed.failedAt?.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(failed.failedAt?.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("rolls back partial metadata without breaking an earlier class-backed service", async () => {
    const stable = writePlugin({
      id: "a-stable-service-plugin",
      body: `class StableService {
        constructor() { this.id = "stable-service"; }
        start() {}
        ping() { return "still-alive"; }
      }
      module.exports = { id: "a-stable-service-plugin", register(api) {
        api.registerService(new StableService());
      } };`,
    });
    const failing = writePlugin({
      id: "z-partial-register-failure",
      body: `module.exports = { id: "z-partial-register-failure", register(api) {
        api.registerService({ id: "failed-service", start() {} });
        api.registerHttpRoute({ path: "/failed", auth: "plugin", handler: async () => true });
        throw new Error("fail after partial registration");
      } };`,
    });

    const registry = await loadPlugins([stable.file, failing.file]);
    const failed = requirePluginEntry(registry, "z-partial-register-failure");
    const stableService = registry.services.find((entry) => entry.service.id === "stable-service")
      ?.service as { ping?: () => string } | undefined;

    expect(failed.status).toBe("error");
    expect(failed.services).toEqual([]);
    expect(failed.httpRoutes).toBe(0);
    expect(registry.services.map((entry) => entry.service.id)).toEqual(["stable-service"]);
    expect(registry.httpRoutes).toEqual([]);
    expect(stableService?.ping?.()).toBe("still-alive");
  });

  it("records validation failures before register", async () => {
    const plugin = writePlugin({
      id: "missing-register",
      body: `module.exports = { id: "missing-register" };`,
    });

    const registry = await loadPlugins([plugin.file]);
    const failed = registry.plugins.find((entry) => entry.id === "missing-register");

    expect(failed?.status).toBe("error");
    expect(failed?.failurePhase).toBe("validation");
    expect(failed?.error).toBe("plugin export missing register/activate");
  });

  it("logs a startup summary grouped by failure phase", async () => {
    const registerFailure = writePlugin({
      id: "warn-register",
      body: `module.exports = { id: "warn-register", register() { throw new Error("bad config"); } };`,
    });
    const validationFailure = writePlugin({
      id: "warn-validation",
      body: `module.exports = { id: "warn-validation" };`,
    });

    const warnings: string[] = [];
    await loadPlugins([registerFailure.file, validationFailure.file], warnings);

    const summary = requireWarning(warnings, "failed to initialize");
    expect(summary).toContain("register: warn-register");
    expect(summary).toContain("validation: warn-validation");
    expect(summary).toContain("openclaw plugins inspect <id> --runtime --json");
    expect(summary).toContain("openclaw plugins list");
  });
});
