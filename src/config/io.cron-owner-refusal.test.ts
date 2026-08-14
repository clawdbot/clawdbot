import { expect, it, vi } from "vitest";
import type { LegacyCronRepairState } from "../commands/doctor/cron/legacy-repair.js";
import {
  isCronOwnerWriteRefusalError,
  prepareCronOwnerWriteRefusal,
} from "./io.cron-owner-refusal.js";
import { assertAutomaticBindingsWriteAllowed } from "./io.ownership-write-guard.js";

const state = (rawJobs: Array<Record<string, unknown>>) =>
  ({ rawJobs, projectedOwnersByJobId: new Map() }) as unknown as LegacyCronRepairState;
const deps = (activeGateway?: { pid: number; port: number }, jobs?: Record<string, unknown>[]) => ({
  readActiveGatewayLockIdentity: vi.fn(async () =>
    activeGateway ? { ...activeGateway, createdAt: new Date(0).toISOString() } : undefined,
  ),
  loadLegacyCronRepairState: vi.fn(async () => (jobs ? state(jobs) : null)),
  materializeLegacyDefaultCronJobOwners: vi.fn(() => 0),
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

it("materializes a proven retained owner before the commit recheck", async () => {
  for (const safe of [deps(), deps(undefined, [{ id: "owned", agentId: "research" }])]) {
    await prepareCronOwnerWriteRefusal(
      { storePath: "/tmp/cron.json", provenOwnerAgentId: "ops" },
      safe,
    );
    expect(safe.materializeLegacyDefaultCronJobOwners).not.toHaveBeenCalled();
  }

  const injected = deps(undefined, [{ id: "ownerless" }, { id: "owned", agentId: "research" }]);
  injected.materializeLegacyDefaultCronJobOwners.mockImplementationOnce(() => {
    injected.loadLegacyCronRepairState.mockResolvedValue(
      state([
        { id: "ownerless", agentId: "ops" },
        { id: "owned", agentId: "research" },
      ]),
    );
    return 1;
  });

  const plan = await prepareCronOwnerWriteRefusal(
    {
      storePath: "/tmp/custom-cron.json",
      provenOwnerAgentId: "ops",
      env: { OPENCLAW_STATE_DIR: "/tmp/state" },
    },
    injected,
  );
  await plan.recheck();

  expect(injected.materializeLegacyDefaultCronJobOwners).toHaveBeenCalledOnce();
  expect(injected.materializeLegacyDefaultCronJobOwners).toHaveBeenCalledWith({
    storePath: "/tmp/custom-cron.json",
    legacyDefaultAgentId: "ops",
    env: { OPENCLAW_STATE_DIR: "/tmp/state" },
  });
});

it("keeps ambiguous and failed owner handoffs as typed refusals", async () => {
  const ambiguous = deps(undefined, [{ id: "ownerless" }]);
  await expect(
    prepareCronOwnerWriteRefusal({ storePath: "/tmp/cron.json" }, ambiguous),
  ).rejects.toSatisfy(isCronOwnerWriteRefusalError);
  expect(ambiguous.materializeLegacyDefaultCronJobOwners).not.toHaveBeenCalled();

  const failed = deps(undefined, [{ id: "ownerless" }]);
  failed.materializeLegacyDefaultCronJobOwners.mockImplementationOnce(() => {
    throw new Error("database is temporarily read-only");
  });
  const failure = prepareCronOwnerWriteRefusal(
    { storePath: "/tmp/cron.json", provenOwnerAgentId: "ops" },
    failed,
  );
  await expect(failure).rejects.toSatisfy(isCronOwnerWriteRefusalError);
  await expect(failure).rejects.toThrow("database is temporarily read-only");

  const corrupt = deps();
  corrupt.loadLegacyCronRepairState.mockRejectedValueOnce(
    new Error("database disk image is malformed"),
  );
  const unreadable = prepareCronOwnerWriteRefusal(
    { storePath: "/tmp/corrupt-cron.json", provenOwnerAgentId: "ops" },
    corrupt,
  );
  await expect(unreadable).rejects.toSatisfy(isCronOwnerWriteRefusalError);
  await expect(unreadable).rejects.toThrow("database disk image is malformed");
  expect(corrupt.materializeLegacyDefaultCronJobOwners).not.toHaveBeenCalled();
});
