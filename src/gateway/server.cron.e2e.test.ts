import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
  waitForSystemEvent,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

async function yieldToEventLoop() {
  // Avoid relying on timers (fake timers can leak between tests).
  await fs.stat(process.cwd()).catch(() => {});
}

async function rmTempDir(dir: string) {
  for (let i = 0; i < 100; i += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM" || code === "EACCES") {
        await yieldToEventLoop();
        continue;
      }
      throw err;
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
}

async function waitForNonEmptyFile(pathname: string, timeoutMs = 2000) {
  const startedAt = process.hrtime.bigint();
  for (;;) {
    const raw = await fs.readFile(pathname, "utf-8").catch(() => "");
    if (raw.trim().length > 0) return raw;
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (elapsedMs >= timeoutMs) {
      throw new Error(`timeout waiting for file ${pathname}`);
    }
    await yieldToEventLoop();
  }
}

describe("gateway server cron", () => {
  test("handles cron CRUD, normalization, and patch semantics", { timeout: 120_000 }, async () => {
    const prevSkipCron = process.env.CLAWDBOT_SKIP_CRON;
    process.env.CLAWDBOT_SKIP_CRON = "0";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gw-cron-"));
    testState.cronStorePath = path.join(dir, "cron", "jobs.json");
    testState.sessionConfig = { mainKey: "primary" };
    testState.cronEnabled = false;
    await fs.mkdir(path.dirname(testState.cronStorePath), { recursive: true });
    await fs.writeFile(testState.cronStorePath, JSON.stringify({ version: 1, jobs: [] }));

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      const addRes = await rpcReq(ws, "cron.add", {
        name: "daily",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });
      expect(addRes.ok).toBe(true);
      expect(typeof (addRes.payload as { id?: unknown } | null)?.id).toBe("string");

      const listRes = await rpcReq(ws, "cron.list", {
        includeDisabled: true,
      });
      expect(listRes.ok).toBe(true);
      const jobs = (listRes.payload as { jobs?: unknown } | null)?.jobs;
      expect(Array.isArray(jobs)).toBe(true);
      expect((jobs as unknown[]).length).toBe(1);
      expect(((jobs as Array<{ name?: unknown }>)[0]?.name as string) ?? "").toBe("daily");

      const routeAtMs = Date.now() - 1;
      const routeRes = await rpcReq(ws, "cron.add", {
        name: "route test",
        enabled: true,
        schedule: { kind: "at", atMs: routeAtMs },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "cron route check" },
      });
      expect(routeRes.ok).toBe(true);
      const routeJobIdValue = (routeRes.payload as { id?: unknown } | null)?.id;
      const routeJobId = typeof routeJobIdValue === "string" ? routeJobIdValue : "";
      expect(routeJobId.length > 0).toBe(true);

      const runRes = await rpcReq(ws, "cron.run", { id: routeJobId, mode: "force" }, 20_000);
      expect(runRes.ok).toBe(true);
      const events = await waitForSystemEvent();
      expect(events.some((event) => event.includes("cron route check"))).toBe(true);

      const wrappedAtMs = Date.now() + 1000;
      const wrappedRes = await rpcReq(ws, "cron.add", {
        data: {
          name: "wrapped",
          schedule: { atMs: wrappedAtMs },
          payload: { kind: "systemEvent", text: "hello" },
        },
      });
      expect(wrappedRes.ok).toBe(true);
      const wrappedPayload = wrappedRes.payload as
        | { schedule?: unknown; sessionTarget?: unknown; wakeMode?: unknown }
        | undefined;
      expect(wrappedPayload?.sessionTarget).toBe("main");
      expect(wrappedPayload?.wakeMode).toBe("next-heartbeat");
      expect((wrappedPayload?.schedule as { kind?: unknown } | undefined)?.kind).toBe("at");

      const patchRes = await rpcReq(ws, "cron.add", {
        name: "patch test",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });
      expect(patchRes.ok).toBe(true);
      const patchJobIdValue = (patchRes.payload as { id?: unknown } | null)?.id;
      const patchJobId = typeof patchJobIdValue === "string" ? patchJobIdValue : "";
      expect(patchJobId.length > 0).toBe(true);

      const atMs = Date.now() + 1_000;
      const updateRes = await rpcReq(ws, "cron.update", {
        id: patchJobId,
        patch: {
          schedule: { atMs },
          payload: { kind: "systemEvent", text: "updated" },
        },
      });
      expect(updateRes.ok).toBe(true);
      const updated = updateRes.payload as
        | { schedule?: { kind?: unknown }; payload?: { kind?: unknown } }
        | undefined;
      expect(updated?.schedule?.kind).toBe("at");
      expect(updated?.payload?.kind).toBe("systemEvent");

      const mergeRes = await rpcReq(ws, "cron.add", {
        name: "patch merge",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello", model: "opus" },
      });
      expect(mergeRes.ok).toBe(true);
      const mergeJobIdValue = (mergeRes.payload as { id?: unknown } | null)?.id;
      const mergeJobId = typeof mergeJobIdValue === "string" ? mergeJobIdValue : "";
      expect(mergeJobId.length > 0).toBe(true);

      const mergeUpdateRes = await rpcReq(ws, "cron.update", {
        id: mergeJobId,
        patch: {
          payload: { kind: "agentTurn", deliver: true, channel: "telegram", to: "19098680" },
        },
      });
      expect(mergeUpdateRes.ok).toBe(true);
      const merged = mergeUpdateRes.payload as
        | {
            payload?: {
              kind?: unknown;
              message?: unknown;
              model?: unknown;
              deliver?: unknown;
              channel?: unknown;
              to?: unknown;
            };
          }
        | undefined;
      expect(merged?.payload?.kind).toBe("agentTurn");
      expect(merged?.payload?.message).toBe("hello");
      expect(merged?.payload?.model).toBe("opus");
      expect(merged?.payload?.deliver).toBe(true);
      expect(merged?.payload?.channel).toBe("telegram");
      expect(merged?.payload?.to).toBe("19098680");

      const rejectRes = await rpcReq(ws, "cron.add", {
        name: "patch reject",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });
      expect(rejectRes.ok).toBe(true);
      const rejectJobIdValue = (rejectRes.payload as { id?: unknown } | null)?.id;
      const rejectJobId = typeof rejectJobIdValue === "string" ? rejectJobIdValue : "";
      expect(rejectJobId.length > 0).toBe(true);

      const rejectUpdateRes = await rpcReq(ws, "cron.update", {
        id: rejectJobId,
        patch: {
          payload: { kind: "agentTurn", deliver: true },
        },
      });
      expect(rejectUpdateRes.ok).toBe(false);

      const jobIdRes = await rpcReq(ws, "cron.add", {
        name: "jobId test",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });
      expect(jobIdRes.ok).toBe(true);
      const jobIdValue = (jobIdRes.payload as { id?: unknown } | null)?.id;
      const jobId = typeof jobIdValue === "string" ? jobIdValue : "";
      expect(jobId.length > 0).toBe(true);

      const jobIdUpdateRes = await rpcReq(ws, "cron.update", {
        jobId,
        patch: {
          schedule: { atMs: Date.now() + 2_000 },
          payload: { kind: "systemEvent", text: "updated" },
        },
      });
      expect(jobIdUpdateRes.ok).toBe(true);

      const disableRes = await rpcReq(ws, "cron.add", {
        name: "disable test",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });
      expect(disableRes.ok).toBe(true);
      const disableJobIdValue = (disableRes.payload as { id?: unknown } | null)?.id;
      const disableJobId = typeof disableJobIdValue === "string" ? disableJobIdValue : "";
      expect(disableJobId.length > 0).toBe(true);

      const disableUpdateRes = await rpcReq(ws, "cron.update", {
        id: disableJobId,
        patch: { enabled: false },
      });
      expect(disableUpdateRes.ok).toBe(true);
      const disabled = disableUpdateRes.payload as { enabled?: unknown } | undefined;
      expect(disabled?.enabled).toBe(false);
    } finally {
      ws.close();
      await server.close();
      await rmTempDir(dir);
      testState.cronStorePath = undefined;
      testState.sessionConfig = undefined;
      testState.cronEnabled = undefined;
      if (prevSkipCron === undefined) {
        delete process.env.CLAWDBOT_SKIP_CRON;
      } else {
        process.env.CLAWDBOT_SKIP_CRON = prevSkipCron;
      }
    }
  });

  test("writes cron run history and auto-runs due jobs", async () => {
    const prevSkipCron = process.env.CLAWDBOT_SKIP_CRON;
    process.env.CLAWDBOT_SKIP_CRON = "0";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-gw-cron-log-"));
    testState.cronStorePath = path.join(dir, "cron", "jobs.json");
    testState.cronEnabled = undefined;
    await fs.mkdir(path.dirname(testState.cronStorePath), { recursive: true });
    await fs.writeFile(testState.cronStorePath, JSON.stringify({ version: 1, jobs: [] }));

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      const atMs = Date.now() - 1;
      const addRes = await rpcReq(ws, "cron.add", {
        name: "log test",
        enabled: true,
        schedule: { kind: "at", atMs },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });
      expect(addRes.ok).toBe(true);
      const jobIdValue = (addRes.payload as { id?: unknown } | null)?.id;
      const jobId = typeof jobIdValue === "string" ? jobIdValue : "";
      expect(jobId.length > 0).toBe(true);

      const runRes = await rpcReq(ws, "cron.run", { id: jobId, mode: "force" }, 20_000);
      expect(runRes.ok).toBe(true);
      const logPath = path.join(dir, "cron", "runs", `${jobId}.jsonl`);
      const raw = await waitForNonEmptyFile(logPath, 5000);
      const line = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .at(-1);
      const last = JSON.parse(line ?? "{}") as {
        jobId?: unknown;
        action?: unknown;
        status?: unknown;
        summary?: unknown;
      };
      expect(last.action).toBe("finished");
      expect(last.jobId).toBe(jobId);
      expect(last.status).toBe("ok");
      expect(last.summary).toBe("hello");

      const runsRes = await rpcReq(ws, "cron.runs", { id: jobId, limit: 50 });
      expect(runsRes.ok).toBe(true);
      const entries = (runsRes.payload as { entries?: unknown } | null)?.entries;
      expect(Array.isArray(entries)).toBe(true);
      expect((entries as Array<{ jobId?: unknown }>).at(-1)?.jobId).toBe(jobId);
      expect((entries as Array<{ summary?: unknown }>).at(-1)?.summary).toBe("hello");

      const statusRes = await rpcReq(ws, "cron.status", {});
      expect(statusRes.ok).toBe(true);
      const statusPayload = statusRes.payload as
        | { enabled?: unknown; storePath?: unknown }
        | undefined;
      expect(statusPayload?.enabled).toBe(true);
      const storePath = typeof statusPayload?.storePath === "string" ? statusPayload.storePath : "";
      expect(storePath).toContain("jobs.json");

      const autoRes = await rpcReq(ws, "cron.add", {
        name: "auto run test",
        enabled: true,
        schedule: { kind: "at", atMs: Date.now() - 10 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "auto" },
      });
      expect(autoRes.ok).toBe(true);
      const autoJobIdValue = (autoRes.payload as { id?: unknown } | null)?.id;
      const autoJobId = typeof autoJobIdValue === "string" ? autoJobIdValue : "";
      expect(autoJobId.length > 0).toBe(true);

      await waitForNonEmptyFile(path.join(dir, "cron", "runs", `${autoJobId}.jsonl`), 5000);
      const autoEntries = (await rpcReq(ws, "cron.runs", { id: autoJobId, limit: 10 })).payload as
        | { entries?: Array<{ jobId?: unknown }> }
        | undefined;
      expect(Array.isArray(autoEntries?.entries)).toBe(true);
      const runs = autoEntries?.entries ?? [];
      expect(runs.at(-1)?.jobId).toBe(autoJobId);
    } finally {
      ws.close();
      await server.close();
      await rmTempDir(dir);
      testState.cronStorePath = undefined;
      testState.cronEnabled = undefined;
      if (prevSkipCron === undefined) {
        delete process.env.CLAWDBOT_SKIP_CRON;
      } else {
        process.env.CLAWDBOT_SKIP_CRON = prevSkipCron;
      }
    }
  }, 45_000);
});
