import path from "node:path";
import type { HealthCheck } from "openclaw/plugin-sdk/health";
import { describe, expect, it, vi } from "vitest";
import * as doctorRuntime from "./crabbox-worker-doctor-runtime.js";
import {
  CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
  registerCrabboxWorkerProviderDoctorChecks,
} from "./doctor.js";

const OPENCLAW_ROOT = path.resolve(path.sep, "workspace", "openclaw");

function captureCrabboxDoctorCheck(): HealthCheck {
  let check: HealthCheck | undefined;
  registerCrabboxWorkerProviderDoctorChecks({
    openclawRoot: OPENCLAW_ROOT,
    registerHealthCheck(value) {
      check = value;
    },
  });
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

  it("detects and removes only stale Crabbox desktop settings", async () => {
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
          secondary: {
            provider: " CRABBOX ",
            settings: { binary: process.execPath, desktop: true, idleTimeout: "30m" },
          },
          disabled: {
            provider: "crabbox",
            settings: { binary: process.execPath, desktop: false },
          },
          absent: { provider: "crabbox", settings: { binary: process.execPath } },
          malformed: {
            provider: "crabbox",
            settings: { binary: process.execPath, desktop: "true" },
          },
          other: { provider: "device", settings: { desktop: true } },
        },
      },
    } as const;
    const before = structuredClone(cfg);
    const check = captureCrabboxDoctorCheck();
    try {
      const findings = await check.detect({ cfg } as never);
      expect(findings).toEqual([
        expect.objectContaining({
          checkId: CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID,
          severity: "warning",
          message: expect.stringContaining("node transport no longer supports desktop profiles"),
          ocPath: "cloudWorkers.profiles.aws.settings.desktop",
          target: "aws",
          fixHint: expect.stringContaining("openclaw doctor --fix"),
        }),
        expect.objectContaining({
          ocPath: "cloudWorkers.profiles.secondary.settings.desktop",
          target: "secondary",
        }),
      ]);

      const repaired = await check.repair!({ cfg, dryRun: true } as never, findings);
      expect(cfg).toEqual(before);
      expect(repaired.config).toEqual({
        cloudWorkers: {
          desktop: true,
          profiles: {
            aws: {
              provider: "crabbox",
              install: "npm",
              settings: { binary: process.execPath, class: "fast", ttl: "12h" },
            },
            secondary: {
              provider: " CRABBOX ",
              settings: { binary: process.execPath, idleTimeout: "30m" },
            },
            disabled: {
              provider: "crabbox",
              settings: { binary: process.execPath, desktop: false },
            },
            absent: { provider: "crabbox", settings: { binary: process.execPath } },
            malformed: {
              provider: "crabbox",
              settings: { binary: process.execPath, desktop: "true" },
            },
            other: { provider: "device", settings: { desktop: true } },
          },
        },
      });
      expect(repaired.changes).toHaveLength(2);

      await expect(check.repair!({ cfg: repaired.config } as never, findings)).resolves.toEqual({
        config: repaired.config,
        changes: [],
      });
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
