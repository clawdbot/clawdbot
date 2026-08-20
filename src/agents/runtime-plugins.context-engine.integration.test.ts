// Verifies prepared agent turns retain their selected runtime context-engine owner.
import { afterAll, afterEach, expect, it } from "vitest";
import { resetContextEngineRuntimeQuarantineForTests } from "../context-engine/registry.test-support.js";
import { loadAndActivateRootPluginRegistry, loadPluginRegistryHandle } from "../plugins/loader.js";
import {
  cleanupPluginLoaderFixturesForTest,
  makePluginLoaderTempDir,
  resetPluginLoaderTestStateForTest,
  useNoBundledPlugins,
  writePlugin,
} from "../plugins/loader.test-fixtures.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createContextEngineLogicalTurnLease } from "./harness/context-engine-logical-turn.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";
import { getSandboxBackendFactory, registerSandboxBackend } from "./sandbox/backend.js";

const SANDBOX_PROBE_ID = "scoped-load-probe";
const REGISTER_SANDBOX_BACKEND = Symbol.for("openclaw.test.registerSandboxBackend");
const REGISTRATION_MODES = Symbol.for("openclaw.test.pluginRegistrationModes");

type ProbeGlobal = typeof globalThis & {
  [REGISTER_SANDBOX_BACKEND]?: typeof registerSandboxBackend;
  [REGISTRATION_MODES]?: Array<{ id: string; mode: string }>;
};

const restoreSandboxBackends: Array<() => void> = [];

afterEach(() => {
  while (restoreSandboxBackends.length > 0) {
    restoreSandboxBackends.pop()?.();
  }
  delete (globalThis as ProbeGlobal)[REGISTER_SANDBOX_BACKEND];
  delete (globalThis as ProbeGlobal)[REGISTRATION_MODES];
  resetContextEngineRuntimeQuarantineForTests();
  resetPluginLoaderTestStateForTest();
});

afterAll(() => {
  cleanupPluginLoaderFixturesForTest();
});

it("keeps the configured context engine active in a prepared agent registry", async () => {
  useNoBundledPlugins();
  const engineId = "prepared-context-engine";
  const plugin = writePlugin({
    id: engineId,
    body: `module.exports = {
      id: ${JSON.stringify(engineId)},
      register(api) {
        api.registerContextEngine(${JSON.stringify(engineId)}, () => ({
          info: { id: ${JSON.stringify(engineId)}, name: "Prepared Context Engine" },
          async ingest() { return { ingested: false }; },
          async assemble({ messages }) {
            return { messages, estimatedTokens: 0, systemPromptAddition: "prepared-engine" };
          },
          async compact() { return { ok: true, compacted: false }; },
        }));
      },
    };\n`,
  });
  const config = {
    plugins: {
      load: { paths: [plugin.file] },
      slots: { contextEngine: engineId },
    },
  };

  const activeRegistry = loadAndActivateRootPluginRegistry({
    cache: false,
    config,
    workspaceDir: makePluginLoaderTempDir(),
    onlyPluginIds: [engineId],
  });
  const preparedRegistry = loadAgentRuntimePluginRegistryHandle({
    basePluginIds: [],
    config,
    workspaceDir: plugin.dir,
  });

  expect(preparedRegistry).not.toBe(activeRegistry);
  await withPluginRuntimeRegistryScope(preparedRegistry, async () => {
    const lease = await createContextEngineLogicalTurnLease({ config, workspaceDir: plugin.dir });
    expect(lease.degraded).toBe(false);
    expect(lease.effectiveEngineId).toBe(engineId);
    expect(lease.effectiveEnginePluginId).toBe(engineId);
    await expect(
      lease.begin().engine.assemble({ messages: [], sessionId: "prepared-session" }),
    ).resolves.toMatchObject({ systemPromptAddition: "prepared-engine" });
    await lease.dispose();
  });
});

it("selects a full-mode-only context engine on caller-owned handles without full-only global setup", async () => {
  useNoBundledPlugins();
  const probe = globalThis as ProbeGlobal;
  probe[REGISTRATION_MODES] = [];
  probe[REGISTER_SANDBOX_BACKEND] = (id, registration) => {
    const restore = registerSandboxBackend(id, registration);
    restoreSandboxBackends.push(restore);
    return restore;
  };
  const contextEngine = writePlugin({
    id: "ce-probe",
    body: `module.exports = {
  id: "ce-probe",
  register(api) {
    const seen = globalThis[Symbol.for("openclaw.test.pluginRegistrationModes")];
    seen.push({ id: "ce-probe", mode: api.registrationMode });
    if (api.registrationMode === "full") {
      api.registerContextEngine("ce-probe", async () => ({
        info: { id: "ce-probe", name: "CE Probe" },
        ingest: async () => ({ ingested: true }),
        assemble: async ({ messages }) => ({ messages, estimatedTokens: 0 }),
        compact: async () => ({ ok: true, compacted: false }),
        dispose: async () => {},
      }));
    }
  },
};`,
  });
  const sandboxProbe = writePlugin({
    id: "sandbox-probe",
    body: `module.exports = {
  id: "sandbox-probe",
  register(api) {
    const seen = globalThis[Symbol.for("openclaw.test.pluginRegistrationModes")];
    seen.push({ id: "sandbox-probe", mode: api.registrationMode });
    if (api.registrationMode !== "full") {
      return;
    }
    const registerSandboxBackend = globalThis[Symbol.for("openclaw.test.registerSandboxBackend")];
    registerSandboxBackend(${JSON.stringify(SANDBOX_PROBE_ID)}, async () => {
      throw new Error("sandbox probe backend should not run");
    });
  },
};`,
  });
  const config = {
    plugins: {
      load: { paths: [contextEngine.dir, sandboxProbe.dir] },
      allow: ["ce-probe", "sandbox-probe"],
      slots: { contextEngine: "ce-probe" },
      entries: {
        "ce-probe": { enabled: true },
        "sandbox-probe": { enabled: true },
      },
    },
  };
  const workspaceDir = makePluginLoaderTempDir();
  const root = loadAndActivateRootPluginRegistry({
    cache: false,
    config,
    onlyPluginIds: ["ce-probe", "sandbox-probe"],
  });
  const rootSandboxFactory = getSandboxBackendFactory(SANDBOX_PROBE_ID);
  const sandboxRegistrationsAfterRoot = restoreSandboxBackends.length;

  expect(getActivePluginRegistry()).toBe(root);
  expect(root.contextEngines.get("ce-probe")?.lifecycle).toBe("runtime");
  expect(rootSandboxFactory).not.toBeNull();
  expect(sandboxRegistrationsAfterRoot).toBe(1);

  const handle = loadAgentRuntimePluginRegistryHandle({
    basePluginIds: ["ce-probe", "sandbox-probe"],
    config,
    workspaceDir,
  });
  const discovery = loadPluginRegistryHandle({
    cache: false,
    config,
    onlyPluginIds: ["ce-probe", "sandbox-probe"],
  });

  expect(handle).not.toBe(root);
  expect(getActivePluginRegistry()).toBe(root);
  expect(handle.plugins.find((plugin) => plugin.id === "sandbox-probe")?.status).toBe("loaded");
  expect(getSandboxBackendFactory(SANDBOX_PROBE_ID)).toBe(rootSandboxFactory);
  expect(restoreSandboxBackends.length).toBe(sandboxRegistrationsAfterRoot);
  expect(discovery.contextEngines.get("ce-probe")).toBeUndefined();
  expect(handle.contextEngines.get("ce-probe")?.lifecycle).toBe("runtime");
  const registrationModes = probe[REGISTRATION_MODES] ?? [];
  expect(registrationModes.filter((entry) => entry.mode === "full")).toHaveLength(2);
  expect(
    new Set(registrationModes.filter((entry) => entry.mode === "full").map((entry) => entry.id)),
  ).toEqual(new Set(["ce-probe", "sandbox-probe"]));
  expect(
    registrationModes.every((entry) => entry.mode === "full" || entry.mode === "discovery"),
  ).toBe(true);
  expect(
    registrationModes.some((entry) => entry.id === "sandbox-probe" && entry.mode === "discovery"),
  ).toBe(true);

  const warn = (message: string) => {
    throw new Error(`unexpected context-engine degrade: ${message}`);
  };
  // Cron prepare loads this handle, then run-executor selects the engine inside the scoped registry.
  const lease = await withPluginRuntimeRegistryScope(handle, () =>
    createContextEngineLogicalTurnLease({ config, warn, workspaceDir }),
  );
  try {
    expect(lease.effectiveEngineId).toBe("ce-probe");
    expect(lease.degraded).toBe(false);
  } finally {
    await lease.dispose();
  }
});
