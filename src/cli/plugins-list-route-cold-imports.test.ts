// The default plugin inventory route must render manifest facts without executing plugin code.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";

const testState = vi.hoisted(() => ({
  config: {} as OpenClawConfig,
  loadedModules: new Set<string>(),
  logs: [] as string[],
}));

vi.mock("./command-execution-startup.js", () => ({
  applyCliExecutionStartupPresentation: vi.fn(async () => {}),
  ensureCliExecutionBootstrap: vi.fn(async () => {}),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => testState.config,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    error: vi.fn(),
    exit: vi.fn(),
    log: (...args: unknown[]) => testState.logs.push(args.map(String).join(" ")),
    writeJson: vi.fn(),
    writeStdout: vi.fn(),
  },
  writeRuntimeJson: vi.fn(),
}));

vi.mock("./plugins-cli.js", () => {
  testState.loadedModules.add("plugins-cli");
  return { registerPluginsCli: vi.fn() };
});

vi.mock("../plugins/loader-module-runtime.js", () => {
  testState.loadedModules.add("plugin-module-runtime");
  return {};
});

vi.mock("../plugins/capability-consent.js", () => {
  throw new Error("metadata inventory must not load the capability consent mutation owner");
});

import { tryRouteCli } from "./route.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugins-list-route-"));

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("renders the default list from metadata without loading plugin modules", async () => {
  const pluginRoot = path.join(tempRoot, "route-demo");
  fs.mkdirSync(pluginRoot, { recursive: true });
  const fixture = createColdPluginFixture({
    rootDir: pluginRoot,
    pluginId: "route-demo",
    packageName: "@example/route-demo",
    packageVersion: "4.2.0",
    manifest: {
      name: "Route Demo",
      description: "Prepared inventory metadata",
    },
  });
  const bundledRoot = path.join(tempRoot, "bundled");
  fs.mkdirSync(bundledRoot, { recursive: true });
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", bundledRoot);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  vi.stubEnv("OPENCLAW_HOME", path.join(tempRoot, "home"));
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(tempRoot, "state"));
  testState.config = {
    plugins: {
      load: { paths: [pluginRoot] },
      entries: { "route-demo": { enabled: true } },
    },
  };

  await expect(tryRouteCli(["node", "openclaw", "plugins", "list"])).resolves.toBe(true);

  const output = testState.logs.join("\n");
  expect(output).toContain("Route Demo");
  expect(output).toContain("route-demo");
  expect(output).toContain("Prepared inventory metadata");
  expect(output).toContain("4.2.0");
  expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
  expect(testState.loadedModules).not.toContain("plugin-module-runtime");
  expect(testState.loadedModules).not.toContain("plugins-cli");
});
