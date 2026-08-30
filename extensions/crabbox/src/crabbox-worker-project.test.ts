import type { WorkerProvider } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createNodeBootstrapFixture } from "./crabbox-worker-node-enrollment.test-support.js";
import { operationLeaseId } from "./crabbox-worker-profile.js";
import { listCrabboxWarmImages } from "./crabbox-worker-warm-image-store.js";
import {
  CHECKPOINT_ID,
  CLASSLESS_PROFILE,
  PROFILE,
  commandResult,
  createWarmProvider,
  type CommandCall,
} from "./crabbox-worker-warm-image.test-support.js";

type ProvisionOptions = NonNullable<Parameters<WorkerProvider["provision"]>[2]>;
const PROJECT_KEY = "a".repeat(64);
const BASE_COMMIT = "b".repeat(40);

function projectOptions(events: string[], controller = new AbortController()) {
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
      return { nodeBootstrap: createNodeBootstrapFixture(), signal: controller.signal };
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
  it("captures the checked-out project and runtime before enrollment, then forks without another capture", async () => {
    const events: string[] = [];
    let current = projectOptions(events);
    const { provider, calls } = createWarmProvider((call) => current.observe(call));

    await provider.provision(PROFILE, "project-first", current.options);

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
    await provider.provision(PROFILE, "project-second", current.options);
    expect(calls.find(({ argv }) => argv[2] === "fork")?.argv[3]).toBe(CHECKPOINT_ID);
    expect(calls.some(({ argv }) => argv[1] === "warmup" || argv[2] === "create")).toBe(false);
    expect(events).toEqual(["project-prepared", "enrollment-begun", "enrollment-install"]);
    expect(current.options.prepareNodeRuntime).not.toHaveBeenCalled();
    // Allocation and normal enrollment each inspect once; a cache hit causes no native restart.
    expect(calls.filter(({ argv }) => argv[1] === "inspect")).toHaveLength(2);
  });

  it.each(["grant", "setup", "readiness"] as const)(
    "preserves runtime %s failure ownership without starting capture or enrollment",
    async (failure) => {
      const events: string[] = [];
      const { options, observe } = projectOptions(events);
      if (failure === "grant") {
        options.prepareNodeRuntime.mockRejectedValueOnce(new Error("runtime grant failed"));
      }
      let installed = false;
      const { provider, calls } = createWarmProvider((call) => {
        observe(call);
        if (call.argv[1] === "run" && call.argv.includes("CRABBOX_WORKER_BOOTSTRAP_TOKEN")) {
          installed = true;
          if (failure === "setup") {
            return commandResult({ code: 7, stderr: "runtime setup failed" });
          }
        }
        if (installed && failure === "readiness" && call.argv[1] === "inspect") {
          return commandResult({ termination: "timeout", code: null, killed: true });
        }
        return undefined;
      });
      await expect(provider.provision(PROFILE, `runtime-${failure}`, options)).rejects.toThrow();
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(calls.some(({ argv }) => argv[2] === "create")).toBe(false);
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

  it.each(["aborted", "uncertain"] as const)(
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
        return commandResult({ code: 7, stderr: "capture response lost" });
      });

      await expect(provider.provision(PROFILE, `project-${failure}`, options)).rejects.toThrow();

      expect(events).toContain("capture");
      expect(options.beginNodeEnrollment).not.toHaveBeenCalled();
      expect(events).not.toContain("enrollment-install");
      expect(listCrabboxWarmImages()[0]?.capture?.phase).toBe("uncertain");
      expect(calls.some(({ argv }) => argv[1] === "stop")).toBe(failure === "uncertain");
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
