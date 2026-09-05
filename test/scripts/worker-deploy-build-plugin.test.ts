import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkerDeployBuildPlugin,
  WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID,
} from "../../scripts/lib/worker-deploy-build-plugin.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const fail = (message: string): never => {
  throw new Error(message);
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("worker deploy build plugin", () => {
  it("replaces optional host-native modules with a failing virtual module", () => {
    const plugin = createWorkerDeployBuildPlugin();

    expect(plugin.load(WORKER_DEPLOY_OPTIONAL_NATIVE_MODULE_ID)).toContain(
      "optional host-native dependency unavailable",
    );
  });

  it("initializes the composed Browser runtime only when its factory is called", async () => {
    const bridgePath = path.resolve("src/worker/worker-deploy-browser-runtime.ts");
    const source = fs.readFileSync(bridgePath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    const transformed = plugin.transform.call({ error: fail }, source, bridgePath);

    const root = tempDirs.make("openclaw-worker-browser-composition-");
    const outputPath = path.join(root, "src/worker/browser.mjs");
    const runtimePath = path.join(root, "extensions/browser/runtime-api.js");
    const eventsPath = path.join(root, "events.txt");
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
    fs.writeFileSync(outputPath, transformed!);
    fs.writeFileSync(
      runtimePath,
      `import { appendFileSync } from "node:fs";
const record = event => appendFileSync(${JSON.stringify(eventsPath)}, event + "\\n");
record("initialized");
export async function createAttachedBrowserToolRuntime(params) {
  await params.ensureAttachTarget();
  return { tool: params, dispose: async () => record("disposed") };
}`,
    );

    const { default: browser } = await import(pathToFileURL(outputPath).href);
    expect(fs.existsSync(eventsPath)).toBe(false);
    let attached = 0;
    const params = {
      cdpUrl: "http://127.0.0.1:9222",
      ensureAttachTarget: async () => {
        attached += 1;
      },
      agentSessionKey: "worker:session-1",
      agentDir: path.join(root, "agent"),
      workspaceDir: path.join(root, "workspace"),
    };
    const [first, second] = await Promise.all([
      browser.createAttachedBrowserToolRuntime(params),
      browser.createAttachedBrowserToolRuntime(params),
    ]);
    expect(attached).toBe(2);
    expect(first.tool).toBe(params);
    expect(second.tool).toBe(params);
    expect(fs.readFileSync(eventsPath, "utf8")).toBe("initialized\n");
    await first.dispose();
    await second.dispose();
    expect(fs.readFileSync(eventsPath, "utf8")).toBe("initialized\ndisposed\ndisposed\n");
  });

  it("binds the lazy Playwright accessor to bundled modules", () => {
    const runtimePath = path.resolve("extensions/browser/src/browser/playwright-core.runtime.ts");
    const source = fs.readFileSync(runtimePath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    const transformed = plugin.transform.call({ error: fail }, source, runtimePath);

    expect(transformed).toContain('import * as playwrightCore from "playwright-core";');
    expect(transformed).toContain('import { getUserAgent } from "playwright-core/lib/coreBundle";');
    expect(transformed).toContain("return playwrightCore;");
    expect(transformed).not.toContain("createRequire");
    expect(transformed).not.toContain('require("playwright-core")');
  });

  it("bundles the undici dispatcher dependency without a worker runtime require", () => {
    const dispatcherPath = path.resolve("src/infra/net/undici-dispatcher-options.ts");
    const source = fs.readFileSync(dispatcherPath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    const transformed = plugin.transform.call({ error: fail }, source, dispatcherPath);

    expect(transformed).toContain('import * as bundledUndici from "undici";');
    expect(transformed).toContain("return bundledUndici;");
    expect(transformed).toContain('return override as typeof import("undici");');
    expect(transformed).not.toContain('import { createRequire } from "node:module";');
    expect(transformed).not.toContain("const requireUndici = createRequire(import.meta.url);");
    expect(transformed).not.toContain('requireUndici("undici")');
  });

  it("leaves fs-safe native package resolution to the dependency", () => {
    const nativePath = path.resolve("node_modules/@openclaw/fs-safe/dist/native.js");
    const source = fs.readFileSync(nativePath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    const transformed = plugin.transform.call({ error: fail }, source, nativePath);

    expect(transformed).toBeNull();
  });

  it("fails closed when the undici dispatcher bootstrap shape changes", () => {
    const dispatcherPath = path.resolve("src/infra/net/undici-dispatcher-options.ts");
    const source = fs.readFileSync(dispatcherPath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    expect(() =>
      plugin.transform.call(
        { error: fail },
        source.replace('return requireUndici("undici")', 'return changedUndici("undici")'),
        dispatcherPath,
      ),
    ).toThrow("undici dispatcher bootstrap changed");
  });

  it("inlines Playwright package identity without a runtime manifest read", () => {
    const coreBundlePath = path.resolve("node_modules/playwright-core/lib/coreBundle.js");
    const source = fs.readFileSync(coreBundlePath, "utf8");
    const plugin = createWorkerDeployBuildPlugin();

    const transformed = plugin.transform.call({ error: fail }, source, coreBundlePath);

    expect(transformed).toContain('packageJSON = {"name":"playwright-core","version":"1.62.1"};');
    expect(transformed).not.toContain(
      'packageJSON = require(import_path9.default.join(packageRoot, "package.json"));',
    );
    expect(transformed).toContain(
      'registry = new Registry({"comment":"Do not edit this file, use utils/roll_browser.js"',
    );
    expect(transformed).not.toContain(
      'registry = new Registry(require(import_path20.default.join(packageRoot, "browsers.json")));',
    );
  });

  it("matches the canonical dependency path behind a pnpm-style symlink", () => {
    const sourceRoot = path.resolve("node_modules/playwright-core");
    const source = fs.readFileSync(path.join(sourceRoot, "lib/coreBundle.js"), "utf8");
    const tempRoot = tempDirs.make("openclaw-worker-build-plugin-");
    const linkedRoot = path.join(tempRoot, "node_modules", "playwright-core");
    fs.mkdirSync(path.dirname(linkedRoot), { recursive: true });
    fs.symlinkSync(sourceRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const plugin = createWorkerDeployBuildPlugin(tempRoot);
    const resolvedId = fs.realpathSync(path.join(linkedRoot, "lib/coreBundle.js"));

    const transformed = plugin.transform.call({ error: fail }, source, resolvedId);

    expect(transformed).toContain('packageJSON = {"name":"playwright-core","version":"1.62.1"};');
  });

  it("fails closed when the dependency-owned bootstrap shape changes", () => {
    const coreBundlePath = path.resolve("node_modules/playwright-core/lib/coreBundle.js");
    const plugin = createWorkerDeployBuildPlugin();

    expect(() =>
      plugin.transform.call({ error: fail }, "changed upstream source", coreBundlePath),
    ).toThrow("playwright-core package bootstrap changed");
  });
});
