/** Real Gateway readiness coverage for configured plugin payload quarantine. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runPluginPayloadSmokeCheck } from "../cli/update-cli/plugin-payload-validation.js";
import {
  buildDegradedPluginsFromVerificationFailures,
  listActiveDegradedPlugins,
  setActiveDegradedPlugins,
} from "../plugins/runtime-degraded-state.js";
import {
  getFreePort,
  installGatewayTestHooks,
  setTestPluginRegistry,
  startGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

describe("Gateway startup plugin quarantine", () => {
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
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

  it("opts into canonical runtime conditions only when readiness is configured", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    const gateway = {
      mode: "local" as const,
      bind: "loopback" as const,
      auth: { mode: "none" as const },
    };

    await writeConfigFile({ gateway });
    let port = await getFreePort();
    server = await startGatewayServer(port, { auth: { mode: "none" } });
    const legacyResponse = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(legacyResponse.status).toBe(200);
    const legacy = (await legacyResponse.json()) as { conditions?: Array<{ type: string }> };
    expect(legacy.conditions?.map((condition) => condition.type)).not.toContain("ConfigLoaded");

    await server.close();
    server = undefined;
    await writeConfigFile({ gateway: { ...gateway, readiness: {} } });
    port = await getFreePort();
    server = await startGatewayServer(port, { auth: { mode: "none" } });
    const canonicalResponse = await fetch(`http://127.0.0.1:${port}/readyz`);
    expect(canonicalResponse.status).toBe(200);
    const canonical = (await canonicalResponse.json()) as {
      conditions?: Array<{ type: string }>;
    };
    expect(canonical.conditions?.map((condition) => condition.type)).toContain("ConfigLoaded");
  });

  it("reaches readiness without importing one broken configured plugin", async () => {
    const pluginId = "broken-payload";
    const pluginRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-quarantined-plugin-"));
    tempDirs.push(pluginRoot);
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        name: pluginId,
        type: "commonjs",
        main: "./missing-main.cjs",
        openclaw: { extensions: ["./index.cjs"] },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        configSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
      }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(pluginRoot, "index.cjs"),
      "globalThis.brokenPluginImported = true; module.exports = { id: 'broken-payload', register() {} };",
      "utf8",
    );

    const smoke = await runPluginPayloadSmokeCheck({
      records: {
        [pluginId]: {
          source: "npm",
          spec: pluginId,
          installPath: pluginRoot,
        },
      },
      env: process.env,
    });
    expect(smoke.failures).toMatchObject([
      { pluginId, reason: "missing-main-entry", installPath: pluginRoot },
    ]);
    setActiveDegradedPlugins(buildDegradedPluginsFromVerificationFailures(smoke.failures));

    const { loadOpenClawPlugins } =
      await vi.importActual<typeof import("../plugins/loader.js")>("../plugins/loader.js");
    const pluginConfig = {
      enabled: true,
      load: { paths: [pluginRoot] },
      allow: [pluginId],
      entries: { [pluginId]: { enabled: true } },
    };
    const registry = loadOpenClawPlugins({
      cache: false,
      config: { plugins: pluginConfig },
      onlyPluginIds: [pluginId],
    });
    expect(registry.plugins.find((plugin) => plugin.id === pluginId)).toMatchObject({
      status: "error",
      activated: false,
      failurePhase: "validation",
      activationReason: "configured-unavailable: missing-main-entry",
    });
    expect(registry.diagnostics).toContainEqual(
      expect.objectContaining({
        pluginId,
        code: "plugin-verification",
      }),
    );
    expect(
      registry.diagnostics.find((diagnostic) => diagnostic.pluginId === pluginId)?.message,
    ).not.toContain(pluginRoot);
    expect((globalThis as Record<string, unknown>).brokenPluginImported).toBeUndefined();

    setTestPluginRegistry(registry);
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
      plugins: pluginConfig,
    });

    const port = await getFreePort();
    server = await startGatewayServer(port, { auth: { mode: "none" } });
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);

    expect(ready.status).toBe(200);
    await expect(ready.json()).resolves.toMatchObject({ ready: true });
    expect((globalThis as Record<string, unknown>).brokenPluginImported).toBeUndefined();
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
