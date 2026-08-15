import { expect, it, vi } from "vitest";
import type {
  CronOwnerProjection,
  LegacyCronRepairState,
} from "../commands/doctor/cron/legacy-repair.js";
import {
  isCronOwnerWriteRefusalError,
  prepareCronOwnerWriteRefusal,
} from "./io.cron-owner-refusal.js";
import { assertAutomaticBindingsWriteAllowed } from "./io.ownership-write-guard.js";

const state = (
  rawJobs: Array<Record<string, unknown>>,
  invalidConfigRows: Array<Record<string, unknown>> = [],
  projectedOwnersByJobId: ReadonlyMap<string, CronOwnerProjection> = new Map(),
) =>
  ({
    rawJobs,
    invalidConfigRows,
    projectedOwnersByJobId,
  }) as unknown as LegacyCronRepairState;
const deps = (
  activeGateway?: {
    pid: number;
    port: number;
    cronOwnerProjection?: "dynamic-default-v1";
  },
  jobs?: Record<string, unknown>[],
) => ({
  readActiveGatewayLockIdentity: vi.fn(async () =>
    activeGateway ? { ...activeGateway, createdAt: new Date(0).toISOString() } : undefined,
  ),
  loadLegacyCronRepairState: vi.fn(async () => (jobs ? state(jobs) : null)),
  materializeLegacyDefaultCronJobOwners: vi.fn(() => 0),
});
const cfg = { agents: { entries: { ops: {} } } };

it("allows an ownership-safe live Gateway with a projected dynamic row and rechecks at commit", async () => {
  const injected = deps(
    {
      pid: process.pid + 1,
      port: 18_789,
      cronOwnerProjection: "dynamic-default-v1",
    },
    [{ id: "dynamic" }],
  );
  injected.loadLegacyCronRepairState.mockResolvedValueOnce(
    state(
      [{ id: "dynamic" }],
      [],
      new Map([["dynamic", { kind: "runtime-default" as const, agentId: "ops" }]]),
    ),
  );
  const plan = await prepareCronOwnerWriteRefusal(cfg, { storePath: "/tmp/cron.json" }, injected);
  injected.loadLegacyCronRepairState.mockResolvedValueOnce(state([{ id: "ownerless" }]));
  await expect(plan.recheck()).rejects.toThrow("ownerless legacy cron job");
});

it("refuses an unproven live Gateway without suggesting doctor", async () => {
  const injected = deps({ pid: process.pid + 1, port: 18_789 });
  const refusal = prepareCronOwnerWriteRefusal(cfg, { storePath: "/tmp/cron.json" }, injected);
  await expect(refusal).rejects.toThrow("live external Gateway");
  await expect(refusal).rejects.not.toThrow("doctor --fix");
});

it.each([
  ["without a live Gateway", undefined],
  [
    "with an ownership-safe live Gateway",
    {
      pid: process.pid + 1,
      port: 18_789,
      cronOwnerProjection: "dynamic-default-v1" as const,
    },
  ],
])("refuses ownerless and corrupt cron rows %s", async (_name, activeGateway) => {
  await expect(
    prepareCronOwnerWriteRefusal(
      cfg,
      { storePath: "/tmp/cron.json" },
      deps(activeGateway, [
        { id: "null", agentId: null },
        { id: "blank", agentId: " " },
      ]),
    ),
  ).rejects.toThrow("contains 2 ownerless legacy cron job");

  const corrupt = deps(activeGateway);
  corrupt.loadLegacyCronRepairState.mockResolvedValueOnce(
    state([], [{ id: "corrupt", reason: "invalid config" }]),
  );
  await expect(
    prepareCronOwnerWriteRefusal(cfg, { storePath: "/tmp/cron.json" }, corrupt),
  ).rejects.toThrow("contains 1 corrupt row");
});

it("keeps include-owned binding writes fail closed", () => {
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
      cfg,
      { storePath: "/tmp/cron.json", provenOwnerAgentId: "ops" },
      safe,
    );
    expect(safe.materializeLegacyDefaultCronJobOwners).not.toHaveBeenCalled();
  }

  const injected = deps(undefined, [{ id: "ownerless" }, { id: "owned", agentId: "research" }]);
  injected.loadLegacyCronRepairState.mockResolvedValueOnce(
    state(
      [{ id: "ownerless" }, { id: "owned", agentId: "research" }],
      [],
      new Map([
        ["ownerless", { kind: "runtime-default" as const, agentId: "ops" }],
        ["owned", { kind: "explicit" as const, agentId: "research" }],
      ]),
    ),
  );
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
    cfg,
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
    prepareCronOwnerWriteRefusal(cfg, { storePath: "/tmp/cron.json" }, ambiguous),
  ).rejects.toSatisfy(isCronOwnerWriteRefusalError);
  expect(ambiguous.materializeLegacyDefaultCronJobOwners).not.toHaveBeenCalled();

  const failed = deps(undefined, [{ id: "ownerless" }]);
  failed.materializeLegacyDefaultCronJobOwners.mockImplementationOnce(() => {
    throw new Error("database is temporarily read-only");
  });
  const failure = prepareCronOwnerWriteRefusal(
    cfg,
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
    cfg,
    { storePath: "/tmp/corrupt-cron.json", provenOwnerAgentId: "ops" },
    corrupt,
  );
  await expect(unreadable).rejects.toSatisfy(isCronOwnerWriteRefusalError);
  await expect(unreadable).rejects.toThrow("database disk image is malformed");
  expect(corrupt.materializeLegacyDefaultCronJobOwners).not.toHaveBeenCalled();
});
