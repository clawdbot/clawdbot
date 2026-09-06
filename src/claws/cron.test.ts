import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateCronAddParams } from "../../packages/gateway-protocol/src/index.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { cronJobReadView } from "../cron/job-read-view.js";
import { normalizeCronJobCreate } from "../cron/normalize.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  clawCronGatewayInput,
  clawCronGatewayJobMatchesRef,
  deleteClawCronRef,
  installClawCronJobs,
  markClawCronRefRemoved,
  readClawCronRefs,
  upsertClawCronRef,
} from "./cron.js";
import { buildClawAddPlan } from "./lifecycle.js";
import { parseClawManifest } from "./schema.js";
import type { ClawSourceIdentity } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());

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

function listedCronJob(
  agentId: string,
  ref: ReturnType<typeof readClawCronRefs>[number],
  id: string,
) {
  const normalized = normalizeCronJobCreate(clawCronGatewayInput(agentId, ref));
  if (!normalized) {
    throw new Error("expected normalized cron job");
  }
  return cronJobReadView({
    ...normalized,
    id,
    createdAtMs: 1,
    updatedAtMs: 1,
    state: {
      nextRunAtMs: 100,
      lastRunAtMs: 50,
      lastStatus: "error",
      lastError: "Synthetic run error",
      lastDelivered: false,
      lastDeliveryStatus: "not-delivered",
      lastDeliveryError: "Synthetic delivery error",
      deliverySuppressionReason: "channel_transform",
      lastFailureNotificationDelivered: false,
      lastFailureNotificationDeliveryStatus: "not-delivered",
      lastFailureNotificationDeliveryError: "Synthetic notification error",
    },
  });
}

describe("installClawCronJobs", () => {
  it("pins declarations and execution to the final agent id", async () => {
    const current = await fixture();
    const calls: string[] = [];
    const waitUntilAgentAvailable = vi.fn(async () => {
      calls.push("wait");
    });
    const add = vi.fn(async (_input: Record<string, unknown>) => {
      calls.push("add");
      return { id: "scheduler-123" };
    });

    const refs = await installClawCronJobs(current.plan, {
      env: current.env,
      gateway: { add, waitUntilAgentAvailable },
      nowMs: 42,
    });

    expect(waitUntilAgentAvailable).toHaveBeenCalledWith("worker-two");
    expect(calls).toEqual(["wait", "add"]);
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

  it("does not require the gateway when every cron reference is already complete", async () => {
    const current = await fixture();
    await installClawCronJobs(current.plan, {
      env: current.env,
      gateway: { add: vi.fn().mockResolvedValue({ id: "scheduler-123" }) },
    });
    const waitUntilAgentAvailable = vi.fn().mockRejectedValue(new Error("gateway unavailable"));
    const add = vi.fn();

    await expect(
      installClawCronJobs(current.plan, {
        env: current.env,
        gateway: { add, waitUntilAgentAvailable },
      }),
    ).resolves.toMatchObject([{ schedulerJobId: "scheduler-123", status: "complete" }]);
    expect(waitUntilAgentAvailable).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it("fails closed when a complete scheduler job disappeared", async () => {
    const current = await fixture();
    await installClawCronJobs(current.plan, {
      env: current.env,
      gateway: { add: vi.fn().mockResolvedValue({ id: "scheduler-123" }) },
    });
    const list = vi.fn().mockResolvedValue({ jobs: [] });
    const add = vi.fn();

    await expect(
      installClawCronJobs(current.plan, {
        env: current.env,
        gateway: { add, list },
      }),
    ).rejects.toMatchObject({ code: "cron_reconcile_conflict" });

    expect(list).toHaveBeenCalledOnce();
    expect(add).not.toHaveBeenCalled();
    expect(readClawCronRefs("worker-two", { env: current.env })).toMatchObject([
      { schedulerJobId: "scheduler-123", status: "complete" },
    ]);
  });

  it("reconciles an unchanged completed job from a status-rich Gateway view", async () => {
    const current = await fixture();
    const refs = await installClawCronJobs(current.plan, {
      env: current.env,
      gateway: { add: async () => ({ id: "scheduler-123" }) },
    });
    const view = listedCronJob("worker-two", refs[0]!, "scheduler-123");
    const before = structuredClone(view);
    const add = vi.fn();

    await expect(
      installClawCronJobs(current.plan, {
        env: current.env,
        gateway: { add, list: async () => ({ jobs: [view] }) },
      }),
    ).resolves.toEqual(refs);
    expect(add).not.toHaveBeenCalled();
    expect(view).toEqual(before);
    for (const invalid of [
      null,
      false,
      "job",
      {},
      { ...view, state: undefined },
      { ...view, id: undefined },
      { ...view, schedule: undefined },
      { ...view, payload: { kind: "invalid" } },
    ]) {
      expect(clawCronGatewayJobMatchesRef("worker-two", refs[0]!, invalid)).toBe(false);
    }
  });

  it.each([
    {
      name: "message",
      patch: { payload: { kind: "agentTurn", message: "Different declaration" } },
    },
    { name: "unknown definition field", patch: { operatorSetting: { mode: "changed" } } },
  ])("rejects a same-key scheduler job with drifted $name", async ({ patch }) => {
    const current = await fixture();
    await installClawCronJobs(current.plan, {
      env: current.env,
      gateway: { add: vi.fn().mockResolvedValue({ id: "scheduler-123" }) },
    });
    const [ref] = readClawCronRefs("worker-two", { env: current.env });
    const drifted = listedCronJob("worker-two", ref!, "scheduler-123");
    Object.assign(drifted, patch);
    const add = vi.fn();

    await expect(
      installClawCronJobs(current.plan, {
        env: current.env,
        gateway: { add, list: vi.fn().mockResolvedValue({ jobs: [drifted] }) },
      }),
    ).rejects.toMatchObject({ code: "cron_reconcile_conflict" });
    expect(add).not.toHaveBeenCalled();
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

  it("preserves the pending reference when agent readiness fails", async () => {
    const current = await fixture();
    const add = vi.fn();

    await expect(
      installClawCronJobs(current.plan, {
        env: current.env,
        gateway: {
          add,
          waitUntilAgentAvailable: vi.fn().mockRejectedValue(new Error("reload timed out")),
        },
      }),
    ).rejects.toMatchObject({
      code: "cron_install_failed",
      cronJobs: [{ manifestId: "daily-report", status: "pending", error: "reload timed out" }],
    });
    expect(add).not.toHaveBeenCalled();
    expect(readClawCronRefs("worker-two", { env: current.env })).toMatchObject([
      { manifestId: "daily-report", status: "pending", error: "reload timed out" },
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
    expect(refs[0]).not.toHaveProperty("error");
    expect(refs).toEqual(readClawCronRefs("worker-two", { env: current.env }));
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

  it("retains creation time across replacement and scopes removal to the owning agent", async () => {
    const current = await fixture();
    const options = { env: current.env };
    const [original] = await installClawCronJobs(current.plan, {
      ...options,
      gateway: { add: async () => ({ id: "scheduler-original" }) },
      nowMs: 42,
    });
    const replacement = {
      ...original!,
      schedulerJobId: "scheduler-replacement",
      job: { ...original!.job, message: 'Report "quoted" \\ 日本語\n\u0000' },
      error: "previous failure",
      createdAtMs: 999,
      updatedAtMs: 100,
    };
    upsertClawCronRef(replacement, options);
    const otherAgent = {
      ...original!,
      agentId: "other-agent",
      declarationKey: "claw:other-agent:daily-report",
      schedulerJobId: "scheduler-other",
    };
    upsertClawCronRef(otherAgent, options);
    expect(readClawCronRefs("worker-two", options)).toEqual([{ ...replacement, createdAtMs: 42 }]);

    const removed = markClawCronRefRemoved("worker-two", "daily-report", {
      ...options,
      nowMs: 200,
    });
    expect(removed).toMatchObject({ status: "removed", createdAtMs: 42, updatedAtMs: 200 });
    expect(removed).not.toHaveProperty("schedulerJobId");
    expect(removed).not.toHaveProperty("error");
    expect(readClawCronRefs("worker-two", options)).toEqual([removed]);
    expect(markClawCronRefRemoved("worker-two", "missing", options)).toBeUndefined();
    deleteClawCronRef("worker-two", "daily-report", options);
    deleteClawCronRef("worker-two", "daily-report", options);
    expect(readClawCronRefs("worker-two", options)).toEqual([]);
    expect(readClawCronRefs("other-agent", options)).toEqual([otherAgent]);
  });

  it("parses the full agent list before removal while installation reads only its declaration", async () => {
    const current = await fixture();
    const options = { env: current.env };
    const gateway = { add: vi.fn().mockResolvedValue({ id: "scheduler-valid" }) };
    const [original] = await installClawCronJobs(current.plan, { ...options, gateway });
    upsertClawCronRef(
      {
        ...original!,
        manifestId: "zz-malformed",
        declarationKey: "claw:worker-two:zz-malformed",
        schedulerJobId: "scheduler-malformed",
      },
      options,
    );
    const db = openOpenClawStateDatabase(options).db;
    db.prepare("UPDATE claw_cron_refs SET job_json = ? WHERE manifest_id = ?").run(
      "{",
      "zz-malformed",
    );

    expect(() => readClawCronRefs("worker-two", options)).toThrow(SyntaxError);
    expect(() => markClawCronRefRemoved("worker-two", "daily-report", options)).toThrow(
      SyntaxError,
    );
    expect(() => markClawCronRefRemoved("worker-two", "missing", options)).toThrow(SyntaxError);
    await expect(installClawCronJobs(current.plan, { ...options, gateway })).resolves.toEqual([
      original,
    ]);
    expect(gateway.add).toHaveBeenCalledOnce();
  });
});
