import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { saveCronStore } from "../../../cron/store.js";
import { loadLegacyCronRepairState } from "./legacy-repair.js";

let tempRoot: string | undefined;

afterEach(async () => {
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
