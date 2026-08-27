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

it("projects a canonical agent-less row through the runtime default", async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-owner-projection-"));
  const storePath = path.join(tempRoot, "cron", "jobs.json");
  await saveCronStore(storePath, {
    version: 1,
    jobs: [
      {
        id: "dynamic-default",
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
    agents: { entries: { ops: {} } },
  } as OpenClawConfig;
  const state = await loadLegacyCronRepairState({ cfg, storePath, readOnly: true });

  expect(state?.projectedOwnersByJobId.get("dynamic-default")).toEqual({
    kind: "runtime-default",
    agentId: "ops",
  });
  expect(state?.rawJobs[0]?.agentId).toBeUndefined();
});
