import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import {
  createNodeBootstrapFixture,
  createWorkerArchiveFixture,
} from "./crabbox-worker-node-enrollment.test-support.js";
import { operationLeaseId } from "./crabbox-worker-profile.js";
import { prepareCrabboxProjectFiles } from "./crabbox-worker-project.js";
import { listCrabboxWarmImages } from "./crabbox-worker-warm-image-store.js";
import {
  CHECKPOINT_ID,
  CLASSLESS_PROFILE,
  PROFILE,
  commandResult,
  checkpointResult,
  createWarmProvider,
  type CommandCall,
} from "./crabbox-worker-warm-image.test-support.js";

type ProvisionOptions = NonNullable<Parameters<WorkerProvider["provision"]>[2]>;
const PROJECT_KEY = "a".repeat(64);
const BASE_COMMIT = "b".repeat(40);

function projectOptions(
  events: string[],
  controller = new AbortController(),
  preparation?: NonNullable<NonNullable<ProvisionOptions["project"]>["preparation"]>,
) {
  let enrollmentStarted = false;
  const observe = ({ argv }: CommandCall) => {
    if (argv[1] === "run" && argv.includes("CRABBOX_WORKER_BOOTSTRAP_TOKEN")) {
      events.push(enrollmentStarted ? "enrollment-install" : "runtime-install");
    }
    if (argv[1] === "checkpoint" && argv[2] === "create") {
      events.push("capture");
    }
    return undefined;
  };
  const options = {
    project: {
      key: PROJECT_KEY,
      baseCommit: BASE_COMMIT,
      ...(preparation ? { preparation } : {}),
      signal: controller.signal,
      assertCurrent: () => controller.signal.throwIfAborted(),
      prepare: vi.fn<NonNullable<ProvisionOptions["project"]>["prepare"]>(async (transport) => {
        await transport.runScript("project-checkout", controller.signal);
        events.push("project-prepared");
        return { seedKey: PROJECT_KEY, cacheHit: false };
      }),
    },
    prepareNodeRuntime: vi.fn(async () => {
      events.push("runtime-granted");
      return {
        nodeBootstrap: createNodeBootstrapFixture(),
        workerBundle: createWorkerArchiveFixture(),
        signal: controller.signal,
      };
    }),
    beginNodeEnrollment: vi.fn(async () => {
      events.push("enrollment-begun");
      enrollmentStarted = true;
      return {
        mode: "connect" as const,
        setupCode: "synthetic-setup-code",
        setupId: "project-setup",
        openclawVersion: "2026.8.1",
        nodeBootstrap: createNodeBootstrapFixture(),
        displayName: "Project worker",
        signal: controller.signal,
        waitForDeviceId: async () => "project-node",
      };
    }),
  } satisfies ProvisionOptions;
  return { options, observe };
}

describe("Crabbox project snapshot provisioning", () => {
  it.each(["aws", "machine0", "daytona"])(
    "reuses A→B→A project caches on %s while only a reserve captures the replacement",
    async (backend) => {
      const profile = { ...PROFILE, provider: backend };
      const events: string[] = [];
      const now = Date.now();
      const preparation = {
        key: "a".repeat(64),
        cacheKey: "c".repeat(64),
        purpose: "session" as const,
        demandAtMs: now,
      };
      let current = projectOptions(events, new AbortController(), preparation);
      current.options.project.baseCommit = "a".repeat(40);
      let captures = 0;
      const { provider, calls } = createWarmProvider((call) => {
        current.observe(call);
        return call.argv[2] === "create"
          ? checkpointResult(
              ++captures === 1 ? CHECKPOINT_ID : "chk_commit_b",
              call.argv[call.argv.indexOf("--id") + 1]!,
              "available",
            )
          : undefined;
      });
      await provider.provision(profile, "commit-a-source", current.options);
      expect(captures).toBe(1);

      const next = { ...preparation, key: "b".repeat(64), demandAtMs: now + 1_000 };
      events.length = 0;
      calls.length = 0;
      current = projectOptions(events, new AbortController(), next);
      const foreground = await provider.provision(profile, "commit-b-session", current.options);
      expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
      expect(events).toEqual(["project-prepared", "enrollment-begun", "enrollment-install"]);
      expect(current.options.prepareNodeRuntime).not.toHaveBeenCalled();
      await provider.notePreparedDemand!(
        { leaseId: foreground.leaseId, profile },
        { preparationKey: next.key, demandAtMs: now + 2_000 },
      );
      expect(listCrabboxWarmImages()[0]?.lastDemandAtMs).toBe(now + 2_000);
      await provider.provision(profile, "commit-b-session", current.options);
      expect(captures).toBe(1);

      // Interrupted enrollment leaves a prepared allocation for destroy replay;
      // that cleanup must not turn the foreground checkout into a new image.
      current = projectOptions(events, new AbortController(), next);
      current.options.beginNodeEnrollment.mockRejectedValueOnce(
        new DOMException("Enrollment owner closed", "AbortError"),
      );
      await expect(
        provider.provision(profile, "commit-b-interrupted", current.options),
      ).rejects.toMatchObject({ name: "AbortError" });
      await provider.destroy({ leaseId: operationLeaseId("commit-b-interrupted"), profile });
      expect(captures).toBe(1);

      current = projectOptions(events, new AbortController(), { ...next, purpose: "reserve" });
      events.length = 0;
      const reserve = await provider.provision(profile, "commit-b-reserve", current.options);
      expect(captures).toBe(2);
      expect(events.indexOf("capture")).toBeLessThan(events.indexOf("enrollment-begun"));
      expect(listCrabboxWarmImages()[0]).toMatchObject({
        checkpointId: "chk_commit_b",
        preparationKey: next.key,
        cacheKey: next.cacheKey,
        purpose: "reserve",
        retirement: { checkpointId: CHECKPOINT_ID },
      });
      calls.length = 0;
      current = projectOptions(events, new AbortController(), next);
      await provider.provision(profile, "commit-b-session", current.options);
      expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
      await provider.notePreparedDemand!(
        { leaseId: foreground.leaseId, profile },
        { preparationKey: next.key, demandAtMs: now + 3_000 },
      );
      expect(listCrabboxWarmImages()[0]?.lastDemandAtMs).toBe(next.demandAtMs);
      await provider.destroy({ leaseId: foreground.leaseId, profile });
      expect(calls.some(({ argv }) => argv[2] === "delete")).toBe(false);
      await provider.destroy({ leaseId: reserve.leaseId, profile });
      expect(calls.filter(({ argv }) => argv[2] === "delete").map(({ argv }) => argv[3])).toEqual([
        CHECKPOINT_ID,
      ]);

      calls.length = 0;
      current = projectOptions(events, new AbortController(), preparation);
      current.options.project.baseCommit = "a".repeat(40);
      await provider.provision(profile, "commit-a-return", current.options);
      expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe("chk_commit_b");
      expect(captures).toBe(2);
    },
  );

  it("shares each freshly selected command budget with its script factory", async () => {
    const { options } = projectOptions([]);
    const timeoutMs = vi
      .fn()
      .mockReturnValueOnce(15_000)
      .mockReturnValueOnce(9_000)
      .mockReturnValueOnce(4_000);
    const runCommand = vi.fn<Parameters<typeof prepareCrabboxProjectFiles>[0]["runCommand"]>(
      async () => commandResult(),
    );
    const createScript = vi.fn((budget: number) => `setup-budget-${budget}`);
    options.project.prepare.mockImplementationOnce(async (transport) => {
      if (!transport.runScriptWithBudget) {
        throw new Error("Missing budgeted script transport");
      }
      await transport.runScript("seed-inspection", options.project.signal);
      await transport.upload("base.pack", "/project/base.pack", options.project.signal);
      await transport.runScriptWithBudget(createScript, options.project.signal);
      return { seedKey: PROJECT_KEY, cacheHit: false };
    });
    await prepareCrabboxProjectFiles({
      project: options.project,
      binary: "crabbox",
      provider: "aws",
      id: "project-budget",
      runArgs: ["run", "--script-stdin"],
      runCommand,
      timeoutMs,
    });
    expect(timeoutMs).toHaveBeenCalledTimes(3);
    expect(createScript).toHaveBeenCalledExactlyOnceWith(4_000);
    expect(runCommand.mock.calls.map(([, command]) => [command.input, command.timeoutMs])).toEqual([
      ["seed-inspection", 15_000],
      [undefined, 9_000],
      ["setup-budget-4000", 4_000],
    ]);
  });

  it("reuses prepared setup without inventing demand during refill and reports ready consumption", async () => {
    const events: string[] = [];
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const preparation = {
      key: "c".repeat(64),
      cacheKey: "d".repeat(64),
      purpose: "session" as const,
      demandAtMs: now,
    };
    const profile = { ...PROFILE, setup: "synthetic-profile-setup" };
    let current = projectOptions(events, new AbortController(), preparation);
    const { provider, calls } = createWarmProvider((call) => current.observe(call));
    await provider.provision(profile, "prepared-source", current.options);
    const cold = calls.find(({ argv }) => argv[1] === "warmup")!.argv;
    expect(cold.slice(cold.indexOf("--target"))).toEqual(["--target", "linux", "--arch", "amd64"]);
    clock.mockReturnValue(now + 60_000);
    calls.length = 0;
    current = projectOptions(events, new AbortController(), { ...preparation, purpose: "reserve" });
    const reserve = await provider.provision(profile, "prepared-reserve", current.options);
    const fork = calls.find(({ argv }) => argv[2] === "fork")!.argv;
    expect(fork.slice(fork.indexOf("--target"), -1)).toEqual([
      "--target",
      "linux",
      "--arch",
      "amd64",
    ]);
    expect(current.options.project.prepare).toHaveBeenCalledOnce();
    expect(calls.some(({ options }) => options.input === profile.setup)).toBe(false);
    expect(listCrabboxWarmImages()[0]?.lastDemandAtMs).toBe(now);
    await provider.notePreparedDemand!(
      { leaseId: reserve.leaseId, profile },
      { preparationKey: preparation.key, demandAtMs: now + 60_000 },
    );
    expect(listCrabboxWarmImages()[0]?.lastDemandAtMs).toBe(now + 60_000);
    expect(provider.resolvePreparedIdleTimeoutMs?.(profile)).toBe(3_600_000);
    expect(provider.resolvePreparationTarget?.(profile, "fast")).toEqual({
      machineClass: "fast",
      platform: "linux",
      arch: "x64",
    });
    expect(
      provider.resolvePreparedIdleTimeoutMs?.({ ...profile, setupEnv: ["MUTABLE_INPUT"] }),
    ).toBeUndefined();
    expect(
      provider.resolvePreparedIdleTimeoutMs?.({ ...profile, warmImage: false }),
    ).toBeUndefined();
  });

  it.each([
    { backend: "aws", lifecycleMs: 0 },
    { backend: "azure", lifecycleMs: 0 },
    { backend: "gcp", lifecycleMs: 0 },
    { backend: "daytona", lifecycleMs: 3 * 60_000 },
    { backend: "machine0", lifecycleMs: 30 * 60_000 },
  ])(
    "settles a retained $backend checkpoint through native waiting and source restoration before enrollment",
    async ({ backend, lifecycleMs }) => {
      const events: string[] = [];
      const startedAt = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(startedAt);
      const { options, observe } = projectOptions(events);
      const entered = createDeferred<void>();
      const available = createDeferred<void>();
      const { provider, calls } = createWarmProvider(async (call) => {
        observe(call);
        if (call.argv[2] !== "create") {
          return undefined;
        }
        entered.resolve();
        // Crabbox only continues an admitted checkpoint_pending response when wait is enabled.
        if (call.argv.includes("--wait=false")) {
          return commandResult({ code: 1, stderr: "http 503: checkpoint_pending" });
        }
        await available.promise;
        // Native availability can take almost Crabbox's 45m wait, with provider-owned
        // stop/restoration outside it. The old 3m/10m process cap killed that work.
        const elapsedMs = 45 * 60_000 - 15_000 + lifecycleMs;
        clock.mockReturnValue(startedAt + elapsedMs);
        if (call.options.timeoutMs <= elapsedMs) {
          return commandResult({ code: null, killed: true, termination: "timeout" });
        }
        const waitTimeoutIndex = call.argv.indexOf("--wait-timeout");
        expect(call.argv.slice(waitTimeoutIndex, waitTimeoutIndex + 2)).toEqual([
          "--wait-timeout",
          "45m",
        ]);
        return checkpointResult(CHECKPOINT_ID, operationLeaseId("retained-capture"), "available");
      });
      const provision = expect(
        provider.provision({ ...PROFILE, provider: backend }, "retained-capture", options),
      ).resolves.toMatchObject({ node: { deviceId: "project-node" } });
      await entered.promise;
      try {
        expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      } finally {
        available.resolve();
      }
      await provision;
      expect(listCrabboxWarmImages()[0]).toMatchObject({
        checkpointId: CHECKPOINT_ID,
        state: "available",
        allocations: { [operationLeaseId("retained-capture")]: { phase: "enrolled" } },
      });
      expect(calls.filter(({ argv }) => argv[2] === "create")).toHaveLength(1);
      expect(options.beginNodeEnrollment).toHaveBeenCalledOnce();
      expect(listCrabboxWarmImages()[0]?.capture).toBeUndefined();
    },
  );

  it.each(["project transfer", "runtime grant", "runtime setup", "enrollment setup"] as const)(
    "cancels explicit Stop during %s without replacing its narrower grant signal",
    async (phase) => {
      const events: string[] = [];
      const controller = new AbortController();
      const reason = new DOMException("Stop snapshot provisioning", "AbortError");
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const { options, observe } = projectOptions(events);
      const provisionOptions = { ...options, signal: controller.signal };
      let commandSignal: AbortSignal | undefined;
      const { provider, calls } = createWarmProvider(async (call) => {
        observe(call);
        const input = call.options.input?.toString();
        const currentPhase =
          input === "project-checkout"
            ? "project transfer"
            : call.argv[1] === "run" && call.argv.includes("CRABBOX_WORKER_BOOTSTRAP_TOKEN")
              ? events.includes("enrollment-begun")
                ? "enrollment setup"
                : "runtime setup"
              : undefined;
        if (currentPhase !== phase) {
          return undefined;
        }
        commandSignal = call.options.signal;
        entered.resolve();
        await release.promise;
        return commandResult({ code: 7, stderr: "command interrupted" });
      });
      if (phase === "runtime grant") {
        options.prepareNodeRuntime.mockImplementationOnce(async () => {
          entered.resolve();
          await release.promise;
          return {
            nodeBootstrap: createNodeBootstrapFixture(),
            workerBundle: createWorkerArchiveFixture(),
            signal: options.project.signal,
          };
        });
      }
      let settled = false;
      const operation = provider
        .provision(PROFILE, `stop-${phase}`, provisionOptions)
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await entered.promise;
      const commandCount = calls.length;
      try {
        controller.abort(reason);
        await setImmediate();
        expect(options.project.signal.aborted).toBe(false);
        if (phase !== "runtime grant") {
          expect(commandSignal?.aborted).toBe(true);
        }
        expect(settled).toBe(false);
        expect(calls).toHaveLength(commandCount);
      } finally {
        release.resolve();
        await operation;
      }
      expect(await operation).toBe(reason);
      expect(calls).toHaveLength(commandCount);
      if (phase !== "enrollment setup") {
        expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      }
      expect(calls.some(({ argv }) => argv[1] === "stop" || argv[1] === "heartbeat")).toBe(false);
    },
  );

  it.each(["runtime-install", "enrollment-install"])(
    "completes internal %s without another provider readiness request",
    async (phase) => {
      const events: string[] = [];
      const { options, observe } = projectOptions(events);
      const { provider, calls } = createWarmProvider((call) => {
        observe(call);
        if ((call.argv[1] === "inspect" || call.argv[1] === "status") && events.at(-1) === phase) {
          return commandResult({ termination: "timeout", code: null, killed: true });
        }
        return undefined;
      });

      await expect(
        provider.provision(PROFILE, `internal-${phase}`, options),
      ).resolves.toMatchObject({
        node: { deviceId: "project-node" },
      });
      expect(events).toContain(phase);
      expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
    },
  );

  it.each(["aws", "daytona", "machine0"])(
    "captures the prepared %s project before enrollment and reuses it",
    async (backend) => {
      const profile = { ...PROFILE, provider: backend };
      const events: string[] = [];
      let current = projectOptions(events);
      const { provider, calls } = createWarmProvider((call) => {
        current.observe(call);
        if (
          backend === "daytona" &&
          call.argv[2] === "create" &&
          !call.argv.includes("--no-reboot=false")
        ) {
          return commandResult({
            code: 2,
            stderr:
              "Daytona filesystem snapshots require a stopped source; rerun with --no-reboot=false",
          });
        }
        return undefined;
      });

      await provider.provision(profile, "project-first", current.options);

      expect(events).toEqual([
        "project-prepared",
        "runtime-granted",
        "runtime-install",
        "capture",
        "enrollment-begun",
        "enrollment-install",
      ]);
      expect(listCrabboxWarmImages()[0]).toMatchObject({
        projectKey: PROJECT_KEY,
        checkpointId: CHECKPOINT_ID,
        allocations: {
          [operationLeaseId("project-first")]: { phase: "enrolled", baseCommit: BASE_COMMIT },
        },
      });
      // The first worker is still running: a new session can already use its clean image.
      calls.length = 0;
      events.length = 0;
      current = projectOptions(events);
      await provider.provision(profile, "project-second", current.options);
      expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
      expect(calls.some(({ argv }) => argv[1] === "warmup" || argv[2] === "create")).toBe(false);
      // Pending images need verification before the fork; a successful fork already attests reuse.
      expect(calls.filter(({ argv }) => argv[2] === "inspect")).toHaveLength(1);
      expect(events).toEqual(["project-prepared", "enrollment-begun", "enrollment-install"]);
      expect(current.options.prepareNodeRuntime).not.toHaveBeenCalled();
      // A cache hit does not restart the machine; only allocation needs provider readiness.
      expect(
        calls.filter(({ argv }) => argv[1] === "inspect" || argv[1] === "status"),
      ).toHaveLength(1);
    },
  );

  it.each(["grant", "setup", "readiness"] as const)(
    "preserves preparation %s failure ownership without enrollment",
    async (failure) => {
      const events: string[] = [];
      const { options, observe } = projectOptions(events);
      if (failure === "grant") {
        options.prepareNodeRuntime.mockRejectedValueOnce(new Error("runtime grant failed"));
      }
      let captured = false;
      const { provider, calls } = createWarmProvider((call) => {
        observe(call);
        if (call.argv[1] === "run" && call.argv.includes("CRABBOX_WORKER_BOOTSTRAP_TOKEN")) {
          if (failure === "setup") {
            return commandResult({ code: 7, stderr: "runtime setup failed" });
          }
        }
        captured ||= call.argv[2] === "create";
        if (captured && failure === "readiness" && call.argv[1] === "inspect") {
          return commandResult({ termination: "timeout", code: null, killed: true });
        }
        return undefined;
      });
      await expect(provider.provision(PROFILE, `runtime-${failure}`, options)).rejects.toThrow();
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(calls.some(({ argv }) => argv[2] === "create")).toBe(failure === "readiness");
      expect(calls.filter(({ argv }) => argv[1] === "stop")).toHaveLength(
        failure === "readiness" ? 0 : 1,
      );
      expect(listCrabboxWarmImages().every((image) => !image.capture)).toBe(true);
      if (failure === "readiness") {
        expect(
          listCrabboxWarmImages()[0]?.allocations[operationLeaseId(`runtime-${failure}`)],
        ).toMatchObject({ phase: "prepared", choice: { kind: "cold" } });
      }
    },
  );

  it.each(["resolve", "reject"] as const)(
    "fences a runtime grant that will %s after project ownership changes",
    async (outcome) => {
      const events: string[] = [];
      const controller = new AbortController();
      const { options, observe } = projectOptions(events, controller);
      const { provider, calls } = createWarmProvider(observe);
      let current = true;
      const closed = new DOMException("Project owner changed", "AbortError");
      options.project.assertCurrent = () => {
        if (!current) {
          controller.abort(closed);
        }
        controller.signal.throwIfAborted();
      };
      options.prepareNodeRuntime.mockImplementationOnce(async () => {
        current = false;
        expect(controller.signal.aborted).toBe(false);
        if (outcome === "reject") {
          throw closed;
        }
        return {
          nodeBootstrap: createNodeBootstrapFixture(),
          workerBundle: createWorkerArchiveFixture(),
          signal: new AbortController().signal,
        };
      });

      await expect(
        provider.provision(PROFILE, `stale-grant-${outcome}`, options),
      ).rejects.toMatchObject({
        name: "AbortError",
      });

      expect(events).not.toContain("runtime-install");
      expect(calls.some(({ argv }) => argv[1] === "stop" || argv[2] === "create")).toBe(false);
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(listCrabboxWarmImages()[0]).toMatchObject({
        allocations: {
          [operationLeaseId(`stale-grant-${outcome}`)]: {
            phase: "prepared",
            choice: { kind: "cold" },
          },
        },
      });
      expect(listCrabboxWarmImages()[0]?.capture).toBeUndefined();
    },
  );

  it.each(["aborted", "uncertain", "timed out"] as const)(
    "does not enroll after an %s native capture",
    async (failure) => {
      const events: string[] = [];
      const controller = new AbortController();
      const { options, observe } = projectOptions(events, controller);
      const { provider, calls } = createWarmProvider((call) => {
        observe(call);
        if (call.argv[2] !== "create") {
          return undefined;
        }
        if (failure === "aborted") {
          controller.abort();
        }
        expect(call.options.signal).toBe(controller.signal);
        return failure === "timed out"
          ? commandResult({ code: null, killed: true, termination: "timeout" })
          : commandResult({ code: 7, stderr: "capture response lost" });
      });

      await expect(provider.provision(PROFILE, `project-${failure}`, options)).rejects.toThrow();

      expect(events).toContain("capture");
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(events).not.toContain("enrollment-install");
      expect(listCrabboxWarmImages()[0]?.capture?.phase).toBe("uncertain");
      expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(failure !== "aborted");
    },
  );

  it("preserves the lease when enrollment's owning operation has closed", async () => {
    const { provider, calls } = createWarmProvider();
    const beginNodeEnrollment = vi.fn(async () => {
      throw new DOMException("Worker provisioning operation is closed", "AbortError");
    });
    await expect(
      provider.provision({ ...PROFILE, warmImage: false }, "closed-enrollment", {
        beginNodeEnrollment,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(beginNodeEnrollment).toHaveBeenCalledOnce();
    expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(false);
  });

  it.each([
    { ...PROFILE, warmImage: false },
    { ...CLASSLESS_PROFILE, class: "standard", setup: "true", setupEnv: ["PROJECT_SETUP_VALUE"] },
  ])(
    "keeps explicitly or implicitly opted-out profiles on their existing enrollment path: %j",
    async (profile) => {
      vi.stubEnv("PROJECT_SETUP_VALUE", "synthetic");
      const events: string[] = [];
      const { options, observe } = projectOptions(events);
      const { provider, calls } = createWarmProvider((call) => observe(call));
      expect(provider.supportsProjectPreparation?.(profile)).toBe(false);
      await provider.provision(profile, "project-optout", options);
      expect(options.project.prepare).not.toHaveBeenCalled();
      expect(options.prepareNodeRuntime).not.toHaveBeenCalled();
      expect(options.beginNodeEnrollment).toHaveBeenCalledOnce();
      expect(calls.some(({ argv }) => argv[1] === "checkpoint")).toBe(false);
      expect(listCrabboxWarmImages()).toEqual([]);
    },
  );
});
