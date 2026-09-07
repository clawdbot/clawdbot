import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  acknowledgeAbandonedUpdateRun,
  createUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunPhase,
  recordUpdateRunStep,
} from "../../infra/update-run-ledger.js";
import type { UpdateRunRecord } from "../../infra/update-run-record.js";
import { ABANDONED_UPDATE_RUN_MS } from "../../infra/update-run-timeouts.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { registerUpdateCli } from "../update-cli.js";
import { updateRepairCommand } from "./update-repair-command.js";

const mocks = vi.hoisted(() => ({
  finalize: vi.fn(async (_opts: unknown, _recoveryRunIds?: readonly string[]) => {}),
  readConfig: vi.fn(async () => ({ valid: true })),
  configWriteAllowed: vi.fn(),
  ownershipAllowed: vi.fn(async () => {}),
  resolveRoot: vi.fn(async () => ""),
  reachable: vi.fn(async () => ({
    reachable: true,
    gatewayVersion: "2026.9.3",
    gatewayBuildId: "installed-build" as string | null,
    activatedPluginErrors: [] as { id: string; error: string }[],
    channelProbeErrors: [] as { id: string; error: string }[],
  })),
  readiness: vi.fn(async () => ({ healthz: 200, readyz: 200 })),
  runtime: { log: vi.fn(), error: vi.fn(), writeJson: vi.fn(), exit: vi.fn() },
}));

vi.mock("../../config/config.js", () => ({
  assertConfigWriteAllowedInCurrentMode: mocks.configWriteAllowed,
  readConfigFileSnapshot: mocks.readConfig,
}));
vi.mock("../../state/openclaw-state-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/openclaw-state-ownership.js")>()),
  assertOpenClawStateWriteAllowedAtPath: mocks.ownershipAllowed,
}));
vi.mock("../daemon-cli/restart-health-probe.js", () => ({
  resolveGatewayRestartProbeContext: async () => ({ config: {}, auth: undefined }),
  confirmGatewayReachable: mocks.reachable,
  waitForGatewayHttpReadiness: mocks.readiness,
}));
vi.mock("./update-command-finalize.js", () => ({ updateFinalizeCommand: mocks.finalize }));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveUpdateRoot: mocks.resolveRoot,
}));
vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));

const tempDirs = createTempDirTracker();
const now = Date.now();

function seedRun(
  params: { phase?: UpdateRunRecord["phase"]; liveDriver?: boolean; ageMs?: number } = {},
) {
  vi.mocked(Date.now).mockReturnValue(now - (params.ageMs ?? 3_600_000));
  const driver = params.liveDriver ? readUpdateRunDriver() : undefined;
  const run = createUpdateRun({
    trigger: "control-ui",
    before: { version: "2026.9.2" },
    ...(driver ? { origin: { driver } } : {}),
  });
  if (params.phase) {
    recordUpdateRunPhase(run.runId, params.phase);
  }
  vi.mocked(Date.now).mockReturnValue(now);
  return getUpdateRun(run.runId)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-update-repair-"));
  const root = tempDirs.make("openclaw-update-repair-install-");
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.3" }));
  fs.writeFileSync(
    path.join(root, "dist", "build-info.json"),
    JSON.stringify({ buildId: "installed-build" }),
  );
  mocks.resolveRoot.mockResolvedValue(root);
  mocks.readConfig.mockResolvedValue({ valid: true });
  mocks.reachable.mockResolvedValue({
    reachable: true,
    gatewayVersion: "2026.9.3",
    gatewayBuildId: "installed-build",
    activatedPluginErrors: [],
    channelProbeErrors: [],
  });
  mocks.readiness.mockResolvedValue({ healthz: 200, readyz: 200 });
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  tempDirs.cleanup();
});

describe("update repair ledger recovery", () => {
  it.each([undefined, "staging"] as const)(
    "repairs an abandoned %s row through the public command without maintenance",
    async (phase) => {
      const run = seedRun({ phase });

      await runRegisteredCli({ register: registerUpdateCli, argv: ["update", "repair", "--json"] });

      expect(getUpdateRun(run.runId)).toMatchObject({ status: "failed", reason: "abandoned" });
      expect(listUpdateRuns({ active: true })).toEqual([]);
      expect(mocks.finalize).not.toHaveBeenCalled();
      expect(mocks.runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "ok",
          mode: "repair",
          restart: false,
          reconciledRuns: [run.runId],
        }),
      );
      expect(mocks.runtime.exit).not.toHaveBeenCalledWith(1);
    },
  );

  it("exits successfully when the Gateway already reconciled the abandoned row", async () => {
    const run = seedRun();
    finishUpdateRun(run.runId, { status: "failed", reason: "abandoned" });

    await updateRepairCommand({});

    expect(getUpdateRun(run.runId)).toMatchObject({
      status: "failed",
      reason: "abandoned",
      steps: expect.arrayContaining([
        expect.objectContaining({ step: "reconcile:acknowledged", status: "completed" }),
      ]),
    });
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.runtime.log).toHaveBeenCalledWith(expect.stringContaining("already reconciled"));
  });

  it.each(["repair", "gateway"] as const)(
    "runs full repair on the next invocation after acknowledging %s reconciliation",
    async (owner) => {
      const run = seedRun();
      if (owner === "gateway") {
        finishUpdateRun(run.runId, { status: "failed", reason: "abandoned" });
      }

      await updateRepairCommand({});
      expect(mocks.finalize).not.toHaveBeenCalled();
      await updateRepairCommand({});

      expect(mocks.finalize).toHaveBeenCalledExactlyOnceWith({}, []);
      expect(getUpdateRun(run.runId)).toMatchObject({ status: "failed", reason: "abandoned" });
    },
  );

  it("runs full repair when an abandoned outcome is older than the recovery window", async () => {
    const run = seedRun();
    vi.mocked(Date.now).mockReturnValue(now - ABANDONED_UPDATE_RUN_MS - 10);
    finishUpdateRun(run.runId, { status: "failed", reason: "abandoned" });
    vi.mocked(Date.now).mockReturnValue(now);
    const recorded = getUpdateRun(run.runId);

    await updateRepairCommand({});

    expect(mocks.finalize).toHaveBeenCalledWith({}, []);
    expect(getUpdateRun(run.runId)).toEqual(recorded);
  });

  it.each([
    { label: "recent request", ageMs: 60_000 },
    { label: "live driver", phase: "staging" as const, liveDriver: true },
  ])("leaves a $label alone without entering maintenance", async (fixture) => {
    const run = seedRun(fixture);

    await expect(updateRepairCommand({})).rejects.toThrow("still in progress");

    expect(getUpdateRun(run.runId)).toEqual(run);
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("rechecks a driver that advances while Gateway health is being inspected", async () => {
    const run = seedRun({ phase: "staging" });
    mocks.readiness.mockImplementationOnce(async () => {
      recordUpdateRunStep(run.runId, { step: "build", status: "in_progress", startedAtMs: now });
      return { healthz: 200, readyz: 200 };
    });

    await expect(updateRepairCommand({})).rejects.toThrow("still in progress");

    expect(getUpdateRun(run.runId)?.status).toBe("running");
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it.each([{ channel: "beta" }, { acceptCapabilities: true }])(
    "retains full repair for explicit changes %j",
    async (opts) => {
      const run = seedRun();
      mocks.finalize.mockRejectedValueOnce(new Error("Stop the service through its owner"));

      await expect(updateRepairCommand(opts)).rejects.toThrow("Stop the service through its owner");

      expect(getUpdateRun(run.runId)).toEqual(run);
      expect(mocks.finalize).toHaveBeenCalledWith(opts, [run.runId]);
    },
  );

  it.each(
    (["activating", "restarting", "verifying", "repairing"] as const).flatMap((phase) =>
      [false, true].map((reconciled) => ({ phase, reconciled })),
    ),
  )(
    "retains post-core phases in full repair ($phase, reconciled=$reconciled)",
    async ({ phase, reconciled }) => {
      const run = seedRun({ phase: phase === "repairing" ? "verifying" : phase });
      vi.mocked(Date.now).mockReturnValue(run.updatedAtMs);
      if (phase === "repairing") {
        recordUpdateRunPhase(run.runId, phase);
      }
      vi.mocked(Date.now).mockReturnValue(now);
      if (reconciled) {
        finishUpdateRun(run.runId, { status: "failed", reason: "abandoned" });
      }
      const recorded = getUpdateRun(run.runId);
      mocks.finalize.mockRejectedValueOnce(new Error("Stop the service through its owner"));

      await expect(updateRepairCommand({})).rejects.toThrow("Stop the service through its owner");

      expect(getUpdateRun(run.runId)).toEqual(recorded);
      expect(mocks.finalize).toHaveBeenCalledWith({}, [run.runId]);
    },
  );

  it.each(["activating", "finalize:plugins"])(
    "does not let old active history hide newer abandoned %s work",
    async (step) => {
      const old = seedRun({ ageMs: ABANDONED_UPDATE_RUN_MS * 4 });
      const newer = seedRun({ ageMs: ABANDONED_UPDATE_RUN_MS * 3 });
      vi.mocked(Date.now).mockReturnValue(now - ABANDONED_UPDATE_RUN_MS * 2);
      recordUpdateRunStep(newer.runId, { step, status: "completed" });
      finishUpdateRun(newer.runId, { status: "failed", reason: "abandoned" });
      vi.mocked(Date.now).mockReturnValue(now);
      const recorded = listUpdateRuns();
      mocks.finalize.mockRejectedValueOnce(new Error("Stop the service through its owner"));

      await expect(updateRepairCommand({})).rejects.toThrow("Stop the service through its owner");

      expect(mocks.finalize).toHaveBeenCalledWith({}, [old.runId, newer.runId]);
      expect(mocks.reachable).not.toHaveBeenCalled();
      expect(listUpdateRuns()).toEqual(recorded);
    },
  );

  it("allows ledger-only repair after newer post-core abandonment was acknowledged", async () => {
    const old = seedRun();
    const newer = seedRun({ ageMs: 60_000, phase: "activating" });
    finishUpdateRun(newer.runId, { status: "failed", reason: "abandoned" });
    acknowledgeAbandonedUpdateRun(newer.runId);

    await updateRepairCommand({});

    expect(getUpdateRun(old.runId)).toMatchObject({ status: "failed", reason: "abandoned" });
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("requires full repair when newer history exceeds the inspection bound", async () => {
    const old = seedRun();
    const abandoned = seedRun({ ageMs: 60_000, phase: "activating" });
    finishUpdateRun(abandoned.runId, { status: "failed", reason: "abandoned" });
    for (let index = 0; index < 100; index++) {
      const newer = createUpdateRun({ trigger: "cli" });
      finishUpdateRun(newer.runId, { status: "skipped", reason: "already-current" });
    }
    mocks.finalize.mockRejectedValueOnce(new Error("Stop the service through its owner"));

    await expect(updateRepairCommand({})).rejects.toThrow("Stop the service through its owner");

    expect(getUpdateRun(old.runId)).toEqual(old);
    expect(mocks.reachable).not.toHaveBeenCalled();
  });

  it("rechecks newer abandoned post-core history after health probes", async () => {
    const old = seedRun();
    mocks.readiness.mockImplementationOnce(async () => {
      const newer = seedRun({ ageMs: 60_000, phase: "activating" });
      finishUpdateRun(newer.runId, { status: "failed", reason: "abandoned" });
      return { healthz: 200, readyz: 200 };
    });

    await expect(updateRepairCommand({})).rejects.toThrow(
      "Stop the Gateway service through its owner",
    );

    expect(getUpdateRun(old.runId)).toEqual(old);
    expect(mocks.runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Reconciled"));
  });

  it.each(["in_progress", "completed", "failed"] as const)(
    "retains full repair after a %s finalization step",
    async (status) => {
      const run = seedRun();
      vi.mocked(Date.now).mockReturnValue(run.updatedAtMs);
      recordUpdateRunStep(run.runId, { step: "finalize:doctor", status });
      vi.mocked(Date.now).mockReturnValue(now);
      mocks.finalize.mockRejectedValueOnce(new Error("Stop the service through its owner"));

      await expect(updateRepairCommand({})).rejects.toThrow("Stop the service through its owner");

      expect(getUpdateRun(run.runId)?.status).toBe("running");
      expect(mocks.finalize).toHaveBeenCalledWith({}, [run.runId]);
    },
  );

  it.each([
    "version mismatch",
    "build mismatch",
    "missing running build",
    "missing installed build",
    "missing installed version",
  ])("retains full repair when the serving generation is unverified: %s", async (problem) => {
    const run = seedRun();
    const root = await mocks.resolveRoot();
    if (problem === "missing installed build") {
      fs.unlinkSync(path.join(root, "dist", "build-info.json"));
    } else if (problem === "missing installed version") {
      fs.writeFileSync(path.join(root, "package.json"), "{}");
    }
    mocks.reachable.mockResolvedValue({
      reachable: true,
      gatewayVersion: problem === "version mismatch" ? "2026.9.2" : "2026.9.3",
      gatewayBuildId:
        problem === "build mismatch"
          ? "previous-build"
          : problem === "missing running build"
            ? null
            : "installed-build",
      activatedPluginErrors: [],
      channelProbeErrors: [],
    });
    mocks.finalize.mockRejectedValueOnce(new Error("Stop the service through its owner"));

    await expect(updateRepairCommand({})).rejects.toThrow("Stop the service through its owner");

    expect(getUpdateRun(run.runId)).toEqual(run);
    expect(mocks.finalize).toHaveBeenCalledWith({}, [run.runId]);
    expect(mocks.runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Reconciled"));
  });

  it.each(["config", "plugin", "channel", "readiness", "handshake"])(
    "retains full repair when the Gateway has a %s problem",
    async (problem) => {
      const run = seedRun();
      if (problem === "config") {
        mocks.readConfig.mockResolvedValue({ valid: false });
      } else if (problem === "readiness") {
        mocks.readiness.mockResolvedValue({ healthz: 200, readyz: 503 });
      } else {
        mocks.reachable.mockResolvedValue({
          reachable: true,
          gatewayVersion: problem === "handshake" ? "" : "2026.9.3",
          gatewayBuildId: "installed-build",
          activatedPluginErrors: problem === "plugin" ? [{ id: "test", error: "failed" }] : [],
          channelProbeErrors: problem === "channel" ? [{ id: "test", error: "failed" }] : [],
        });
      }
      mocks.finalize.mockRejectedValueOnce(new Error("Stop the service through its owner"));

      await expect(updateRepairCommand({})).rejects.toThrow("Stop the service through its owner");

      expect(getUpdateRun(run.runId)).toEqual(run);
      expect(mocks.finalize).toHaveBeenCalledWith({}, [run.runId]);
    },
  );

  it("does not reconcile when write admission is refused", async () => {
    const run = seedRun();
    mocks.ownershipAllowed.mockRejectedValueOnce(new Error("externally supervised"));

    await expect(updateRepairCommand({})).rejects.toThrow("externally supervised");

    expect(getUpdateRun(run.runId)).toEqual(run);
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.reachable).not.toHaveBeenCalled();
  });
});
