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

installGatewayTestHooks();

describe("gateway server cron", () => {
  test("supports cron.add and cron.list", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-cron-"));
    testState.cronStorePath = path.join(dir, "cron", "jobs.json");
    await fs.mkdir(path.dirname(testState.cronStorePath), { recursive: true });
    await fs.writeFile(
      testState.cronStorePath,
      JSON.stringify({ version: 1, jobs: [] }),
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const addRes = await rpcReq(ws, "cron.add", {
      name: "daily",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hello" },
    });
    expect(addRes.ok).toBe(true);
    expect(typeof (addRes.payload as { id?: unknown } | null)?.id).toBe(
      "string",
    );

    const listRes = await rpcReq(ws, "cron.list", {
      includeDisabled: true,
    });
    expect(listRes.ok).toBe(true);
    const jobs = (listRes.payload as { jobs?: unknown } | null)?.jobs;
    expect(Array.isArray(jobs)).toBe(true);
    expect((jobs as unknown[]).length).toBe(1);
    expect(((jobs as Array<{ name?: unknown }>)[0]?.name as string) ?? "").toBe(
      "daily",
    );

    ws.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
    testState.cronStorePath = undefined;
  });

  test("enqueues main cron system events to the resolved main session key", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-cron-"));
    testState.cronStorePath = path.join(dir, "cron", "jobs.json");
    testState.sessionConfig = { mainKey: "primary" };
    await fs.mkdir(path.dirname(testState.cronStorePath), { recursive: true });
    await fs.writeFile(
      testState.cronStorePath,
      JSON.stringify({ version: 1, jobs: [] }),
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const atMs = Date.now() - 1;
    const addRes = await rpcReq(ws, "cron.add", {
      name: "route test",
      enabled: true,
      schedule: { kind: "at", atMs },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "cron route check" },
    });
    expect(addRes.ok).toBe(true);
    const jobIdValue = (addRes.payload as { id?: unknown } | null)?.id;
    const jobId = typeof jobIdValue === "string" ? jobIdValue : "";
    expect(jobId.length > 0).toBe(true);

    const runRes = await rpcReq(ws, "cron.run", { id: jobId, mode: "force" });
    expect(runRes.ok).toBe(true);

    const events = await waitForSystemEvent();
    expect(events.some((event) => event.includes("cron route check"))).toBe(
      true,
    );

    ws.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
    testState.cronStorePath = undefined;
    testState.sessionConfig = undefined;
  });

  test("normalizes wrapped cron.add payloads", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-cron-"));
    testState.cronStorePath = path.join(dir, "cron", "jobs.json");
    await fs.mkdir(path.dirname(testState.cronStorePath), { recursive: true });
    await fs.writeFile(
      testState.cronStorePath,
      JSON.stringify({ version: 1, jobs: [] }),
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const atMs = Date.now() + 1000;
    const addRes = await rpcReq(ws, "cron.add", {
      data: {
        name: "wrapped",
        schedule: { atMs },
        payload: { text: "hello" },
      },
    });
    expect(addRes.ok).toBe(true);
    const payload = addRes.payload as
      | { schedule?: unknown; sessionTarget?: unknown; wakeMode?: unknown }
      | undefined;
    expect(payload?.sessionTarget).toBe("main");
    expect(payload?.wakeMode).toBe("next-heartbeat");
    expect((payload?.schedule as { kind?: unknown } | undefined)?.kind).toBe(
      "at",
    );

    ws.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
    testState.cronStorePath = undefined;
  });

  test("normalizes cron.update patch payloads", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-cron-"));
    testState.cronStorePath = path.join(dir, "cron", "jobs.json");
    await fs.mkdir(path.dirname(testState.cronStorePath), { recursive: true });
    await fs.writeFile(
      testState.cronStorePath,
      JSON.stringify({ version: 1, jobs: [] }),
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const addRes = await rpcReq(ws, "cron.add", {
      name: "patch test",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hello" },
    });
    expect(addRes.ok).toBe(true);
    const jobIdValue = (addRes.payload as { id?: unknown } | null)?.id;
    const jobId = typeof jobIdValue === "string" ? jobIdValue : "";
    expect(jobId.length > 0).toBe(true);

    const atMs = Date.now() + 1_000;
    const updateRes = await rpcReq(ws, "cron.update", {
      id: jobId,
      patch: {
        schedule: { atMs },
        payload: { text: "updated" },
      },
    });
    expect(updateRes.ok).toBe(true);
    const updated = updateRes.payload as
      | { schedule?: { kind?: unknown }; payload?: { kind?: unknown } }
      | undefined;
    expect(updated?.schedule?.kind).toBe("at");
    expect(updated?.payload?.kind).toBe("systemEvent");

    ws.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
    testState.cronStorePath = undefined;
  });

  test("accepts jobId for cron.update", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-cron-"));
    testState.cronStorePath = path.join(dir, "cron", "jobs.json");
    await fs.mkdir(path.dirname(testState.cronStorePath), { recursive: true });
    await fs.writeFile(
      testState.cronStorePath,
      JSON.stringify({ version: 1, jobs: [] }),
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const addRes = await rpcReq(ws, "cron.add", {
      name: "jobId test",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hello" },
    });
    expect(addRes.ok).toBe(true);
    const jobIdValue = (addRes.payload as { id?: unknown } | null)?.id;
    const jobId = typeof jobIdValue === "string" ? jobIdValue : "";
    expect(jobId.length > 0).toBe(true);

    const atMs = Date.now() + 2_000;
    const updateRes = await rpcReq(ws, "cron.update", {
      jobId,
      patch: {
        schedule: { atMs },
        payload: { text: "updated" },
      },
    });
    expect(updateRes.ok).toBe(true);

    ws.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
    testState.cronStorePath = undefined;
  });

  test("disables cron jobs via enabled:false patches", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-gw-cron-"));
    testState.cronStorePath = path.join(dir, "cron", "jobs.json");
    await fs.mkdir(path.dirname(testState.cronStorePath), { recursive: true });
    await fs.writeFile(
      testState.cronStorePath,
      JSON.stringify({ version: 1, jobs: [] }),
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const addRes = await rpcReq(ws, "cron.add", {
      name: "disable test",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "hello" },
    });
    expect(addRes.ok).toBe(true);
    const jobIdValue = (addRes.payload as { id?: unknown } | null)?.id;
    const jobId = typeof jobIdValue === "string" ? jobIdValue : "";
    expect(jobId.length > 0).toBe(true);

    const updateRes = await rpcReq(ws, "cron.update", {
      id: jobId,
      patch: { enabled: false },
    });
    expect(updateRes.ok).toBe(true);
    const updated = updateRes.payload as { enabled?: unknown } | undefined;
    expect(updated?.enabled).toBe(false);

    ws.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
    testState.cronStorePath = undefined;
  });

  test("writes cron run history to runs/<jobId>.jsonl", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-gw-cron-log-"),
    );
    testState.cronStorePath = path.join(dir, "cron", "jobs.json");
    await fs.mkdir(path.dirname(testState.cronStorePath), { recursive: true });
    await fs.writeFile(
      testState.cronStorePath,
      JSON.stringify({ version: 1, jobs: [] }),
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

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

    const runRes = await rpcReq(ws, "cron.run", { id: jobId, mode: "force" });
    expect(runRes.ok).toBe(true);

    const logPath = path.join(dir, "cron", "runs", `${jobId}.jsonl`);
    const waitForLog = async () => {
      for (let i = 0; i < 200; i += 1) {
        const raw = await fs.readFile(logPath, "utf-8").catch(() => "");
        if (raw.trim().length > 0) return raw;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("timeout waiting for cron run log");
    };

    const raw = await waitForLog();
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
    expect((entries as Array<{ summary?: unknown }>).at(-1)?.summary).toBe(
      "hello",
    );

    ws.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
    testState.cronStorePath = undefined;
  });

  test("writes cron run history to per-job runs/ when store is jobs.json", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-gw-cron-log-jobs-"),
    );
    const cronDir = path.join(dir, "cron");
    testState.cronStorePath = path.join(cronDir, "jobs.json");
    await fs.mkdir(cronDir, { recursive: true });
    await fs.writeFile(
      testState.cronStorePath,
      JSON.stringify({ version: 1, jobs: [] }),
    );

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    const atMs = Date.now() - 1;
    const addRes = await rpcReq(ws, "cron.add", {
      name: "log test (jobs.json)",
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

    const runRes = await rpcReq(ws, "cron.run", { id: jobId, mode: "force" });
    expect(runRes.ok).toBe(true);

    const logPath = path.join(cronDir, "runs", `${jobId}.jsonl`);
    const waitForLog = async () => {
      for (let i = 0; i < 200; i += 1) {
        const raw = await fs.readFile(logPath, "utf-8").catch(() => "");
        if (raw.trim().length > 0) return raw;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("timeout waiting for per-job cron run log");
    };

    const raw = await waitForLog();
    const line = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1);
    const last = JSON.parse(line ?? "{}") as {
      jobId?: unknown;
      action?: unknown;
      summary?: unknown;
    };
    expect(last.action).toBe("finished");
    expect(last.jobId).toBe(jobId);
    expect(last.summary).toBe("hello");

    const runsRes = await rpcReq(ws, "cron.runs", { id: jobId, limit: 20 });
    expect(runsRes.ok).toBe(true);
    const entries = (runsRes.payload as { entries?: unknown } | null)?.entries;
    expect(Array.isArray(entries)).toBe(true);
    expect((entries as Array<{ jobId?: unknown }>).at(-1)?.jobId).toBe(jobId);
    expect((entries as Array<{ summary?: unknown }>).at(-1)?.summary).toBe(
      "hello",
    );

    ws.close();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
    testState.cronStorePath = undefined;
  });

  test("enables cron scheduler by default and runs due jobs automatically", async () => {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), "clawdbot-gw-cron-default-on-"),
    );
    testState.cronStorePath = path.join(dir, "cron", "jobs.json");
    testState.cronEnabled = undefined;

    try {
      await fs.mkdir(path.dirname(testState.cronStorePath), {
        recursive: true,
      });
      await fs.writeFile(
        testState.cronStorePath,
        JSON.stringify({ version: 1, jobs: [] }),
      );

      const { server, ws } = await startServerWithClient();
      await connectOk(ws);

      const statusRes = await rpcReq(ws, "cron.status", {});
      expect(statusRes.ok).toBe(true);
      const statusPayload = statusRes.payload as
        | { enabled?: unknown; storePath?: unknown }
        | undefined;
      expect(statusPayload?.enabled).toBe(true);
      const storePath =
        typeof statusPayload?.storePath === "string"
          ? statusPayload.storePath
          : "";
      expect(storePath).toContain("jobs.json");

      // Keep the job due immediately; we poll run logs instead of relying on
      // the cron finished event to avoid timing races under heavy load.
      const atMs = Date.now() - 10;
      const addRes = await rpcReq(ws, "cron.add", {
        name: "auto run test",
        enabled: true,
        schedule: { kind: "at", atMs },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "auto" },
      });
      expect(addRes.ok).toBe(true);
      const jobIdValue = (addRes.payload as { id?: unknown } | null)?.id;
      const jobId = typeof jobIdValue === "string" ? jobIdValue : "";
      expect(jobId.length > 0).toBe(true);

      const waitForRuns = async () => {
        for (let i = 0; i < 500; i += 1) {
          const runsRes = await rpcReq(ws, "cron.runs", {
            id: jobId,
            limit: 10,
          });
          expect(runsRes.ok).toBe(true);
          const entries = (runsRes.payload as { entries?: unknown } | null)
            ?.entries;
          if (Array.isArray(entries) && entries.length > 0) return entries;
          await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error("timeout waiting for cron.runs entries");
      };

      const entries = (await waitForRuns()) as Array<{ jobId?: unknown }>;
      expect(entries.at(-1)?.jobId).toBe(jobId);

      ws.close();
      await server.close();
    } finally {
      testState.cronEnabled = false;
      testState.cronStorePath = undefined;
      await fs.rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
