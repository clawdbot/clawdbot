import { describe, expect, it, vi } from "vitest";
import {
  createCronRegressionState,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { add, update } from "./ops-mutations.js";
import { list, listPage } from "./ops-read.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-disable-list-" });

describe("cron service ops: disable + list round-trip", () => {
  it("keeps a disabled job available to --all and restores it after enable", async () => {
    const { storePath } = fixtures.makeStorePath();
    const state = createCronRegressionState({
      storePath,
      runIsolatedAgentJob: vi.fn(),
    });

    const job = await add(state, {
      name: "disable-and-list",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "ping" },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      delivery: { mode: "announce" },
    });

    try {
      await update(state, job.id, { enabled: false });
      expect((await list(state)).map(({ id }) => id)).not.toContain(job.id);
      expect(await list(state, { includeDisabled: true })).toContainEqual(
        expect.objectContaining({ id: job.id, enabled: false }),
      );

      await update(state, job.id, { enabled: true });
      expect(await list(state)).toContainEqual(
        expect.objectContaining({ id: job.id, enabled: true }),
      );
    } finally {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
  });

  it("filters the paginated inventory by group and tag", async () => {
    const { storePath } = fixtures.makeStorePath();
    const state = createCronRegressionState({
      storePath,
      runIsolatedAgentJob: vi.fn(),
    });
    try {
      await add(state, {
        name: "work report",
        group: "Work",
        tags: ["github", "reports"],
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "agentTurn", message: "report" },
        sessionTarget: "isolated",
        wakeMode: "now",
      });
      await add(state, {
        name: "personal reminder",
        group: "Personal",
        tags: ["home"],
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        payload: { kind: "agentTurn", message: "remind" },
        sessionTarget: "isolated",
        wakeMode: "now",
      });

      expect((await listPage(state, { group: "Work" })).jobs).toHaveLength(1);
      expect((await listPage(state, { tag: "reports" })).jobs).toHaveLength(1);
      expect((await listPage(state, { tag: "HOME" })).jobs).toHaveLength(1);
    } finally {
      if (state.timer) {
        clearTimeout(state.timer);
      }
    }
  });
});
