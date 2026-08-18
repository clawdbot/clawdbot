/**
 * Tests gateway plugin lifecycle loading, startup, and shutdown behavior.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { getFreePort } from "../test-utils/ports.js";
import { installGatewayTestHooks, startTestGatewayServer } from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

const INSTANCE_BINDING_PROBE_KEY = Symbol.for("openclaw.test.gatewayInstanceBindingProbe");
const INSTANCE_BINDING_PROBE_METHOD = "instanceBinding.probe";

type InstanceBindingProbeResult = {
  registryId: number;
  sessionsId: number;
  placementId: number;
};

type InstanceBindingProbeCoordinator = {
  identify: (value: object) => number;
  nextRegistryId: number;
  runtimes: PluginRuntime[];
};

function installInstanceBindingProbeCoordinator(): InstanceBindingProbeCoordinator {
  const ids = new WeakMap<object, number>();
  let nextId = 1;
  const coordinator: InstanceBindingProbeCoordinator = {
    identify(value) {
      const existing = ids.get(value);
      if (existing !== undefined) {
        return existing;
      }
      const id = nextId++;
      ids.set(value, id);
      return id;
    },
    nextRegistryId: 1,
    runtimes: [],
  };
  (globalThis as Record<PropertyKey, unknown>)[INSTANCE_BINDING_PROBE_KEY] = coordinator;
  return coordinator;
}

async function requireBoundRuntime(
  runtimes: readonly PluginRuntime[],
  label: string,
): Promise<PluginRuntime> {
  for (const runtime of runtimes) {
    if (await runtime.gateway.isAvailable()) {
      return runtime;
    }
  }
  throw new Error(`${label} Gateway did not register an instance-bound plugin runtime`);
}

async function writeInstanceBindingProbePlugin(): Promise<{
  bundledRoot: string;
  pluginDir: string;
}> {
  const bundledRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-instance-binding-"));
  const pluginDir = path.join(bundledRoot, "instance-binding-probe");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify({
      name: "instance-binding-probe",
      type: "commonjs",
      main: "index.js",
      openclaw: { extensions: ["./index.js"] },
      peerDependencies: { openclaw: ">=2026.1.1" },
    })}\n`,
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({
      id: "instance-binding-probe",
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    })}\n`,
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `module.exports = {
  id: "instance-binding-probe",
  register(api) {
    const coordinator = globalThis[Symbol.for("openclaw.test.gatewayInstanceBindingProbe")];
    const registryId = coordinator.nextRegistryId++;
    coordinator.runtimes.push(api.runtime);
    api.registerGatewayMethod("${INSTANCE_BINDING_PROBE_METHOD}", ({ context, respond }) => {
      respond(true, {
        registryId,
        sessionsId: coordinator.identify(context.sessionCompanion),
        placementId: coordinator.identify(context.workerSessionPlacementService),
      });
    }, { scope: "operator.read" });
  },
};
`,
  );
  return { bundledRoot, pluginDir };
}

describe("gateway plugin instance bindings", () => {
  const started: Array<Awaited<ReturnType<typeof startTestGatewayServer>>> = [];
  let bundledRoot: string | undefined;

  afterEach(async () => {
    for (const server of started.splice(0).toReversed()) {
      await server.close({ reason: "instance binding cleanup" });
    }
    delete (globalThis as Record<PropertyKey, unknown>)[INSTANCE_BINDING_PROBE_KEY];
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
    if (bundledRoot) {
      await fs.rm(bundledRoot, { recursive: true, force: true });
      bundledRoot = undefined;
    }
  });

  it(
    "keeps unscoped plugin work bound to each real Gateway across reverse shutdown",
    { timeout: 600_000 },
    async () => {
      const coordinator = installInstanceBindingProbeCoordinator();
      const plugin = await writeInstanceBindingProbePlugin();
      bundledRoot = plugin.bundledRoot;
      process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
      delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
      process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = plugin.bundledRoot;
      process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      const configPath = process.env.OPENCLAW_CONFIG_PATH;
      if (!configPath) {
        throw new Error("gateway test hooks did not install OPENCLAW_CONFIG_PATH");
      }
      const config = {
        plugins: {
          enabled: true,
          allow: ["instance-binding-probe"],
          entries: { "instance-binding-probe": { enabled: true } },
        },
      };
      const { loadPluginLookUpTable } = await import("../plugins/plugin-lookup-table.js");
      expect(loadPluginLookUpTable({ config, env: process.env }).startup.pluginIds).toContain(
        "instance-binding-probe",
      );
      await fs.writeFile(configPath, `${JSON.stringify(config)}\n`);

      const first = await startTestGatewayServer(await getFreePort(), {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      started.push(first);
      await first.startupSettled;
      const firstRegistrationCount = coordinator.runtimes.length;
      expect(firstRegistrationCount).toBeGreaterThan(0);
      const firstRuntime = await requireBoundRuntime(
        coordinator.runtimes.slice(0, firstRegistrationCount),
        "first",
      );

      const second = await startTestGatewayServer(await getFreePort(), {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      started.push(second);
      await second.startupSettled;
      expect(coordinator.runtimes.length).toBeGreaterThan(firstRegistrationCount);
      const secondRuntime = await requireBoundRuntime(
        coordinator.runtimes.slice(firstRegistrationCount),
        "second",
      );

      const requestProbe = (runtime: PluginRuntime) =>
        runtime.gateway.request<InstanceBindingProbeResult>(
          INSTANCE_BINDING_PROBE_METHOD,
          {},
          { scopes: ["operator.read"] },
        );
      const firstProbe = await requestProbe(firstRuntime);
      const secondProbe = await requestProbe(secondRuntime);
      expect(firstProbe.registryId).not.toBe(secondProbe.registryId);
      expect(firstProbe.sessionsId).not.toBe(secondProbe.sessionsId);
      expect(firstProbe.placementId).not.toBe(secondProbe.placementId);
      await expect(
        firstRuntime.subagent.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
      ).resolves.toEqual({ messages: [] });
      await expect(
        secondRuntime.subagent.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
      ).resolves.toEqual({ messages: [] });

      await second.close({ reason: "close last-started Gateway first" });
      started.pop();
      await expect(requestProbe(firstRuntime)).resolves.toEqual(firstProbe);
      await expect(
        firstRuntime.subagent.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
      ).resolves.toEqual({ messages: [] });
    },
  );
});
