import path from "node:path";
import type { HealthCheck, HealthRepairContext } from "openclaw/plugin-sdk/health";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as doctorRuntime from "./crabbox-worker-doctor-runtime.js";
import {
  openCrabboxWarmImageStore,
  type WarmImageRecord,
} from "./crabbox-worker-warm-image-store.js";
import {
  CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
  registerCrabboxWorkerProviderDoctorChecks,
} from "./doctor.js";

const OPENCLAW_ROOT = path.resolve(path.sep, "workspace", "openclaw");
const CRABBOX_WARM_IMAGES_CHECK_ID = "crabbox/warm-images";

function captureCrabboxDoctorCheck(id = CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID): HealthCheck {
  const checks = new Map<string, HealthCheck>();
  registerCrabboxWorkerProviderDoctorChecks({
    openclawRoot: OPENCLAW_ROOT,
    getHealthCheck: (key) => checks.get(key),
    registerHealthCheck(value) {
      checks.set(value.id, value);
    },
  });
  const check = checks.get(id);
  if (!check) {
    throw new Error("Crabbox doctor check was not registered");
  }
  return check;
}

describe("Crabbox worker doctor", () => {
  it("reports a configured non-executable binary with a profile-specific repair", async () => {
    const probe = vi.spyOn(doctorRuntime, "probeCrabboxVersion");
    const binary = path.resolve(path.sep, "nonexistent", "crabbox");
    try {
      await expect(
        captureCrabboxDoctorCheck().detect({
          cfg: {
            cloudWorkers: {
              profiles: {
                aws: { provider: "crabbox", settings: { binary } },
              },
            },
          },
          env: { PATH: "" },
        } as never),
      ).resolves.toEqual([
        expect.objectContaining({
          checkId: CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
          severity: "warning",
          message: expect.stringContaining('profile "aws"'),
          path: binary,
          target: "aws",
          fixHint: expect.stringContaining("cloudWorkers.profiles.aws.settings.binary"),
        }),
      ]);
      expect(probe).not.toHaveBeenCalled();
    } finally {
      probe.mockRestore();
    }
  });

  it("emits no finding for a supported configured binary", async () => {
    const probe = vi
      .spyOn(doctorRuntime, "probeCrabboxVersion")
      .mockResolvedValue({ status: "supported", version: "0.41.6" });
    try {
      await expect(
        captureCrabboxDoctorCheck().detect({
          cfg: {
            cloudWorkers: {
              profiles: {
                aws: { provider: "crabbox", settings: { binary: process.execPath } },
              },
            },
          },
        } as never),
      ).resolves.toEqual([]);
      expect(probe).toHaveBeenCalledOnce();
    } finally {
      probe.mockRestore();
    }
  });

  it("reports an indeterminate version probe without asserting failure", async () => {
    const probe = vi.spyOn(doctorRuntime, "probeCrabboxVersion").mockResolvedValue({
      status: "indeterminate",
      reason: "version command timed out after 2000 ms",
    });
    try {
      await expect(
        captureCrabboxDoctorCheck().detect({
          cfg: {
            cloudWorkers: {
              profiles: {
                aws: { provider: "crabbox", settings: { binary: process.execPath } },
              },
            },
          },
        } as never),
      ).resolves.toEqual([
        expect.objectContaining({
          severity: "info",
          message: expect.stringContaining("could not determine its version"),
          fixHint: expect.stringContaining(`${process.execPath} --version`),
        }),
      ]);
    } finally {
      probe.mockRestore();
    }
  });

  it("accepts desktop-capable AWS and Hetzner profiles", async () => {
    const probe = vi
      .spyOn(doctorRuntime, "probeCrabboxVersion")
      .mockResolvedValue({ status: "supported", version: "0.41.6" });
    const cfg = {
      cloudWorkers: {
        desktop: true,
        profiles: {
          aws: {
            provider: "crabbox",
            install: "npm",
            settings: { binary: process.execPath, class: "fast", desktop: true, ttl: "12h" },
          },
          hetzner: {
            provider: " CRABBOX ",
            settings: {
              binary: process.execPath,
              provider: "hetzner",
              desktop: true,
              idleTimeout: "30m",
            },
          },
        },
      },
    } as const;
    const check = captureCrabboxDoctorCheck();
    try {
      await expect(check.detect({ cfg } as never)).resolves.toEqual([]);
      expect(probe).toHaveBeenCalledOnce();
    } finally {
      probe.mockRestore();
    }
  });

  it("does not probe when no Crabbox cloud worker profile is configured", async () => {
    const probe = vi.spyOn(doctorRuntime, "probeCrabboxVersion");
    try {
      await expect(captureCrabboxDoctorCheck().detect({ cfg: {} } as never)).resolves.toEqual([]);
      expect(probe).not.toHaveBeenCalled();
    } finally {
      probe.mockRestore();
    }
  });
});

describe("Crabbox warm-image doctor", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  afterEach(() => {
    resetPluginStateStoreForTests();
    vi.restoreAllMocks();
  });

  it.each([
    { name: "healthy checkpoint", operation: undefined, severity: undefined },
    { name: "fresh capture", operation: "capture", severity: "info" },
    { name: "paused capture", operation: "stale", severity: "warning" },
    { name: "failed capture", operation: "uncertain", severity: "warning" },
    { name: "pending retirement", operation: "retire", severity: "warning" },
  ] as const)(
    "reports $name without repairing state or probing providers",
    async ({ operation, severity }) => {
      const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-crabbox-warm-doctor-") };
      const store = openCrabboxWarmImageStore(env);
      const now = Date.now();
      const record: WarmImageRecord = {
        checkpointId: "chk_last_good",
        kind: "native",
        state: "available",
        createdAtMs: now,
        lastUsedAtMs: now,
        ...(operation
          ? {
              operation:
                operation === "retire"
                  ? { type: "retire" as const, checkpointId: "chk_predecessor" }
                  : {
                      type: "capture" as const,
                      id: "capture-selector",
                      startedAtMs: now - (operation === "stale" ? 1_200_000 : 0),
                      leaseId: "cbx_capture",
                      provider: "aws",
                      phase:
                        operation === "uncertain" ? ("uncertain" as const) : ("creating" as const),
                    },
            }
          : {}),
      };
      store.register("profile", record);
      const probe = vi.spyOn(doctorRuntime, "probeCrabboxVersion");
      const command = vi
        .spyOn(processRuntime, "runCommandWithTimeout")
        .mockRejectedValue(new Error("Provider commands are forbidden in this Doctor proof"));
      const check = captureCrabboxDoctorCheck(CRABBOX_WARM_IMAGES_CHECK_ID);
      const context: HealthRepairContext = {
        cfg: {},
        env,
        mode: "fix",
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      };

      const findings = await check.detect(context);

      expect(findings).toEqual(
        severity
          ? [
              expect.objectContaining({
                checkId: CRABBOX_WARM_IMAGES_CHECK_ID,
                target: "profile",
                severity,
                fixHint: expect.stringContaining("openclaw crabbox warm-images"),
              }),
            ]
          : [],
      );
      if (operation === "stale") {
        expect(findings[0]?.fixHint).toContain(
          "--recover capture-selector --acknowledge-provider-cleanup",
        );
      }
      await check.repair?.(context, findings);
      expect(store.lookup("profile")).toEqual(record);
      expect(command).not.toHaveBeenCalled();
      expect(probe).not.toHaveBeenCalled();
    },
  );

  it.each([CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID, CRABBOX_WARM_IMAGES_CHECK_ID])(
    "registers each check once when %s was already loaded",
    (existingId) => {
      const checks = new Map([[existingId, captureCrabboxDoctorCheck(existingId)]]);
      const registerHealthCheck = vi.fn((check: HealthCheck) => checks.set(check.id, check));
      const host = {
        openclawRoot: OPENCLAW_ROOT,
        getHealthCheck: (id: string) => checks.get(id),
        registerHealthCheck,
      };

      registerCrabboxWorkerProviderDoctorChecks(host);
      registerCrabboxWorkerProviderDoctorChecks(host);

      expect([...checks.keys()].toSorted()).toEqual(
        [CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID, CRABBOX_WARM_IMAGES_CHECK_ID].toSorted(),
      );
      expect(registerHealthCheck).toHaveBeenCalledOnce();
    },
  );
});
