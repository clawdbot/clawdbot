import { describe, expect, it, vi } from "vitest";
import { CronService } from "../service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "../service.test-harness.js";
import type { CronDelivery, CronJobCreate } from "../types.js";
import { resolveInitialCronDelivery } from "./initial-delivery.js";

function createInput(params: {
  sessionTarget: CronJobCreate["sessionTarget"];
  payload: CronJobCreate["payload"];
  delivery?: CronDelivery;
}): CronJobCreate {
  return {
    name: "initial delivery",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: params.sessionTarget,
    wakeMode: "now",
    failureAlert: false,
    payload: params.payload,
    delivery: params.delivery,
  };
}

describe("resolveInitialCronDelivery", () => {
  it("preserves explicit delivery", () => {
    const delivery: CronDelivery = { mode: "none" };
    expect(
      resolveInitialCronDelivery(
        createInput({
          sessionTarget: "current",
          payload: { kind: "agentTurn", message: "hello" },
          delivery,
        }),
      ),
    ).toBe(delivery);
  });

  it.each(["isolated", "current", "session:project-alpha"] as const)(
    "defaults %s output jobs to announce",
    (sessionTarget) => {
      const payloads: CronJobCreate["payload"][] = [
        { kind: "agentTurn", message: "hello" },
        { kind: "command", argv: ["echo", "hello"] },
        { kind: "script", script: "return { notify: 'hello' }" },
      ];
      for (const payload of payloads) {
        expect(resolveInitialCronDelivery(createInput({ sessionTarget, payload }))).toEqual({
          mode: "announce",
        });
      }
    },
  );

  it("does not default main-session output or system-event delivery", () => {
    expect(
      resolveInitialCronDelivery(
        createInput({ sessionTarget: "main", payload: { kind: "agentTurn", message: "hello" } }),
      ),
    ).toBeUndefined();
    expect(
      resolveInitialCronDelivery(
        createInput({ sessionTarget: "isolated", payload: { kind: "systemEvent", text: "tick" } }),
      ),
    ).toBeUndefined();
  });
});

// Direct service callers do not pass through normalizeCronJobCreate, so keep
// the public add and declarative convergence paths pinned to the same default.
const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-initial-delivery-" });
installCronTestHooks({ logger });

function createDirectCronService(storePath: string) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

describe("CronService initial delivery", () => {
  it.each(["current", "session:project-alpha"] as const)(
    "persists announce delivery for direct %s jobs",
    async (sessionTarget) => {
      const { storePath } = await makeStorePath();
      const cron = createDirectCronService(storePath);
      await cron.start();

      try {
        const added = await cron.add(
          createInput({ sessionTarget, payload: { kind: "agentTurn", message: "hello" } }),
        );
        expect(added.delivery).toEqual({ mode: "announce" });
        await expect(cron.readJob(added.id)).resolves.toMatchObject({
          delivery: { mode: "announce" },
        });
      } finally {
        cron.stop();
      }
    },
  );

  it("keeps announce delivery when a declaration converges", async () => {
    const { storePath } = await makeStorePath();
    const cron = createDirectCronService(storePath);
    await cron.start();
    const declaration = {
      ...createInput({
        sessionTarget: "session:project-alpha",
        payload: { kind: "agentTurn", message: "hello" },
      }),
      declarationKey: "agent:ops:initial-delivery",
    };

    try {
      const created = await cron.add(declaration);
      expect(created.delivery).toEqual({ mode: "announce" });

      const converged = await cron.add(declaration, { enabledExplicit: true });
      if (!("job" in converged)) {
        throw new Error("expected declarative cron result");
      }
      expect(converged).toMatchObject({
        created: false,
        updated: false,
        job: { delivery: { mode: "announce" } },
      });
      await expect(cron.readJob(converged.job.id)).resolves.toMatchObject({
        delivery: { mode: "announce" },
      });
    } finally {
      cron.stop();
    }
  });
});
