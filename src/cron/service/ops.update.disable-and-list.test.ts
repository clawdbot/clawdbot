import { describe, expect, it, vi } from "vitest";
import {
  noopLogger,
  setupCronRegressionFixtures,
} from "../../../test/helpers/cron/service-regression-fixtures.js";
import { add, list, update } from "./ops.js";
import { createCronServiceState } from "./state.js";

const fixtures = setupCronRegressionFixtures({ prefix: "cron-disable-list-" });

describe("cron service ops: disable + list round-trip", () => {
  it("keeps a disabled job available to --all and restores it after enable", async () => {
    const { storePath } = fixtures.makeStorePath();
    const state = createCronServiceState({
      cronEnabled: true,
      storePath,
      log: noopLogger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
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
});
