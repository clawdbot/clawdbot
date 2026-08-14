import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  entries: [] as Array<{
    pluginId: string;
    migration: {
      id: string;
      label: string;
      doctorOnly?: boolean;
      preflightStartup?: (params: unknown) => unknown;
    };
  }>,
}));

vi.mock("../plugins/doctor-contract-registry.js", () => ({
  listPluginDoctorStateMigrationEntries: () => mocks.entries,
}));

import { collectGatewayStartupPreflight } from "./startup-preflight.js";

describe("gateway startup preflight collection", () => {
  beforeEach(() => {
    mocks.entries = [];
  });

  it("keeps blockers visible while reporting indeterminate checks and stable ordering", async () => {
    mocks.entries = [
      {
        pluginId: "zeta",
        migration: {
          id: "ready",
          label: "Ready",
          preflightStartup: () => ({ status: "ready" }),
        },
      },
      {
        pluginId: "alpha",
        migration: {
          id: "mixed",
          label: "Mixed",
          preflightStartup: () => ({
            status: "indeterminate",
            reason: "provider inspection unsupported",
            findings: [
              {
                id: "agent-b/local/missing",
                code: "missing",
                message: "missing setup",
                provider: "local",
              },
            ],
          }),
        },
      },
      {
        pluginId: "beta",
        migration: {
          id: "blocked",
          label: "Blocked",
          preflightStartup: () => ({
            status: "blocked",
            findings: [
              {
                id: "agent-a/local/config",
                code: "config",
                message: "invalid config",
              },
            ],
          }),
        },
      },
      {
        pluginId: "skipped",
        migration: {
          id: "doctor-only",
          label: "Doctor only",
          doctorOnly: true,
          preflightStartup: () => {
            throw new Error("must not run");
          },
        },
      },
    ];

    await expect(
      collectGatewayStartupPreflight({
        config: {},
        env: { HOME: "/tmp/preflight-home", OPENCLAW_STATE_DIR: "/tmp/preflight-state" },
      }),
    ).resolves.toEqual({
      checksRun: 3,
      blockers: [
        expect.objectContaining({
          id: "alpha/mixed/agent-b/local/missing",
          pluginId: "alpha",
          code: "missing",
        }),
        expect.objectContaining({
          id: "beta/blocked/agent-a/local/config",
          pluginId: "beta",
          code: "config",
        }),
      ],
      errors: [
        {
          id: "alpha/mixed",
          pluginId: "alpha",
          migrationId: "mixed",
          code: "inspection-indeterminate",
          message: "provider inspection unsupported",
        },
      ],
    });
  });

  it("turns thrown checks and empty blocked results into inspection errors", async () => {
    mocks.entries = [
      {
        pluginId: "throwing",
        migration: {
          id: "throws",
          label: "Throws",
          preflightStartup: () => {
            throw new Error("read failed");
          },
        },
      },
      {
        pluginId: "empty",
        migration: {
          id: "empty",
          label: "Empty",
          preflightStartup: () => ({ status: "blocked", findings: [] }),
        },
      },
    ];

    const result = await collectGatewayStartupPreflight({
      config: {},
      env: { HOME: "/tmp/preflight-home", OPENCLAW_STATE_DIR: "/tmp/preflight-state" },
    });

    expect(result.checksRun).toBe(2);
    expect(result.blockers).toEqual([]);
    expect(result.errors).toEqual([
      expect.objectContaining({ id: "empty/empty", code: "invalid-inspection-result" }),
      expect.objectContaining({ id: "throwing/throws", code: "inspection-failed" }),
    ]);
  });
});
