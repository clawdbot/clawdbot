import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";
import type { CronAddResult } from "./service/state.js";
import type { CronJob, CronJobCreate } from "./types.js";

const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-declarative-" });
installCronTestHooks({ logger });

function createCronService(storePath: string, cronEnabled = true) {
  return new CronService({
    storePath,
    cronEnabled,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

function declaration(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name: "daily report",
    declarationKey: "agent:ops:daily-report",
    displayName: "Daily report",
    owner: { agentId: "ops", sessionKey: "agent:ops:main" },
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "report" },
    delivery: { mode: "announce", channel: "last" },
    ...overrides,
  };
}

function declarativeResult(result: CronAddResult) {
  if (!("job" in result)) {
    throw new Error("expected declarative cron result");
  }
  return result;
}

describe("CronService declarative jobs", () => {
  it("creates, no-ops, and converges in place while preserving state and enablement", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const created = declarativeResult(
        await cron.add(declaration({ declarationKey: "  agent:ops:daily-report  " }), {
          enabledExplicit: true,
        }),
      );
      expect(created.created).toBe(true);
      expect(created).not.toHaveProperty("updated");
      expect(created.job).toMatchObject({
        declarationKey: "agent:ops:daily-report",
        displayName: "Daily report",
        owner: { agentId: "ops", sessionKey: "agent:ops:main" },
      });

      const identical = declarativeResult(await cron.add(declaration(), { enabledExplicit: true }));
      expect(identical).toMatchObject({
        created: false,
        updated: false,
        id: created.id,
      });

      await cron.update(created.id, {
        enabled: false,
        state: {
          lastRunAtMs: 1234,
          lastRunStatus: "error",
          lastError: "previous failure",
        },
      });
      const converged = declarativeResult(
        await cron.add(
          declaration({
            displayName: "Daily summary",
            schedule: { kind: "every", everyMs: 120_000 },
            payload: { kind: "agentTurn", message: "summarize" },
            delivery: { mode: "none" },
          }),
          { enabledExplicit: false },
        ),
      );
      expect(converged).toMatchObject({ created: false, updated: true, id: created.id });
      expect(converged.job).toMatchObject({
        id: created.id,
        displayName: "Daily summary",
        enabled: false,
        schedule: { kind: "every", everyMs: 120_000 },
        payload: { kind: "agentTurn", message: "summarize" },
        delivery: { mode: "none" },
        state: {
          lastRunAtMs: 1234,
          lastRunStatus: "error",
          lastError: "previous failure",
        },
      });

      const explicitlyEnabled = declarativeResult(
        await cron.add(
          declaration({
            displayName: "Daily summary",
            enabled: true,
            schedule: { kind: "every", everyMs: 120_000 },
            payload: { kind: "agentTurn", message: "summarize" },
            delivery: { mode: "none" },
          }),
          { enabledExplicit: true },
        ),
      );
      expect(explicitlyEnabled).toMatchObject({
        created: false,
        updated: true,
        id: created.id,
        enabled: true,
      });
      const cleared = await cron.update(created.id, { displayName: null });
      expect(cleared).not.toHaveProperty("displayName");
    } finally {
      cron.stop();
    }
  });

  it("keeps declaration-key uniqueness local to the caller visibility predicate", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const key = "shared-key";
      const agentA = declarativeResult(
        await cron.add(declaration({ declarationKey: key, owner: { agentId: "alpha" } }), {
          matchesExisting: (job) => job.owner?.agentId === "alpha",
        }),
      );
      const agentB = declarativeResult(
        await cron.add(declaration({ declarationKey: key, owner: { agentId: "beta" } }), {
          matchesExisting: (job) => job.owner?.agentId === "beta",
        }),
      );
      expect(agentB.id).not.toBe(agentA.id);
      await expect(cron.add(declaration({ declarationKey: key }))).rejects.toThrow(
        "ambiguous within caller scope",
      );

      const agentAUpdate = declarativeResult(
        await cron.add(
          declaration({
            declarationKey: key,
            displayName: "Alpha report",
            owner: { agentId: "alpha" },
          }),
          { matchesExisting: (job) => job.owner?.agentId === "alpha" },
        ),
      );
      expect(agentAUpdate).toMatchObject({
        created: false,
        updated: true,
        id: agentA.id,
        displayName: "Alpha report",
      });
      expect(await cron.list()).toHaveLength(2);
    } finally {
      cron.stop();
    }
  });

  it("checks update preconditions under the mutation lock", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const created = declarativeResult(await cron.add(declaration()));
      await expect(
        cron.updateWithPrecondition(created.id, { displayName: "Blocked" }, () => {
          throw new Error("scope changed");
        }),
      ).rejects.toThrow("scope changed");
      expect(await cron.readJob(created.id)).toMatchObject({ displayName: "Daily report" });
    } finally {
      cron.stop();
    }
  });

  it("converges delivery while retaining the declared session target", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const created = await cron.add(
        declaration({
          sessionTarget: "main",
          payload: { kind: "systemEvent", text: "wake" },
          delivery: undefined,
        }),
      );
      // Session target is identity-adjacent and stays outside declaration
      // convergence; delivery converges, and main + webhook is a supported
      // shipped combination.
      const converged = await cron.add(
        declaration({
          sessionTarget: "isolated",
          payload: { kind: "systemEvent", text: "wake" },
          delivery: { mode: "webhook", to: "https://example.invalid/hook" },
        }),
      );
      expect(converged).toMatchObject({ created: false, updated: true });
      expect(await cron.readJob(created.id)).toMatchObject({
        sessionTarget: "main",
        delivery: { mode: "webhook", to: "https://example.invalid/hook" },
      });
    } finally {
      cron.stop();
    }
  });

  it("persists declaration metadata and rejects blank or duplicate reserved ids", async () => {
    const { storePath } = await makeStorePath();
    const writer = createCronService(storePath);
    await writer.start();
    const created = declarativeResult(
      await writer.add(declaration({ id: "reserved-id" }), { enabledExplicit: true }),
    );
    await expect(writer.add(declaration({ declarationKey: undefined, id: "  " }))).rejects.toThrow(
      "id must not be blank",
    );
    await expect(
      writer.add(declaration({ declarationKey: undefined, id: created.id })),
    ).rejects.toThrow("already exists");
    await expect(writer.add(declaration({ displayName: "   " }))).rejects.toThrow(
      "displayName must not be blank",
    );
    await expect(writer.update(created.id, { displayName: "   " })).rejects.toThrow(
      "displayName must not be blank",
    );
    for (const id of ["nested/job", "..\\job", "nul\0job"]) {
      await expect(writer.add(declaration({ declarationKey: undefined, id }))).rejects.toThrow(
        "invalid cron task run job id",
      );
    }
    writer.stop();

    const reader = createCronService(storePath, false);
    const persisted = await reader.readJob(created.id);
    expect(persisted).toMatchObject({
      declarationKey: "agent:ops:daily-report",
      displayName: "Daily report",
      owner: { agentId: "ops", sessionKey: "agent:ops:main" },
    } satisfies Partial<CronJob>);
  });
});
