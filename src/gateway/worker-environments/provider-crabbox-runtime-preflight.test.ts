import { fileURLToPath } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawPluginService, WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../plugin-sdk/test-helpers/import-fresh.js";
import { resolvePluginModuleExport } from "../../plugins/loader-module-runtime.js";
import * as support from "./service.test-support.js";

const SETUP_ENV = "OPENCLAW_TEST_REPLAY_SETUP";
const CLASSLESS_PROFILE = {
  binary: "/mock/crabbox",
  provider: "machine0",
  ttl: "24h",
  idleTimeout: "60m",
  setup: "true",
  setupEnv: [SETUP_ENV],
};
const PROFILE = { ...CLASSLESS_PROFILE, class: "standard" };

function commandResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
    termination: "exit",
    ...overrides,
  };
}

describe("Crabbox runtime preflight cleanup", () => {
  support.setupWorkerEnvironmentServiceSuite();
  const pluginServices: OpenClawPluginService[] = [];
  async function registerProvider(): Promise<WorkerProvider> {
    let registered: WorkerProvider | undefined;
    const { register } = resolvePluginModuleExport(
      await importFreshModule<unknown>(import.meta.url, "../../../extensions/crabbox/index.ts"),
    );
    expectDefined(
      register,
      "Crabbox plugin registration",
    )(
      createTestPluginApi({
        id: "crabbox",
        rootDir: fileURLToPath(new URL("../../../extensions/crabbox/", import.meta.url)),
        registerWorkerProvider: (provider) => {
          registered = provider;
        },
        registerService: (service) => {
          pluginServices.push(service);
        },
      }),
    );
    return expectDefined(registered, "registered Crabbox provider");
  }
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", support.testState.root);
    vi.stubEnv(SETUP_ENV, "fixture");
  });
  afterEach(async () => {
    for (const service of pluginServices.splice(0)) {
      await service.stop?.({
        config: support.testState.config,
        stateDir: support.testState.root,
        logger: { info() {}, warn() {}, error() {}, debug() {} },
      });
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(["spawn", "config", "setup-env"])(
    "settles fresh %s preflight failure without inventing a provider cleanup obligation",
    async (failure) => {
      support.getDevelopmentProfile().provider = "crabbox";
      support.getDevelopmentProfile().settings = { ...PROFILE, provider: "aws" };
      if (failure === "setup-env") {
        vi.stubEnv(SETUP_ENV, undefined);
      }
      const runCommand = vi
        .spyOn(processRuntime, "runCommandWithTimeout")
        .mockImplementation(async (argv) => {
          expect(argv.slice(1)).toEqual(["config", "show", "--json"]);
          if (failure === "spawn") {
            throw new Error("synthetic executable could not start");
          }
          return commandResult({ code: 2, stderr: "synthetic config preflight failure" });
        });
      const service = support.createService(await registerProvider(), {
        prepareNodeEnrollment: vi.fn(),
      });
      await expect(service.create("development", "fresh-preflight")).rejects.toMatchObject({
        code: "provider_failure",
      });
      const failed = expectDefined(support.testState.store.list()[0], "failed fresh intent");
      expect(failed).toMatchObject({ state: "failed", leaseId: null, destroyRequestedAtMs: null });
      await expect(service.destroy(failed.environmentId)).resolves.toMatchObject({
        state: "failed",
        leaseId: null,
      });
      await support.reopenWorkerEnvironmentStore();
      const restarted = support.createService(await registerProvider(), {
        prepareNodeEnrollment: vi.fn(),
      });
      await restarted.reconcileOnce();
      expect(support.testState.store.get(failed.environmentId)).toEqual(failed);
      expect(runCommand).toHaveBeenCalledTimes(failure === "setup-env" ? 0 : 1);
    },
  );

  it.each(["restart reconciliation", "direct destroy"])(
    "retains unresolved legacy allocation responsibility after %s and cleanup restart",
    async (entrance) => {
      const intent = support.testState.store.createIntent({
        environmentId: "worker-legacy-provision",
        providerId: "crabbox",
        profileId: "development",
        profileSnapshot: { settings: PROFILE },
        provisionOperationId: `provision:${"0".repeat(64)}`,
      });
      const original = support.testState.store.transition({
        environmentId: intent.environmentId,
        from: intent.state,
        to: "provisioning",
      });
      const runCommand = vi
        .spyOn(processRuntime, "runCommandWithTimeout")
        .mockImplementation(async () => {
          throw new Error("legacy allocation must not invoke Crabbox");
        });
      const prepareNodeEnrollment = vi.fn();
      await support.reopenWorkerEnvironmentStore();
      const provider = await registerProvider();
      const provision = vi.spyOn(provider, "prepareProvision");
      const resolveAllocation = vi.spyOn(provider, "resolveAllocation");
      let service = support.createService(provider, { prepareNodeEnrollment });
      if (entrance === "restart reconciliation") {
        await service.reconcileOnce();
        expect(provision).toHaveBeenCalledOnce();
        expect.soft(support.testState.store.get(original.environmentId)).toMatchObject({
          ...original,
          lastError: expect.stringContaining("cannot be replayed safely"),
        });
      }
      await expect(service.destroy(original.environmentId)).rejects.toMatchObject({
        code: "provider_failure",
      });
      const pending = expectDefined(
        service.get(original.environmentId),
        "unresolved legacy cleanup",
      );
      expect(pending).toMatchObject({
        ...original,
        destroyRequestedAtMs: support.testState.nowMs,
        teardownTerminalState: "destroyed",
        lastError: expect.stringContaining("cannot be replayed safely"),
      });
      expect(resolveAllocation).toHaveBeenCalledExactlyOnceWith(
        PROFILE,
        original.provisionOperationId,
      );
      expect(provision).toHaveBeenCalledTimes(entrance === "restart reconciliation" ? 1 : 0);

      await support.reopenWorkerEnvironmentStore();
      const restartedProvider = await registerProvider();
      const restartedProvision = vi.spyOn(restartedProvider, "prepareProvision");
      const restartedResolution = vi.spyOn(restartedProvider, "resolveAllocation");
      service = support.createService(restartedProvider, { prepareNodeEnrollment });
      await service.reconcileOnce();
      await expect(service.destroy(original.environmentId)).rejects.toMatchObject({
        code: "provider_failure",
      });
      expect(service.get(original.environmentId)).toEqual(pending);
      expect(restartedResolution.mock.calls).toEqual([
        [PROFILE, original.provisionOperationId],
        [PROFILE, original.provisionOperationId],
      ]);
      expect(restartedProvision).not.toHaveBeenCalled();
      expect(runCommand).not.toHaveBeenCalled();
      expect(prepareNodeEnrollment).not.toHaveBeenCalled();
      expect(support.testState.prepareInstallation).not.toHaveBeenCalled();
      expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
      expect(support.testState.store.getCredential(original.environmentId)).toBeUndefined();
    },
  );

  // Synthetic CLI diagnostics exercise the real error producer, not captured native output.
  it.each([
    { kind: "setup-env", name: "missing setup environment" },
    { kind: "config", name: "config command failure", result: commandResult({ code: 2 }) },
    { kind: "config", name: "invalid config JSON", result: commandResult({ stdout: "{" }) },
    { kind: "config", name: "removed coordinator", result: commandResult({ stdout: "{}" }) },
    {
      kind: "aws-profile",
      name: "attached AWS profile",
      result: commandResult({ stdout: JSON.stringify({ aws: { instanceProfile: "new-role" } }) }),
    },
    { kind: "modes", name: "changed advertised modes" },
    { kind: "timeout", name: "invalid timeout metadata" },
    ...[
      "unknown flag: --lease-id",
      "flag provided but not defined: -lease-id",
      "provider=machine0 does not support fixed idempotent lease IDs",
      'unknown provider "machine0"',
      "provider=machine0 does not support warmup",
      "provider=machine0 does not support status",
      "provider=machine0 does not expose persistent status",
      "provider=machine0 is one-shot; use crabbox run",
      "provider=machine0 requires module source; use crabbox run --script",
      "--class is not supported for provider=machine0",
    ].map((stderr) => ({ kind: "cli", name: stderr, result: commandResult({ code: 2, stderr }) })),
  ])("retains the original allocation after $name across restart", async (scenario) => {
    const profile = {
      ...PROFILE,
      ...(scenario.kind === "config" ? { provider: "hetzner", desktop: true } : {}),
      ...(scenario.kind === "aws-profile" ? { provider: "aws" } : {}),
    };
    support.getDevelopmentProfile().provider = "crabbox";
    support.getDevelopmentProfile().settings = profile;
    let changed = false;
    let live = false;
    let leaseId = "";
    let allocations = 0;
    let stops = 0;
    const calls: string[][] = [];
    vi.spyOn(processRuntime, "runCommandWithTimeout").mockImplementation(async (argv) => {
      calls.push(argv);
      if (argv[1] === "config") {
        return changed && "result" in scenario
          ? expectDefined(scenario.result, "runtime refusal")
          : commandResult({
              stdout: JSON.stringify({
                coordinator: "https://coordinator.example.test",
                brokerMode: "managed",
                aws: { instanceProfile: "" },
              }),
            });
      }
      if (argv[1] === "warmup") {
        if (changed && "result" in scenario) {
          return expectDefined(scenario.result, "runtime refusal");
        }
        allocations += 1;
        live = true;
        leaseId = expectDefined(argv[argv.indexOf("--lease-id") + 1], "original fixed lease");
        return commandResult({ code: 5, stderr: "synthetic response lost after allocation" });
      }
      expect(argv[argv.indexOf("--id") + 1]).toBe(leaseId);
      if (argv[1] === "stop") {
        stops += 1;
        if (stops === 1) {
          return commandResult({ code: 4, stderr: `lease ${leaseId} already stopped` });
        }
        live = false;
        return commandResult();
      }
      expect(argv[1]).toBe("inspect");
      return commandResult({
        stdout: JSON.stringify({ id: leaseId, state: "running", ready: true }),
      });
    });
    const prepareNodeEnrollment = vi.fn();
    const makeProvider = async (): Promise<WorkerProvider> => {
      const provider = await registerProvider();
      if (changed && scenario.kind === "modes") {
        provider.supportedExecutionModes = ["remote-exec"];
      }
      if (changed && scenario.kind === "timeout") {
        provider.resolveProvisionTimeoutMs = () => Number.NaN;
      }
      return provider;
    };
    let service = support.createService(await makeProvider(), { prepareNodeEnrollment });
    await expect(
      service.create("development", "runtime-replay", undefined, "worker-turn"),
    ).rejects.toMatchObject({ code: "provider_failure" });
    const original = expectDefined(support.testState.store.list()[0], "unreported allocation");
    expect(original).toMatchObject({ state: "provisioning", leaseId: null });
    expect(live).toBe(true);

    await support.reopenWorkerEnvironmentStore();
    changed = true;
    if (scenario.kind === "setup-env") {
      vi.stubEnv(SETUP_ENV, undefined);
    }
    const replayProvider = await makeProvider();
    const resolveAllocation = vi.spyOn(replayProvider, "resolveAllocation");
    service = support.createService(replayProvider, { prepareNodeEnrollment });
    await service.reconcileOnce();
    expect(support.testState.store.get(original.environmentId)).toMatchObject({
      state: "provisioning",
      leaseId: null,
      provisionOperationId: original.provisionOperationId,
      profileSnapshot: original.profileSnapshot,
      lastError: expect.any(String),
    });
    const beforeCleanup = calls.length;
    support.testState.config.cloudWorkers!.profiles = {};
    await expect(service.destroy(original.environmentId)).rejects.toMatchObject({
      code: "provider_failure",
    });
    expect(resolveAllocation).toHaveBeenCalledExactlyOnceWith(
      profile,
      original.provisionOperationId,
    );
    expect(support.testState.store.get(original.environmentId)).toMatchObject({
      state: "destroying",
      leaseId,
      destroyRequestedAtMs: expect.any(Number),
    });
    expect(live).toBe(true);

    await support.reopenWorkerEnvironmentStore();
    service = support.createService(await makeProvider(), { prepareNodeEnrollment });
    await service.reconcileOnce();
    expect(support.testState.store.get(original.environmentId)).toMatchObject({
      state: "destroyed",
      leaseId,
    });
    await service.destroy(original.environmentId);
    await service.reconcileOnce();
    expect(calls.slice(beforeCleanup).map((argv) => argv[1])).toEqual(["stop", "inspect", "stop"]);
    expect(calls.filter((argv) => argv[1] === "warmup")).toHaveLength(
      scenario.kind === "cli" ? 2 : 1,
    );
    expect(allocations).toBe(1);
    expect(stops).toBe(2);
    expect(live).toBe(false);
    expect(prepareNodeEnrollment).not.toHaveBeenCalled();
    expect(support.testState.prepareInstallation).not.toHaveBeenCalled();
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "invalid duration",
      settings: { ...PROFILE, ttl: "invalid" },
      message: "positive Go duration",
    },
    {
      name: "warm image without effective class",
      settings: { ...CLASSLESS_PROFILE, warmImage: true },
      message: "warmImage requires a configured class or a placement machine class",
    },
  ])("keeps $name permanent even with missing runtime input", async ({ settings, message }) => {
    vi.stubEnv(SETUP_ENV, undefined);
    support.getDevelopmentProfile().provider = "crabbox";
    support.getDevelopmentProfile().settings = settings;
    const runCommand = vi.spyOn(processRuntime, "runCommandWithTimeout");
    const provider = await registerProvider();
    const service = support.createService(provider, { prepareNodeEnrollment: vi.fn() });
    await expect(service.create("development", "invalid-immutable")).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining(message),
    });
    expect(support.testState.store.list()[0]).toMatchObject({ state: "failed", leaseId: null });
    expect(runCommand).not.toHaveBeenCalled();
  });
});
