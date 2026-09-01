import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  loadCronQuarantinedJobs,
  loadCronStore,
  saveCronQuarantinedJobs,
  saveCronStore,
} from "../../../cron/store.js";
import { cronStoreKey } from "../../../cron/store/key.js";
import type { CronJob } from "../../../cron/types.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import {
  applyLegacyCronStoreRepair,
  loadLegacyCronRepairState,
  repairLegacyCronStoreWithoutPrompt,
} from "./legacy-repair.js";

let tempRoot: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

it.each<{
  name: string;
  agents: NonNullable<OpenClawConfig["agents"]>;
  agentId?: string;
  expectedOwner: { kind: "runtime-default" | "explicit"; agentId: string };
}>([
  {
    name: "sole configured agent",
    agents: { entries: { ops: {} } },
    expectedOwner: { kind: "runtime-default", agentId: "ops" },
  },
  {
    name: "configured system agent under explicit ownership",
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "ops" } },
      entries: { main: {}, ops: {} },
    },
    expectedOwner: { kind: "runtime-default", agentId: "ops" },
  },
  {
    name: "explicit job owner before the configured system agent",
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "ops" } },
      entries: { main: {}, ops: {} },
    },
    agentId: "main",
    expectedOwner: { kind: "explicit", agentId: "main" },
  },
])(
  "projects the $name without changing the stored owner",
  async ({ agents, agentId, expectedOwner }) => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-owner-projection-"));
    const storePath = path.join(tempRoot, "cron", "jobs.json");
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        {
          id: "dynamic-default",
          agentId,
          name: "Dynamic default",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "run" },
          state: {},
        },
      ],
    });

    const cfg = {
      cron: { store: storePath },
      agents,
    } as OpenClawConfig;
    const state = await loadLegacyCronRepairState({ cfg, storePath, readOnly: true });

    expect(state?.rawJobs[0]?.agentId).toBe(agentId);
    expect(state?.projectedOwnersByJobId.get("dynamic-default")).toEqual(expectedOwner);
  },
);

function job(id: string): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run" },
    state: {},
  };
}

async function loadRepairStateForStore(storePath: string) {
  const cfg = { cron: { store: storePath } } as OpenClawConfig;
  const state = expectDefined(
    await loadLegacyCronRepairState({ cfg, storePath }),
    `repair state for ${storePath}`,
  );
  return { cfg, state };
}

it("refuses to rewrite a row a writer outside this branch's code committed after the snapshot", async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-repair-mixed-version-"));
  const storePath = path.join(tempRoot, "cron", "jobs.json");
  await saveCronStore(storePath, {
    version: 1,
    jobs: [{ ...job("job-a"), notify: true } as CronJob],
  });
  const { cfg, state } = await loadRepairStateForStore(storePath);
  openOpenClawStateDatabase()
    .db.prepare(
      `INSERT INTO cron_jobs (store_key, job_id, name, enabled, payload_kind, job_json, state_json, sort_order, updated_at)
       VALUES (?, ?, ?, 1, 'agentTurn', ?, '{}', 1, 1)`,
    )
    .run(cronStoreKey(storePath), "job-c", "job-c", JSON.stringify(job("job-c")));

  const result = await applyLegacyCronStoreRepair({ cfg, state });

  expect(result.warnings).toEqual([expect.stringContaining("changed while doctor was waiting")]);
  expect((await loadCronStore(storePath)).jobs.map((entry) => entry.id)).toEqual([
    "job-a",
    "job-c",
  ]);
});

it("refuses a legacy JSON import when rows were committed after the repair snapshot", async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-repair-legacy-"));
  const storePath = path.join(tempRoot, "cron", "jobs.json");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs: [job("job-legacy")] }));
  const { cfg, state } = await loadRepairStateForStore(storePath);
  await saveCronStore(storePath, { version: 1, jobs: [job("job-c")] });

  const result = await applyLegacyCronStoreRepair({ cfg, state });

  expect(result.warnings).toEqual([expect.stringContaining("changed while doctor was waiting")]);
  expect((await loadCronStore(storePath)).jobs.map((entry) => entry.id)).toEqual(["job-c"]);
});

it("does not reactivate quarantined automations during startup repair", async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-startup-quarantine-"));
  const storePath = path.join(tempRoot, "cron", "jobs.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", tempRoot);
  await saveCronStore(storePath, { version: 1, jobs: [] });
  saveCronQuarantinedJobs({
    storePath,
    nowMs: 123,
    entries: [
      {
        sourceIndex: 0,
        reason: "invalid-schedule",
        job: {
          id: "variant-cron",
          name: "Variant cron",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: " CRON ", expr: "0 9 * * *" },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "tick" },
          state: {},
        },
      },
    ],
  });
  const cfg = { cron: { store: storePath } } as OpenClawConfig;

  const result = await repairLegacyCronStoreWithoutPrompt({ cfg });

  expect(result).toEqual({ changes: [], warnings: [] });
  expect((await loadCronStore(storePath)).jobs).toEqual([]);
  expect(loadCronQuarantinedJobs(storePath)).toHaveLength(1);
});
