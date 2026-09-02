import { describe, expect, it, vi } from "vitest";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import { resolveCronSession } from "./isolated-agent/session.js";
import { toPublicCronJob } from "./public-job.js";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";
import type { CronAddResult } from "./service/state.js";
import { loadCronStore } from "./store.js";
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

const retiredTriggerState = {
  triggerState: { owner: "retired" },
  triggerEvalCount: 7,
  lastTriggerEvalAtMs: 111,
  lastTriggerFireAtMs: 222,
  lastRunAtMs: 333,
};

type TriggerStateOwner = "condition" | "script" | "none";

function ownedDeclaration(params: {
  declarationKey: string;
  owner: TriggerStateOwner;
  script?: string;
  once?: boolean;
  state?: CronJobCreate["state"];
  sameOwnerEdit?: boolean;
}): CronJobCreate {
  const script = params.script ?? 'return "original"';
  return declaration({
    declarationKey: params.declarationKey,
    delivery: { mode: "none" },
    trigger:
      params.owner === "condition"
        ? { script, ...(params.once !== undefined ? { once: params.once } : {}) }
        : undefined,
    payload:
      params.owner === "script"
        ? { kind: "script", script, ...(params.sameOwnerEdit ? { timeoutSeconds: 45 } : {}) }
        : { kind: "agentTurn", message: "report" },
    ...(params.state ? { state: params.state } : {}),
    ...(params.sameOwnerEdit ? { displayName: "Updated report" } : {}),
  });
}

describe("CronService declarative jobs", () => {
  it("rejects malformed declared triggers without changing persisted jobs", async () => {
    const { storePath } = await makeStorePath();
    const cron = createCronService(storePath);
    await cron.start();

    try {
      const invalidTrigger = { script: "const x = ;" };
      const expectedError =
        "cron trigger script has a syntax error: Unexpected token (line 1, column 10)";

      await expect(cron.add(declaration({ trigger: invalidTrigger }))).rejects.toThrow(
        expectedError,
      );
      expect(await cron.list()).toEqual([]);

      const validTrigger = { script: "return { fire: true }" };
      const created = declarativeResult(await cron.add(declaration({ trigger: validTrigger })));

      await expect(cron.add(declaration({ trigger: invalidTrigger }))).rejects.toThrow(
        expectedError,
      );
      expect(await cron.readJob(created.id)).toMatchObject({ trigger: validTrigger });
      expect(await cron.list()).toEqual([expect.objectContaining({ trigger: validTrigger })]);
    } finally {
      cron.stop();
    }
  });

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
        payload: { toolsAllow: ["*"] },
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

  it("keeps the first creator across declaration convergence and restart", async () => {
    const { storePath } = await makeStorePath();
    const writer = createCronService(storePath);
    await writer.start();
    let createdId = "";
    const selections = [
      {
        skillId: "00000000-0000-4000-8000-000000000001",
        revision: "a".repeat(64),
        name: "s_report_00000000000040008000",
        ownerProfileId: "profile-ada",
      },
    ];

    try {
      const created = declarativeResult(
        await writer.add(declaration(), {
          createdActor: { type: "human", source: "profile", id: "profile-ada" },
          skillLibrarySelections: selections,
        }),
      );
      createdId = created.id;
      expect(created.job).toMatchObject({
        createdActor: { type: "human", id: "profile-ada" },
      });

      const converged = declarativeResult(
        await writer.add(declaration({ displayName: "Updated report" }), {
          createdActor: { type: "human", source: "profile", id: "profile-bob" },
          skillLibrarySelections: [],
        }),
      );
      expect(converged).toMatchObject({ created: false, updated: true, id: created.id });
      expect(converged.job).toMatchObject({
        createdActor: { type: "human", id: "profile-ada" },
      });
    } finally {
      writer.stop();
    }

    const reader = createCronService(storePath, false);
    await expect(reader.readJob(createdId)).resolves.toMatchObject({
      createdActor: { type: "human", id: "profile-ada" },
      skillLibrarySelections: selections,
    });
    const job = (await loadCronStore(storePath)).jobs.find((stored) => stored.id === createdId)!;
    expect(toPublicCronJob(job)).not.toHaveProperty("skillLibrarySelections");
    const first = resolveCronSession({
      cfg: {},
      sessionKey: "agent:ops:cron:test",
      agentId: "ops",
      nowMs: Date.now(),
      store: {},
      skillLibrarySelections: job.skillLibrarySelections,
      forceNew: true,
    });
    expect(first.sessionEntry.skillLibrarySelections).toEqual(selections);
    const restarted = resolveCronSession({
      cfg: {},
      sessionKey: "agent:ops:cron:test",
      agentId: "ops",
      nowMs: Date.now(),
      store: { "agent:ops:cron:test": first.sessionEntry },
      skillLibrarySelections: [],
      forceNew: true,
    });
    expect(restarted.sessionEntry.skillLibrarySelections).toEqual(selections);
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

  it.each(["ordinary update", "declarative convergence"] as const)(
    "persists trigger-state ownership transitions and explicit replacements through %s",
    async (mutationPath) => {
      const { storePath } = await makeStorePath();
      const cron = createCronService(storePath);
      await cron.start();
      const cases: Array<{
        name: string;
        previous: TriggerStateOwner;
        next: TriggerStateOwner;
        replaceScript?: boolean;
        previousOnce?: boolean;
        nextOnce?: boolean;
        sameOwnerEdit?: boolean;
        replacementState?: CronJobCreate["state"];
      }> = [
        {
          name: "condition replacement",
          previous: "condition",
          next: "condition",
          replaceScript: true,
        },
        { name: "condition removal", previous: "condition", next: "none" },
        { name: "condition to script", previous: "condition", next: "script" },
        { name: "script replacement", previous: "script", next: "script", replaceScript: true },
        { name: "script removal", previous: "script", next: "none" },
        { name: "script to condition", previous: "script", next: "condition" },
        { name: "no owner to condition", previous: "none", next: "condition" },
        { name: "no owner to script", previous: "none", next: "script" },
        {
          name: "same condition owner",
          previous: "condition",
          next: "condition",
          sameOwnerEdit: true,
        },
        { name: "same script owner", previous: "script", next: "script", sameOwnerEdit: true },
        { name: "same absent owner", previous: "none", next: "none", sameOwnerEdit: true },
        {
          name: "same explicit-false condition owner",
          previous: "condition",
          next: "condition",
          previousOnce: false,
          nextOnce: false,
          sameOwnerEdit: true,
        },
        {
          name: "condition once enabled from default",
          previous: "condition",
          next: "condition",
          nextOnce: true,
        },
        {
          name: "condition once disabled to default",
          previous: "condition",
          next: "condition",
          previousOnce: true,
        },
        {
          name: "condition once enabled from explicit false",
          previous: "condition",
          next: "condition",
          previousOnce: false,
          nextOnce: true,
        },
        {
          name: "condition once disabled to explicit false",
          previous: "condition",
          next: "condition",
          previousOnce: true,
          nextOnce: false,
        },
        {
          name: "condition once made explicit false",
          previous: "condition",
          next: "condition",
          nextOnce: false,
        },
        {
          name: "condition explicit false omitted",
          previous: "condition",
          next: "condition",
          previousOnce: false,
        },
        {
          name: "condition once explicit replacement",
          previous: "condition",
          next: "condition",
          nextOnce: true,
          replacementState: {
            triggerState: { owner: "replacement" },
            triggerEvalCount: 0,
            lastTriggerEvalAtMs: 444,
            lastTriggerFireAtMs: 555,
          },
        },
        {
          name: "explicit replacement state and count",
          previous: "condition",
          next: "condition",
          replaceScript: true,
          replacementState: { triggerState: null, triggerEvalCount: 0 },
        },
        {
          name: "explicit replacement evaluation timestamps",
          previous: "condition",
          next: "script",
          replacementState: { lastTriggerEvalAtMs: 444, lastTriggerFireAtMs: 555 },
        },
      ];
      const persistedExpectations: Array<{ id: string; state: CronJob["state"]; name: string }> =
        [];

      try {
        for (const [index, testCase] of cases.entries()) {
          const declarationKey = `trigger-owner:${mutationPath}:${index}`;
          const input = ownedDeclaration({
            declarationKey,
            owner: testCase.previous,
            once: testCase.previousOnce,
            state: retiredTriggerState,
          });
          if (mutationPath === "ordinary update") {
            delete input.declarationKey;
          }
          const result = await cron.add(input);
          const created = "job" in result ? result.job : result;
          expect(created.state, `${testCase.name}: create preserves explicit state`).toMatchObject(
            retiredTriggerState,
          );

          const next = ownedDeclaration({
            declarationKey,
            owner: testCase.next,
            script: testCase.replaceScript ? 'return "replacement"' : undefined,
            once: testCase.nextOnce,
            state: testCase.replacementState,
            sameOwnerEdit: testCase.sameOwnerEdit,
          });
          if (mutationPath === "ordinary update") {
            await cron.update(created.id, {
              trigger: next.trigger ?? null,
              payload: next.payload,
              displayName: next.displayName,
              ...(testCase.replacementState ? { state: testCase.replacementState } : {}),
            });
          } else {
            await cron.add(next);
          }

          const expectedState: CronJob["state"] = testCase.sameOwnerEdit
            ? retiredTriggerState
            : { lastRunAtMs: retiredTriggerState.lastRunAtMs, ...testCase.replacementState };
          const persisted = (await loadCronStore(storePath)).jobs.find(
            (entry) => entry.id === created.id,
          );
          expect(persisted?.state, `${testCase.name}: durable state`).toMatchObject(expectedState);
          for (const field of [
            "triggerState",
            "triggerEvalCount",
            "lastTriggerEvalAtMs",
            "lastTriggerFireAtMs",
          ] as const) {
            expect(persisted?.state[field], `${testCase.name}: ${field}`).toEqual(
              expectedState[field],
            );
          }
          persistedExpectations.push({ id: created.id, state: expectedState, name: testCase.name });
        }
      } finally {
        cron.stop();
      }

      const restarted = createCronService(storePath, false);
      for (const expected of persistedExpectations) {
        const persisted = await restarted.readJob(expected.id);
        expect(persisted?.state, `${expected.name}: restart`).toMatchObject(expected.state);
        for (const field of [
          "triggerState",
          "triggerEvalCount",
          "lastTriggerEvalAtMs",
          "lastTriggerFireAtMs",
        ] as const) {
          expect(persisted?.state[field], `${expected.name}: restart ${field}`).toEqual(
            expected.state[field],
          );
        }
      }
    },
  );

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

  it("rejects concurrent stale-owner updates across service instances sharing SQLite", async () => {
    const { storePath } = await makeStorePath();
    const first = createCronService(storePath);
    const second = createCronService(storePath);
    await first.start();
    await second.start();

    try {
      const created = declarativeResult(
        await first.add(
          ownedDeclaration({
            declarationKey: "trigger-owner:concurrent",
            owner: "condition",
            state: retiredTriggerState,
          }),
        ),
      );
      await second.readJob(created.id);
      const staleRevision = resolveCronJobConfigRevision(created.job);
      const replacementState = { triggerState: { owner: "replacement" }, triggerEvalCount: 23 };
      const commitGuard = vi.fn();

      await expect(
        first.add(
          ownedDeclaration({
            declarationKey: "trigger-owner:concurrent",
            owner: "condition",
            script: 'return "invalid"',
            state: { lastTriggerEvalAtMs: -1 },
          }),
          { commitGuard },
        ),
      ).rejects.toThrow("cron state.lastTriggerEvalAtMs must be a non-negative Date-valid integer");
      expect(commitGuard).not.toHaveBeenCalled();
      expect((await second.readJob(created.id))?.state).toMatchObject(retiredTriggerState);

      const [replacement, stale] = await Promise.allSettled([
        first.update(created.id, {
          trigger: { script: 'return "replacement"' },
          state: replacementState,
        }),
        second.updateWithPrecondition(
          created.id,
          {
            displayName: "Stale owner",
            trigger: { script: 'return "obsolete"' },
            state: { triggerState: { owner: "obsolete" }, triggerEvalCount: 99 },
          },
          (current) => {
            if (resolveCronJobConfigRevision(current) !== staleRevision) {
              throw new Error("revision conflict");
            }
          },
        ),
      ]);

      expect(replacement.status).toBe("fulfilled");
      expect(stale).toMatchObject({ status: "rejected", reason: new Error("revision conflict") });
      const persisted = await second.readJob(created.id);
      expect(persisted?.state).toMatchObject(replacementState);
      expect(persisted?.state.lastTriggerEvalAtMs).toBeUndefined();
      expect(persisted?.state.lastTriggerFireAtMs).toBeUndefined();
      expect(persisted?.displayName).toBe("Daily report");
      expect(persisted?.trigger).toEqual({ script: 'return "replacement"' });

      const currentRevision = resolveCronJobConfigRevision(persisted!);
      await second.updateWithPrecondition(
        created.id,
        { displayName: "Current owner" },
        (current) => {
          if (resolveCronJobConfigRevision(current) !== currentRevision) {
            throw new Error("revision conflict");
          }
        },
      );
      expect((await first.readJob(created.id))?.state).toMatchObject(replacementState);
    } finally {
      second.stop();
      first.stop();
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
