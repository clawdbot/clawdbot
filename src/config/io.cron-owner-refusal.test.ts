import { expect, it, vi } from "vitest";
import type { LegacyCronRepairState } from "../commands/doctor/cron/legacy-repair.js";
import { prepareCronOwnerWriteRefusal } from "./io.cron-owner-refusal.js";
import { assertAutomaticBindingsWriteAllowed } from "./io.ownership-write-guard.js";

const state = (rawJobs: Array<Record<string, unknown>>) =>
  ({ rawJobs, projectedOwnersByJobId: new Map() }) as unknown as LegacyCronRepairState;
const deps = (activeGateway?: { pid: number; port: number }, jobs?: Record<string, unknown>[]) => ({
  readActiveGatewayLockIdentity: vi.fn(async () =>
    activeGateway ? { ...activeGateway, createdAt: new Date(0).toISOString() } : undefined,
  ),
  loadLegacyCronRepairState: vi.fn(async () => (jobs ? state(jobs) : null)),
});

it("refuses unsafe ownership writes and rechecks at commit", async () => {
  const injected = deps({ pid: process.pid + 1, port: 18_789 });
  await expect(
    prepareCronOwnerWriteRefusal({ storePath: "/tmp/cron.json" }, injected),
  ).rejects.toThrow("live external Gateway");
  expect(injected.loadLegacyCronRepairState).not.toHaveBeenCalled();

  await expect(
    prepareCronOwnerWriteRefusal(
      { storePath: "/tmp/cron.json" },
      deps(undefined, [
        { id: "null", agentId: null },
        { id: "blank", agentId: " " },
      ]),
    ),
  ).rejects.toThrow("contains 2 ownerless legacy cron job");

  const commitDeps = deps(undefined, [{ id: "owned", agentId: "ops" }]);
  const plan = await prepareCronOwnerWriteRefusal({ storePath: "/tmp/cron.json" }, commitDeps);
  commitDeps.loadLegacyCronRepairState.mockResolvedValueOnce(state([{ id: "ownerless" }]));
  await expect(plan.recheck()).rejects.toThrow("ownerless legacy cron job");

  expect(() =>
    assertAutomaticBindingsWriteAllowed({
      bindingsIncludeOwned: true,
      ownershipPaths: [["bindings"]],
    }),
  ).toThrow("cannot append to $include-owned bindings");
});
