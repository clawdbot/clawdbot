import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { buildUpdateRestartSentinelPayload } from "../infra/update-restart-sentinel-payload.js";
import { createUpdateRun, recordUpdateRunPhase } from "../infra/update-run-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { finalizeRestartUpdateRun } from "./server-restart-update-run.js";

const directories = createTempDirTracker();
afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  directories.cleanup();
});

describe("update restart verification ownership", () => {
  it.each(["api", "chat", "control-ui", "campaign"] as const)(
    "finishes an unmanaged %s update after replacement startup",
    async (trigger) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("update-unmanaged-boot-"));
      const version = resolveRuntimeServiceVersion();
      const run = createUpdateRun({ trigger, target: { version } });
      recordUpdateRunPhase(run.runId, "restarting", { after: { version } });
      const payload = buildUpdateRestartSentinelPayload({
        result: { status: "ok", mode: "npm", after: { version }, steps: [], durationMs: 1 },
        meta: { runId: run.runId },
      });
      expect(await finalizeRestartUpdateRun(payload)).toMatchObject({
        status: "succeeded",
        phase: "finished",
        finishedAtMs: expect.any(Number),
        verification: { booted: true, serviceRunning: true, versionMatch: true },
      });
    },
  );

  it.each(["api", "chat", "control-ui", "campaign"] as const)(
    "preserves managed %s verification after replacement startup",
    async (trigger) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("update-managed-boot-"));
      const version = resolveRuntimeServiceVersion();
      const run = createUpdateRun({ trigger, target: { version } });
      recordUpdateRunPhase(run.runId, "verifying", { after: { version } });
      const payload = buildUpdateRestartSentinelPayload({
        result: { status: "ok", mode: "npm", after: { version }, steps: [], durationMs: 1 },
        meta: { runId: run.runId, handoffId: "managed-update-handoff" },
      });
      expect(await finalizeRestartUpdateRun(payload, true)).toMatchObject({
        status: "running",
        phase: "verifying",
        finishedAtMs: null,
        verification: { booted: true, serviceRunning: true, versionMatch: true },
      });
    },
  );

  it("fails an expired unmanaged pending restart", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("update-unmanaged-expiry-"));
    const run = createUpdateRun({ trigger: "api" });
    recordUpdateRunPhase(run.runId, "restarting");
    expect(
      await finalizeRestartUpdateRun(
        {
          kind: "update",
          status: "skipped",
          ts: Date.now(),
          stats: { runId: run.runId, reason: "restart-health-pending" },
        },
        true,
      ),
    ).toMatchObject({ status: "failed", phase: "finished", reason: "restart-unhealthy" });
  });

  it.each([
    "requested",
    "staging",
    "validating",
    "repairing",
    "activating",
    "restarting",
    "verifying",
  ] as const)("does not let sentinel expiry finish the orchestrator during %s", async (phase) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", directories.make("update-boot-owner-"));
    const run = createUpdateRun({
      trigger: "cli",
      target: { version: resolveRuntimeServiceVersion() },
    });
    recordUpdateRunPhase(run.runId, phase);
    const observed = await finalizeRestartUpdateRun(
      {
        kind: "update",
        status: "skipped",
        ts: Date.now(),
        stats: { runId: run.runId, reason: "restart-health-pending" },
      },
      true,
    );
    expect(observed).toMatchObject({
      status: "running",
      phase: phase === "restarting" ? "verifying" : phase,
      confirmedAtMs: null,
      verification: { booted: true },
    });
  });
});
