import { fileURLToPath } from "node:url";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  WorkerProvider,
} from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const PROFILE = {
  binary: "/mock/crabbox",
  class: "standard",
  idleTimeout: "12s",
  provider: "aws",
  ttl: "24h",
};

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

function inspectResult(leaseId: string): SpawnResult {
  return commandResult({
    stdout: JSON.stringify({
      host: "worker.example.test",
      id: leaseId,
      ready: true,
      sshHost: "worker.example.test",
      sshKey: "/mock/worker-key",
      sshPort: 2222,
      sshUser: "openclaw",
      state: "running",
    }),
  });
}

function registerCrabboxGeneration() {
  const providers: WorkerProvider[] = [];
  const services: OpenClawPluginService[] = [];
  plugin.register(
    createTestPluginApi({
      id: "crabbox",
      rootDir: fileURLToPath(new URL(".", import.meta.url)),
      registerService: (service) => services.push(service),
      registerWorkerProvider: (provider) => providers.push(provider),
    }),
  );
  return { provider: providers[0]!, services };
}

function stopGeneration(services: OpenClawPluginService[]): void | Promise<void> {
  return services[0]?.stop?.({} as OpenClawPluginServiceContext);
}

describe("Crabbox plugin generation lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { backend: "daytona", executionMode: "worker-turn" },
    { backend: "hetzner", executionMode: "remote-exec" },
  ] as const)(
    "supports a classless $backend profile through $executionMode lifecycle",
    async ({ backend, executionMode }) => {
      const runCommand = vi
        .spyOn(processRuntime, "runCommandWithTimeout")
        .mockImplementation(async (argv) => {
          if (argv[1] === "providers") {
            return commandResult({
              stdout: JSON.stringify([
                { provider: backend, classCatalog: { disposition: "unmapped" } },
              ]),
            });
          }
          return argv[1] === "inspect"
            ? inspectResult(argv[argv.indexOf("--id") + 1]!)
            : commandResult();
        });
      const generation = registerCrabboxGeneration();
      const profile = {
        binary: PROFILE.binary,
        idleTimeout: PROFILE.idleTimeout,
        ttl: PROFILE.ttl,
        provider: backend,
      };
      try {
        expect(generation.provider.resolveProvisionTimeoutMs?.(profile)).toBe(67 * 60_000);
        expect(await generation.provider.listMachineOptions?.(profile)).toEqual([]);
        const waitForDeviceId = vi.fn(async () => "device-classless");
        const lease = await generation.provider.provision(profile, "classless-operation", {
          executionMode,
          beginNodeEnrollment: async () => ({
            ...(executionMode === "worker-turn"
              ? {
                  mode: "connect" as const,
                  setupCode: "fixture-setup-code",
                  setupId: "fixture-setup-id",
                }
              : { mode: "resume" as const, deviceId: "device-classless" }),
            openclawVersion: "2026.8.1",
            packageSpecs: ["openclaw@2026.8.1"],
            displayName: "Classless worker",
            waitForDeviceId,
          }),
        });
        expect(lease.node).toEqual({ deviceId: "device-classless" });
        expect(waitForDeviceId).toHaveBeenCalledOnce();
        await expect(
          generation.provider.inspect({ leaseId: lease.leaseId, profile }),
        ).resolves.toEqual({ status: "active" });
        await expect(
          generation.provider.destroy({ leaseId: lease.leaseId, profile }),
        ).resolves.toBeUndefined();
        const calls = runCommand.mock.calls.map(([argv]) => argv);
        expect(calls.map((argv) => argv[1])).toEqual([
          "providers",
          "warmup",
          "inspect",
          "run",
          "inspect",
          "inspect",
          "stop",
        ]);
        expect(calls.flat()).not.toContain("--class");
        expect(calls.at(-1)).toEqual([
          PROFILE.binary,
          "stop",
          "--provider",
          backend,
          "--id",
          lease.leaseId,
        ]);
      } finally {
        await stopGeneration(generation.services);
      }
    },
  );

  it("registers cleanup that fences pending heartbeats and late starts", async () => {
    vi.useFakeTimers();
    const runCommand = vi
      .spyOn(processRuntime, "runCommandWithTimeout")
      .mockImplementation(async (argv) => inspectResult(argv[argv.indexOf("--id") + 1]!));
    const generation = registerCrabboxGeneration();
    const lease = { leaseId: "cbx_pending", profile: PROFILE };

    expect(generation.services).toHaveLength(1);
    await generation.provider.inspect(lease);
    await stopGeneration(generation.services);
    await generation.provider.inspect(lease);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(runCommand.mock.calls.filter(([argv]) => argv[1] === "heartbeat")).toEqual([]);
  });

  it("aborts all in-flight heartbeats and fences late completions", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const finishHeartbeats: Array<() => void> = [];
    const runCommand = vi
      .spyOn(processRuntime, "runCommandWithTimeout")
      .mockImplementation(async (argv, options) => {
        const leaseId = argv[argv.indexOf("--id") + 1]!;
        if (argv[1] !== "heartbeat") {
          return inspectResult(leaseId);
        }
        if (typeof options === "number" || !options.signal) {
          throw new Error("heartbeat is missing its abort signal");
        }
        signals.push(options.signal);
        return await new Promise<SpawnResult>((resolve) => {
          finishHeartbeats.push(() => resolve(commandResult()));
        });
      });
    const generation = registerCrabboxGeneration();

    for (const leaseId of ["cbx_first", "cbx_second"]) {
      await generation.provider.inspect({ leaseId, profile: PROFILE });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(signals).toHaveLength(2);

    await stopGeneration(generation.services);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    for (const finish of finishHeartbeats) {
      finish();
    }
    await vi.advanceTimersByTimeAsync(15_000);

    expect(runCommand.mock.calls.filter(([argv]) => argv[1] === "heartbeat")).toHaveLength(2);
  });

  it("keeps a replacement provider generation independently usable", async () => {
    vi.useFakeTimers();
    const runCommand = vi
      .spyOn(processRuntime, "runCommandWithTimeout")
      .mockImplementation(async (argv) =>
        argv[1] === "inspect" ? inspectResult(argv[argv.indexOf("--id") + 1]!) : commandResult(),
      );
    const retiring = registerCrabboxGeneration();
    const replacement = registerCrabboxGeneration();

    await retiring.provider.inspect({ leaseId: "cbx_retiring", profile: PROFILE });
    await replacement.provider.inspect({ leaseId: "cbx_replacement", profile: PROFILE });
    await stopGeneration(retiring.services);
    await vi.advanceTimersByTimeAsync(5_000);

    const heartbeatLeaseIds = runCommand.mock.calls
      .filter(([argv]) => argv[1] === "heartbeat")
      .map(([argv]) => argv[argv.indexOf("--id") + 1]);
    expect(heartbeatLeaseIds).toEqual(["cbx_replacement", "cbx_replacement"]);

    await stopGeneration(replacement.services);
  });
});
