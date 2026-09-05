/** Real Gateway readiness coverage for configured plugin payload quarantine. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPluginPayloadSmokeCheck } from "../plugins/payload-verification.js";
import {
  buildDegradedPluginsFromVerificationFailures,
  listActiveDegradedPlugins,
  setActiveDegradedPlugins,
} from "../plugins/runtime-degraded-state.js";
import {
  getGatewayTestPort,
  installGatewayTestHooks,
  setTestPluginRegistry,
  startTestGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("Gateway startup plugin quarantine", () => {
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
  const tempDirs: string[] = [];

  afterEach(async () => {
    await server?.close();
    server = undefined;
    setActiveDegradedPlugins([]);
    delete (globalThis as Record<string, unknown>).brokenPluginImported;
    delete (globalThis as Record<string, unknown>).selectedPluginImported;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reaches readiness with a quarantined plugin beside a valid declared extension", async () => {
    const brokenPluginId = "broken-payload";
    const validPluginId = "valid-declared-extension";
    const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-quarantined-plugin-"));
    const validRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-valid-stale-main-"));
    tempDirs.push(brokenRoot, validRoot);
    fs.writeFileSync(
      path.join(brokenRoot, "package.json"),
      JSON.stringify({
        name: brokenPluginId,
        type: "commonjs",
        main: "./missing-main.cjs",
        openclaw: { extensions: ["./index.cjs"] },
        peerDependencies: { openclaw: ">=2026.1.1" },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(brokenRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: brokenPluginId,
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(brokenRoot, "index.cjs"),
      "globalThis.brokenPluginImported = true; module.exports = { id: 'broken-payload', register() {} };",
      "utf8",
    );
    fs.writeFileSync(
      path.join(validRoot, "package.json"),
      JSON.stringify({
        name: validPluginId,
        type: "commonjs",
        main: "./missing-main.cjs",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(validRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: validPluginId,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(validRoot, "index.cjs"),
      `globalThis.selectedPluginImported = true; module.exports = { id: '${validPluginId}', register() {} };`,
      "utf8",
    );

    const smoke = await runPluginPayloadSmokeCheck({
      records: {
        [brokenPluginId]: {
          source: "npm",
          spec: brokenPluginId,
          installPath: brokenRoot,
        },
        [validPluginId]: { source: "npm", spec: validPluginId, installPath: validRoot },
      },
      env: process.env,
    });
    expect(smoke.checked).toEqual([brokenPluginId, validPluginId]);
    expect(smoke.failures).toMatchObject([
      {
        pluginId: brokenPluginId,
        reason: "missing-openclaw-peer-link",
        installPath: brokenRoot,
      },
    ]);
    setActiveDegradedPlugins(buildDegradedPluginsFromVerificationFailures(smoke.failures));

    const { loadOpenClawPlugins } =
      await vi.importActual<typeof import("../plugins/loader.js")>("../plugins/loader.js");
    const pluginConfig = {
      enabled: true,
      load: { paths: [brokenRoot, validRoot] },
      allow: [brokenPluginId, validPluginId],
      entries: {
        [brokenPluginId]: { enabled: true },
        [validPluginId]: { enabled: true },
      },
    };
    const registry = loadOpenClawPlugins({
      cache: false,
      config: { plugins: pluginConfig },
      onlyPluginIds: [brokenPluginId, validPluginId],
    });
    expect(registry.plugins.find((plugin) => plugin.id === brokenPluginId)).toMatchObject({
      status: "error",
      activated: false,
      failurePhase: "validation",
      activationReason: "configured-unavailable: missing-openclaw-peer-link",
    });
    expect(registry.plugins.find((plugin) => plugin.id === validPluginId)).toMatchObject({
      status: "loaded",
      activated: true,
    });
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId: brokenPluginId,
        code: "plugin-verification",
      }),
    );
    expect(
      registry.diagnostics.find((diagnostic) => diagnostic.pluginId === brokenPluginId)?.message,
    ).not.toContain(brokenRoot);
    expect((globalThis as Record<string, unknown>).brokenPluginImported).toBeUndefined();
    expect((globalThis as Record<string, unknown>).selectedPluginImported).toBe(true);

    setTestPluginRegistry(registry);
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
      plugins: pluginConfig,
    });

    const port = await getGatewayTestPort();
    server = await startTestGatewayServer(port, { auth: { mode: "none" } });
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ ready: true });
    expect((globalThis as Record<string, unknown>).brokenPluginImported).toBeUndefined();
    expect((globalThis as Record<string, unknown>).selectedPluginImported).toBe(true);
  });

  it("does not quarantine a healthy explicit root that shadows a broken install with the same id", async () => {
    const pluginId = "shadowed-payload";
    const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-broken-install-"));
    const selectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-selected-plugin-"));
    tempDirs.push(brokenRoot, selectedRoot);
    fs.writeFileSync(
      path.join(brokenRoot, "package.json"),
      JSON.stringify({
        name: pluginId,
        type: "commonjs",
        main: "./missing-main.cjs",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(selectedRoot, "package.json"),
      JSON.stringify({
        name: pluginId,
        type: "commonjs",
        main: "./index.cjs",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(selectedRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(selectedRoot, "index.cjs"),
      "globalThis.selectedPluginImported = true; module.exports = { id: 'shadowed-payload', register() {} };",
      "utf8",
    );

    const smoke = await runPluginPayloadSmokeCheck({
      records: {
        [pluginId]: { source: "npm", spec: pluginId, installPath: brokenRoot },
      },
      env: process.env,
    });
    setActiveDegradedPlugins(buildDegradedPluginsFromVerificationFailures(smoke.failures));

    const { loadOpenClawPlugins } =
      await vi.importActual<typeof import("../plugins/loader.js")>("../plugins/loader.js");
    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          enabled: true,
          load: { paths: [selectedRoot] },
          allow: [pluginId],
          entries: { [pluginId]: { enabled: true } },
        },
      },
      onlyPluginIds: [pluginId],
    });

    expect(registry.plugins.find((plugin) => plugin.id === pluginId)?.status).toBe("loaded");
    expect((globalThis as Record<string, unknown>).selectedPluginImported).toBe(true);
    expect(listActiveDegradedPlugins()).toEqual([]);
  });

  it("keeps the broken install visible when its explicit override fails to load", async () => {
    const pluginId = "failed-shadow";
    const brokenRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-broken-install-"));
    const selectedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-selected-plugin-"));
    tempDirs.push(brokenRoot, selectedRoot);
    fs.writeFileSync(
      path.join(brokenRoot, "package.json"),
      JSON.stringify({
        name: pluginId,
        type: "commonjs",
        main: "./missing-main.cjs",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(selectedRoot, "package.json"),
      JSON.stringify({
        name: pluginId,
        type: "commonjs",
        main: "./index.cjs",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(selectedRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(selectedRoot, "index.cjs"),
      "throw new Error('import failed');",
      "utf8",
    );

    const smoke = await runPluginPayloadSmokeCheck({
      records: {
        [pluginId]: { source: "npm", spec: pluginId, installPath: brokenRoot },
      },
      env: process.env,
    });
    setActiveDegradedPlugins(buildDegradedPluginsFromVerificationFailures(smoke.failures));

    const { loadOpenClawPlugins } =
      await vi.importActual<typeof import("../plugins/loader.js")>("../plugins/loader.js");
    const registry = loadOpenClawPlugins({
      cache: false,
      config: {
        plugins: {
          enabled: true,
          load: { paths: [selectedRoot] },
          allow: [pluginId],
          entries: { [pluginId]: { enabled: true } },
        },
      },
      onlyPluginIds: [pluginId],
    });

    expect(registry.plugins.find((plugin) => plugin.id === pluginId)?.status).toBe("error");
    expect(listActiveDegradedPlugins()).toMatchObject([
      { pluginId, diagnostic: { installPath: brokenRoot } },
    ]);
  });
});
