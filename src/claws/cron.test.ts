import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateCronAddParams } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { installClawCronJobs, readClawCronRefs } from "./cron.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

afterEach(() => closeOpenClawStateDatabaseForTest());
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function fixture() {
  const root = tempDirs.make("openclaw-claw-cron-");
  const parsed = parseClawManifest({
    schemaVersion: 1,
    agent: { id: "worker" },
    cronJobs: [
      {
        id: "daily-report",
        name: "Daily report",
        schedule: { cron: "0 9 * * *", timezone: "UTC" },
        session: "main",
        message: "Prepare the report",
        delivery: { mode: "announce", channel: "last" },
      },
    ],
  });
  if (!parsed.ok) {
    throw new Error(JSON.stringify(parsed.diagnostics));
  }
  const source: ClawSourceIdentity = {
    kind: "package",
    name: "@acme/worker",
    version: "1.0.0",
    packageRoot: root,
    manifestPath: join(root, "openclaw.claw.json"),
    integrityKind: "artifact",
    integrity: "sha256:manifest",
    byteLength: 100,
  };
  const plan = await buildClawAddPlan({
    manifest: parsed.manifest,
    source,
    context: { workspace: join(root, "workspace"), agentId: "worker-two" },
  });
  return { root, plan, env: { OPENCLAW_STATE_DIR: join(root, "state") } };
}

describe("installClawCronJobs", () => {
  it("pins declarations and execution to the final agent id", async () => {
    const current = await fixture();
    const add = vi.fn().mockResolvedValue({ id: "scheduler-123" });

    const refs = await installClawCronJobs(current.plan, {
      env: current.env,
      gateway: { add },
      nowMs: 42,
    });

    expect(add).toHaveBeenCalledWith({
      name: "Daily report",
      declarationKey: "claw:worker-two:daily-report",
      displayName: "Daily report",
      owner: { agentId: "worker-two" },
      enabled: true,
      agentId: "worker-two",
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      sessionTarget: "session:agent:worker-two:main",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Prepare the report" },
      delivery: { mode: "announce", channel: "last" },
    });
    expect(validateCronAddParams(add.mock.calls[0]?.[0])).toBe(true);
    expect(refs).toMatchObject([
      {
        schemaVersion: "openclaw.clawCronRef.v1",
        agentId: "worker-two",
        manifestId: "daily-report",
        schedulerJobId: "scheduler-123",
        status: "complete",
      },
    ]);
    expect(readClawCronRefs("worker-two", { env: current.env })).toEqual(refs);
  });

  it("accepts declaration convergence results from cron.add", async () => {
    const current = await fixture();

    const refs = await installClawCronJobs(current.plan, {
      env: current.env,
      gateway: { add: vi.fn().mockResolvedValue({ created: false, job: { id: "existing-1" } }) },
    });

    expect(refs[0]).toMatchObject({ schedulerJobId: "existing-1", status: "complete" });
  });

  it("preserves an ambiguous pending reference when cron.add fails", async () => {
    const current = await fixture();

    await expect(
      installClawCronJobs(current.plan, {
        env: current.env,
        gateway: { add: vi.fn().mockRejectedValue(new Error("gateway unavailable")) },
      }),
    ).rejects.toMatchObject({
      code: "cron_install_failed",
      cronJobs: [{ manifestId: "daily-report", status: "pending", error: "gateway unavailable" }],
    });
    expect(readClawCronRefs("worker-two", { env: current.env })).toMatchObject([
      { manifestId: "daily-report", status: "pending", error: "gateway unavailable" },
    ]);
  });

  it("reconciles a response-lost retry by declaration key", async () => {
    const current = await fixture();
    const add = vi.fn().mockRejectedValue(new Error("response lost"));

    await expect(
      installClawCronJobs(current.plan, {
        env: current.env,
        gateway: { add },
      }),
    ).rejects.toMatchObject({
      code: "cron_install_failed",
      cronJobs: [{ status: "pending" }],
    });

    const refs = await installClawCronJobs(current.plan, {
      env: current.env,
      gateway: {
        add,
        list: vi.fn().mockResolvedValue({
          jobs: [
            {
              id: "scheduler-after-lost-response",
              declarationKey: "claw:worker-two:daily-report",
            },
          ],
        }),
      },
    });

    expect(add).toHaveBeenCalledTimes(1);
    expect(refs).toMatchObject([
      { schedulerJobId: "scheduler-after-lost-response", status: "complete" },
    ]);
  });

  it("converges concurrent installs through the declaration key", async () => {
    const current = await fixture();
    const jobs = new Map<string, { id: string; declarationKey: string }>();
    const add = vi.fn(async (input: Record<string, unknown>) => {
      await Promise.resolve();
      const declarationKey = String(input.declarationKey);
      const existing = jobs.get(declarationKey);
      if (existing) {
        return { created: false, job: existing };
      }
      const created = { id: "scheduler-converged", declarationKey };
      jobs.set(declarationKey, created);
      return { created: true, job: created };
    });

    const [first, second] = await Promise.all([
      installClawCronJobs(current.plan, { env: current.env, gateway: { add } }),
      installClawCronJobs(current.plan, { env: current.env, gateway: { add } }),
    ]);

    expect(jobs.size).toBe(1);
    expect(first[0]).toMatchObject({ schedulerJobId: "scheduler-converged", status: "complete" });
    expect(second[0]).toMatchObject({ schedulerJobId: "scheduler-converged", status: "complete" });
  });
});
