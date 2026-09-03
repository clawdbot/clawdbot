import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { createCronStoreHarness, createNoopLogger } from "./service.test-harness.js";
import { loadCronStore } from "./store.js";
import type { CronPayloadPatch } from "./types.js";

const { makeStorePath } = createCronStoreHarness({ prefix: "cron-payload-conversion-" });
const logger = createNoopLogger();

describe("cron payload conversion", () => {
  it.each([
    { kind: "command", argv: ["echo", "ready"] },
    { kind: "command", argv: ["echo", "ready"], env: undefined },
  ] satisfies CronPayloadPatch[])(
    "persists a command conversion with optional env %j",
    async (payload) => {
      const { storePath } = await makeStorePath();
      const cron = new CronService({
        storePath,
        cronEnabled: false,
        log: logger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(),
      });
      try {
        const job = await cron.add({
          name: "convert payload",
          enabled: false,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "before", toolsAllow: ["read"] },
        });
        const updated = await cron.update(job.id, { payload });
        expect(updated.payload).toEqual({
          kind: "command",
          argv: ["echo", "ready"],
          toolsAllow: ["read"],
        });
        expect((await loadCronStore(storePath)).jobs[0]?.payload).toEqual(updated.payload);

        await cron.update(job.id, { payload: { kind: "script", script: "return {};" } });
        expect((await loadCronStore(storePath)).jobs[0]?.payload).toEqual({
          kind: "script",
          script: "return {};",
          timeoutSeconds: 300,
          toolBudget: 50,
          toolsAllow: ["read"],
        });
        await cron.update(job.id, { payload: { kind: "agentTurn", message: "after" } });
        expect((await loadCronStore(storePath)).jobs[0]?.payload).toEqual({
          kind: "agentTurn",
          message: "after",
          toolsAllow: ["read"],
        });

        await expect(
          cron.update(job.id, {
            payload: { kind: "command", argv: ["echo"], env: null as never },
          }),
        ).rejects.toThrow("command env");
        expect((await loadCronStore(storePath)).jobs[0]?.payload).toEqual({
          kind: "agentTurn",
          message: "after",
          toolsAllow: ["read"],
        });

        const configured = { kind: "command", argv: ["echo"], env: { MODE: "test" } } as const;
        await cron.update(job.id, { payload: { ...configured, argv: [...configured.argv] } });
        expect((await loadCronStore(storePath)).jobs[0]?.payload).toEqual({
          ...configured,
          toolsAllow: ["read"],
        });
      } finally {
        cron.stop();
      }
    },
  );
});
