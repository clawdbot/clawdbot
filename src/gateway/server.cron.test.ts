import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as setImmediatePromise } from "node:timers/promises";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import type WebSocket from "ws";
import { resetConfigRuntimeState } from "../config/config.js";
import type { GuardedFetchOptions } from "../infra/net/fetch-guard.js";
import type { GatewayCronState } from "./server-cron.js";
import {
  connectOk,
  cronIsolatedRun,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  startServerWithClient,
  testState,
  waitForSystemEvent,
} from "./test-helpers.js";

const fetchWithSsrFGuardMock = vi.hoisted(() =>
  vi.fn(async (params: GuardedFetchOptions) => ({
    response: new Response("ok", { status: 200 }),
    finalUrl: params.url,
    release: async () => {},
  })),
);

const sendFailureNotificationAnnounceMock = vi.hoisted(() => vi.fn(async () => undefined));
const closeTrackedBrowserTabsForSessionsMock = vi.hoisted(() => vi.fn(async () => 0));

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) =>
    (
      fetchWithSsrFGuardMock as unknown as (...innerArgs: unknown[]) => Promise<{
        response: Response;
        finalUrl: string;
        release: () => Promise<void>;
      }>
    )(...args),
}));

vi.mock("../cron/delivery.js", async () => {
  const actual = await vi.importActual<typeof import("../cron/delivery.js")>("../cron/delivery.js");
  return {
    ...actual,
    sendFailureNotificationAnnounce: (...args: unknown[]) =>
      (
        sendFailureNotificationAnnounceMock as unknown as (...innerArgs: unknown[]) => Promise<void>
      )(...args),
  };
});

vi.mock("../plugin-sdk/browser-maintenance.js", () => ({
  closeTrackedBrowserTabsForSessions: closeTrackedBrowserTabsForSessionsMock,
}));

installGatewayTestHooks({ scope: "suite" });
const CRON_WAIT_TIMEOUT_MS = 10_000;
const EMPTY_CRON_STORE_CONTENT = JSON.stringify({ version: 1, jobs: [] });
let cronSuiteTempRootPromise: Promise<string> | null = null;
let cronSuiteCaseId = 0;

async function getCronSuiteTempRoot(): Promise<string> {
  if (!cronSuiteTempRootPromise) {
    cronSuiteTempRootPromise = fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-cron-suite-"));
  }
  return await cronSuiteTempRootPromise;
}

async function yieldToEventLoop() {
  await setImmediatePromise();
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

async function waitForCronEvent(
  ws: WebSocket,
  check: (payload: Record<string, unknown> | null) => boolean,
  timeoutMs = CRON_WAIT_TIMEOUT_MS,
) {
  const message = await onceMessage(
    ws,
    (obj) => {
      const payload = obj.payload ?? null;
      return obj.type === "event" && obj.event === "cron" && check(payload);
    },
    timeoutMs,
  );
  return message.payload ?? null;
}

async function createCronCasePaths(tempPrefix: string): Promise<{
  dir: string;
  storePath: string;
}> {
  const suiteRoot = await getCronSuiteTempRoot();
  const dir = path.join(suiteRoot, `${tempPrefix}${cronSuiteCaseId++}`);
  const storePath = path.join(dir, "cron", "jobs.json");
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  return { dir, storePath };
}

async function cleanupCronTestRun(params: {
  ws?: { close: () => void };
  server?: { close: () => Promise<void> };
  cronState?: DirectCronState;
  prevSkipCron: string | undefined;
  clearSessionConfig?: boolean;
}) {
  params.ws?.close();
  await params.server?.close();
  params.cronState?.cron.stop();
  testState.cronStorePath = undefined;
  if (params.clearSessionConfig) {
    testState.sessionConfig = undefined;
  }
  testState.cronEnabled = undefined;
  if (params.prevSkipCron === undefined) {
    delete process.env.OPENCLAW_SKIP_CRON;
    return;
  }
  process.env.OPENCLAW_SKIP_CRON = params.prevSkipCron;
}

async function setupCronTestRun(params: {
  tempPrefix: string;
  cronEnabled?: boolean;
  sessionConfig?: { mainKey: string };
  jobs?: unknown[];
}): Promise<{ prevSkipCron: string | undefined; dir: string }> {
  const prevSkipCron = process.env.OPENCLAW_SKIP_CRON;
  process.env.OPENCLAW_SKIP_CRON = "0";
  const { dir, storePath } = await createCronCasePaths(params.tempPrefix);
  testState.cronStorePath = storePath;
  testState.sessionConfig = params.sessionConfig;
  testState.cronEnabled = params.cronEnabled;
  await fs.writeFile(
    testState.cronStorePath,
    params.jobs ? JSON.stringify({ version: 1, jobs: params.jobs }) : EMPTY_CRON_STORE_CONTENT,
  );
  return { prevSkipCron, dir };
}

type DirectCronState = GatewayCronState & {
  getRuntimeConfig: () => import("../config/types.openclaw.js").OpenClawConfig;
};

type CronBroadcast = (event: string, payload: unknown) => void;

async function createDirectCronState(params?: {
  broadcast?: CronBroadcast;
}): Promise<DirectCronState> {
  resetConfigRuntimeState();
  const [{ getRuntimeConfig }, { buildGatewayCronService }] = await Promise.all([
    import("../config/config.js"),
    import("./server-cron.js"),
  ]);
  return {
    ...buildGatewayCronService({
      cfg: getRuntimeConfig(),
      deps: {} as never,
      broadcast: params?.broadcast ?? vi.fn(),
    }),
    getRuntimeConfig: getRuntimeConfig,
  };
}

function createCronEventCollector() {
  const events: Record<string, unknown>[] = [];
  const waiters: Array<{
    check: (payload: Record<string, unknown>) => boolean;
    resolve: (payload: Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  const flush = (payload: Record<string, unknown>) => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (!waiter) {
        continue;
      }
      if (!waiter.check(payload)) {
        continue;
      }
      clearTimeout(waiter.timer);
      waiters.splice(index, 1);
      waiter.resolve(payload);
    }
  };
  return {
    broadcast(event: string, payload: unknown) {
      if (event !== "cron" || !payload || typeof payload !== "object" || Array.isArray(payload)) {
        return;
      }
      const record = payload as Record<string, unknown>;
      events.push(record);
      flush(record);
    },
    wait(check: (payload: Record<string, unknown>) => boolean, timeoutMs = CRON_WAIT_TIMEOUT_MS) {
      const existing = events.find(check);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const waiter = {
          check,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiters.splice(waiters.indexOf(waiter), 1);
            reject(new Error("timeout waiting for cron event"));
          }, timeoutMs),
        };
        waiters.push(waiter);
      });
    },
  };
}

async function directCronReq(
  cronState: DirectCronState,
  method: string,
  params: Record<string, unknown>,
): Promise<{ ok: boolean; payload?: unknown; error?: { code?: string; message?: string } }> {
  const { cronHandlers } = await import("./server-methods/cron.js");
  let result:
    | { ok: boolean; payload?: unknown; error?: { code?: string; message?: string } }
    | undefined;
  const respond = (ok: boolean, payload?: unknown, error?: { code?: string; message?: string }) => {
    result = {
      ok,
      payload,
      error,
    };
  };
  try {
    await cronHandlers[method]({
      req: {} as never,
      params,
      respond,
      context: {
        cron: cronState.cron,
        cronStorePath: cronState.storePath,
        logGateway: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
        getRuntimeConfig: cronState.getRuntimeConfig,
      } as never,
      client: null,
      isWebchatConnect: () => false,
    });
  } catch (err) {
    respond(false, undefined, {
      code: "unavailable",
      message: err instanceof Error ? err.message : String(err),
    });
  }
  if (!result) {
    throw new Error(`${method} did not respond`);
  }
  return result;
}

function expectCronJobIdFromResponse(response: { ok?: unknown; payload?: unknown }) {
  expect(response.ok).toBe(true);
  const value = (response.payload as { id?: unknown } | null)?.id;
  const id = typeof value === "string" ? value : "";
  expect(id.length > 0).toBe(true);
  return id;
}

async function addMainSystemEventCronJobDirect(params: {
  cronState: DirectCronState;
  name: string;
  text?: string;
}) {
  const response = await directCronReq(params.cronState, "cron.add", {
    name: params.name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: params.text ?? "hello" },
  });
  return expectCronJobIdFromResponse(response);
}

async function addWebhookCronJob(params: {
  ws: WebSocket;
  name: string;
  sessionTarget?: "main" | "isolated";
  payloadText?: string;
  delivery: Record<string, unknown>;
}) {
  const response = await rpcReq(params.ws, "cron.add", {
    name: params.name,
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: params.sessionTarget ?? "main",
    wakeMode: "next-heartbeat",
    payload: {
      kind: params.sessionTarget === "isolated" ? "agentTurn" : "systemEvent",
      ...(params.sessionTarget === "isolated"
        ? { message: params.payloadText ?? "test" }
        : { text: params.payloadText ?? "send webhook" }),
    },
    delivery: params.delivery,
  });
  return expectCronJobIdFromResponse(response);
}

async function writeCronConfig(config: unknown) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  expect(typeof configPath).toBe("string");
  await fs.mkdir(path.dirname(configPath as string), { recursive: true });
  await fs.writeFile(configPath as string, JSON.stringify(config, null, 2), "utf-8");
  resetConfigRuntimeState();
}

async function runCronJobForce(ws: WebSocket, id: string) {
  const response = await rpcReq(ws, "cron.run", { id, mode: "force" }, 20_000);
  expect(response.ok).toBe(true);
  expectEnqueuedRunPayload(response.payload);
  return response;
}

function expectEnqueuedRunPayload(payload: unknown): string {
  const record = payload as { ok?: unknown; enqueued?: unknown; runId?: unknown } | null;
  expect(record?.ok).toBe(true);
  expect(record?.enqueued).toBe(true);
  expect(typeof record?.runId).toBe("string");
  return record?.runId as string;
}

function expectRecordFields(actual: unknown, expected: Record<string, unknown>): void {
  const record = actual as Record<string, unknown> | null;
  for (const [key, value] of Object.entries(expected)) {
    expect(record?.[key], key).toEqual(value);
  }
}

function expectFailureAnnounceCall(params: {
  jobId: string;
  channel: string;
  to?: string;
  sessionKey: string;
  message: string;
}) {
  expect(sendFailureNotificationAnnounceMock).toHaveBeenCalledTimes(1);
  const call = sendFailureNotificationAnnounceMock.mock.calls[0];
  if (!call) {
    throw new Error("expected failure announcement call");
  }
  const args = call as unknown as [unknown, unknown, string, string, unknown, string];
  expect(typeof args[2]).toBe("string");
  expect(args[3]).toBe(params.jobId);
  expect(args[4]).toEqual({
    channel: params.channel,
    to: params.to,
    accountId: undefined,
    sessionKey: params.sessionKey,
  });
  expect(args[5]).toBe(params.message);
}

async function runCronJobAndWaitForFinished(ws: WebSocket, jobId: string) {
  const finished = waitForCronEvent(
    ws,
    (payload) => payload?.jobId === jobId && payload?.action === "finished",
  );
  await runCronJobForce(ws, jobId);
  await finished;
}

function getWebhookCall(index: number) {
  const [args] = fetchWithSsrFGuardMock.mock.calls[index] as unknown as [
    {
      url?: string;
      init?: {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      };
    },
  ];
  const url = args.url ?? "";
  const init = args.init ?? {};
  const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
  return { url, init, body };
}

describe("gateway server cron", () => {
  afterAll(async () => {
    if (!cronSuiteTempRootPromise) {
      return;
    }
    await rmTempDir(await cronSuiteTempRootPromise);
    cronSuiteTempRootPromise = null;
    cronSuiteCaseId = 0;
  });

  beforeEach(() => {
    // Keep polling helpers deterministic even if other tests left fake timers enabled.
    vi.useRealTimers();
    sendFailureNotificationAnnounceMock.mockClear();
    closeTrackedBrowserTabsForSessionsMock.mockClear();
  });

  test("handles cron CRUD, normalization, and patch semantics", { timeout: 45_000 }, async () => {
    const { prevSkipCron } = await setupCronTestRun({
      tempPrefix: "openclaw-gw-cron-",
      sessionConfig: { mainKey: "primary" },
      cronEnabled: false,
    });

    const cronState = await createDirectCronState();

    try {
      const addRes = await directCronReq(cronState, "cron.add", {
        name: "daily",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
      });
      expect(addRes.ok).toBe(true);
      const dailyJobId = (addRes.payload as { id?: unknown } | null)?.id;
      expect(typeof dailyJobId).toBe("string");

      const listRes = await directCronReq(cronState, "cron.list", {
        includeDisabled: true,
      });
      expect(listRes.ok).toBe(true);
      const jobs = (listRes.payload as { jobs?: unknown } | null)?.jobs;
      expect(Array.isArray(jobs)).toBe(true);
      expect((jobs as unknown[]).length).toBe(1);
      expect(((jobs as Array<{ name?: unknown }>)[0]?.name as string) ?? "").toBe("daily");
      expect(
        ((jobs as Array<{ delivery?: { mode?: unknown } }>)[0]?.delivery?.mode as string) ?? "",
      ).toBe("webhook");
      expect(
        (
          listRes.payload as {
            deliveryPreviews?: Record<string, { label?: unknown; detail?: unknown }>;
          } | null
        )?.deliveryPreviews?.[String(dailyJobId)],
      ).toEqual({
        label: "webhook:https://example.invalid/cron-finished",
        detail: "webhook",
      });

      const getRes = await directCronReq(cronState, "cron.get", { id: String(dailyJobId) });
      expect(getRes.ok).toBe(true);
      expect((getRes.payload as { id?: unknown } | null)?.id).toBe(dailyJobId);
      expect((getRes.payload as { name?: unknown } | null)?.name).toBe("daily");

      const missingGetRes = await directCronReq(cronState, "cron.get", { id: "missing-job-id" });
      expect(missingGetRes.ok).toBe(false);
      expect(missingGetRes.error?.code).toBe("INVALID_REQUEST");
      expect(missingGetRes.error?.message).toContain("cron job not found: missing-job-id");

      const routeAtMs = Date.now() - 1;
      const routeRes = await directCronReq(cronState, "cron.add", {
        name: "route test",
        enabled: true,
        schedule: { kind: "at", at: new Date(routeAtMs).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "cron route check" },
      });
      expect(routeRes.ok).toBe(true);
      const routeJobIdValue = (routeRes.payload as { id?: unknown } | null)?.id;
      const routeJobId = typeof routeJobIdValue === "string" ? routeJobIdValue : "";
      expect(routeJobId.length > 0).toBe(true);

      const runRes = await cronState.cron.run(routeJobId, "force");
      expect(runRes).toEqual({ ok: true, ran: true });
      const events = await waitForSystemEvent();
      expect(events.some((event) => event.includes("cron route check"))).toBe(true);

      const wrappedAtMs = Date.now() + 1000;
      const wrappedRes = await directCronReq(cronState, "cron.add", {
        data: {
          name: "wrapped",
          schedule: { at: new Date(wrappedAtMs).toISOString() },
          payload: { kind: "systemEvent", text: "hello" },
        },
      });
      expect(wrappedRes.ok).toBe(true);
      const wrappedPayload = wrappedRes.payload as
        | { schedule?: unknown; sessionTarget?: unknown; wakeMode?: unknown }
        | undefined;
      expect(wrappedPayload?.sessionTarget).toBe("main");
      expect(wrappedPayload?.wakeMode).toBe("now");
      expect((wrappedPayload?.schedule as { kind?: unknown } | undefined)?.kind).toBe("at");

      const patchJobId = await addMainSystemEventCronJobDirect({
        cronState,
        name: "patch test",
      });

      const atMs = Date.now() + 1_000;
      const updateRes = await directCronReq(cronState, "cron.update", {
        id: patchJobId,
        patch: {
          schedule: { at: new Date(atMs).toISOString() },
          payload: { kind: "systemEvent", text: "updated" },
        },
      });
      expect(updateRes.ok).toBe(true);
      const updated = updateRes.payload as
        | { schedule?: { kind?: unknown }; payload?: { kind?: unknown } }
        | undefined;
      expect(updated?.schedule?.kind).toBe("at");
      expect(updated?.payload?.kind).toBe("systemEvent");

      const mergeRes = await directCronReq(cronState, "cron.add", {
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

      const noTimeoutRes = await directCronReq(cronState, "cron.add", {
        name: "no-timeout payload",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello", timeoutSeconds: 0 },
      });
      expect(noTimeoutRes.ok).toBe(true);
      const noTimeoutPayload = noTimeoutRes.payload as
        | {
            payload?: {
              kind?: unknown;
              timeoutSeconds?: unknown;
            };
          }
        | undefined;
      expect(noTimeoutPayload?.payload?.kind).toBe("agentTurn");
      expect(noTimeoutPayload?.payload?.timeoutSeconds).toBe(0);

      const mergeUpdateRes = await directCronReq(cronState, "cron.update", {
        id: mergeJobId,
        patch: {
          delivery: { mode: "announce", channel: "telegram", to: "19098680" },
        },
      });
      expect(mergeUpdateRes.ok).toBe(true);
      const merged = mergeUpdateRes.payload as
        | {
            payload?: { kind?: unknown; message?: unknown; model?: unknown };
            delivery?: { mode?: unknown; channel?: unknown; to?: unknown };
          }
        | undefined;
      expect(merged?.payload?.kind).toBe("agentTurn");
      expect(merged?.payload?.message).toBe("hello");
      expect(merged?.payload?.model).toBe("opus");
      expect(merged?.delivery?.mode).toBe("announce");
      expect(merged?.delivery?.channel).toBe("telegram");
      expect(merged?.delivery?.to).toBe("19098680");

      const modelOnlyPatchRes = await directCronReq(cronState, "cron.update", {
        id: mergeJobId,
        patch: {
          payload: {
            model: "anthropic/claude-sonnet-4-6",
          },
        },
      });
      expect(modelOnlyPatchRes.ok).toBe(true);
      const modelOnlyPatched = modelOnlyPatchRes.payload as
        | {
            payload?: {
              kind?: unknown;
              message?: unknown;
              model?: unknown;
            };
          }
        | undefined;
      expect(modelOnlyPatched?.payload?.kind).toBe("agentTurn");
      expect(modelOnlyPatched?.payload?.message).toBe("hello");
      expect(modelOnlyPatched?.payload?.model).toBe("anthropic/claude-sonnet-4-6");

      const deliveryPatchRes = await directCronReq(cronState, "cron.update", {
        id: mergeJobId,
        patch: {
          delivery: {
            mode: "announce",
            channel: "signal",
            to: "+15550001111",
            bestEffort: true,
          },
        },
      });
      expect(deliveryPatchRes.ok).toBe(true);
      const deliveryPatched = deliveryPatchRes.payload as
        | {
            payload?: { kind?: unknown; message?: unknown };
            delivery?: { mode?: unknown; channel?: unknown; to?: unknown; bestEffort?: unknown };
          }
        | undefined;
      expect(deliveryPatched?.payload?.kind).toBe("agentTurn");
      expect(deliveryPatched?.payload?.message).toBe("hello");
      expect(deliveryPatched?.delivery?.mode).toBe("announce");
      expect(deliveryPatched?.delivery?.channel).toBe("signal");
      expect(deliveryPatched?.delivery?.to).toBe("+15550001111");
      expect(deliveryPatched?.delivery?.bestEffort).toBe(true);

      const rejectJobId = await addMainSystemEventCronJobDirect({
        cronState,
        name: "patch reject",
      });

      const rejectUpdateRes = await directCronReq(cronState, "cron.update", {
        id: rejectJobId,
        patch: {
          payload: { kind: "agentTurn", message: "nope" },
        },
      });
      expect(rejectUpdateRes.ok).toBe(false);

      const jobId = await addMainSystemEventCronJobDirect({
        cronState,
        name: "jobId test",
      });

      const jobIdUpdateRes = await directCronReq(cronState, "cron.update", {
        jobId,
        patch: {
          schedule: { at: new Date(Date.now() + 2_000).toISOString() },
          payload: { kind: "systemEvent", text: "updated" },
        },
      });
      expect(jobIdUpdateRes.ok).toBe(true);

      const disableJobId = await addMainSystemEventCronJobDirect({
        cronState,
        name: "disable test",
      });

      const disableUpdateRes = await directCronReq(cronState, "cron.update", {
        id: disableJobId,
        patch: { enabled: false },
      });
      expect(disableUpdateRes.ok).toBe(true);
      const disabled = disableUpdateRes.payload as { enabled?: unknown } | undefined;
      expect(disabled?.enabled).toBe(false);
    } finally {
      await cleanupCronTestRun({
        cronState,
        prevSkipCron,
        clearSessionConfig: true,
      });
    }
  });

  test("rejects unsafe custom session ids on add and update", async () => {
    const { prevSkipCron } = await setupCronTestRun({
      tempPrefix: "openclaw-gw-cron-bad-session-target-",
      cronEnabled: false,
    });

    const cronState = await createDirectCronState();

    try {
      const addRes = await directCronReq(cronState, "cron.add", {
        name: "bad custom session",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "session:../../outside",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "hello" },
      });
      expect(addRes.ok).toBe(false);
      expect(addRes.error?.message).toContain("invalid cron sessionTarget session id");

      const validRes = await directCronReq(cronState, "cron.add", {
        name: "good custom session",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "session:project-alpha:ops",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: "hello" },
      });
      expect(validRes.ok).toBe(true);
      const jobId = (validRes.payload as { id?: unknown } | null)?.id;
      expect(typeof jobId).toBe("string");

      const updateRes = await directCronReq(cronState, "cron.update", {
        id: jobId,
        patch: {
          sessionTarget: "session:..\\outside",
        },
      });
      expect(updateRes.ok).toBe(false);
      expect(updateRes.error?.message).toContain("invalid cron sessionTarget session id");
    } finally {
      await cleanupCronTestRun({ cronState, prevSkipCron });
    }
  });

  test("keeps delivery updates valid for main jobs owned by an explicit default agent", async () => {
    const { prevSkipCron } = await setupCronTestRun({
      tempPrefix: "openclaw-gw-cron-main-default-agent-delivery-",
      cronEnabled: false,
    });

    await writeCronConfig({
      session: {
        mainKey: "main",
      },
      agents: {
        list: [{ id: "ops", default: true }],
      },
      channels: {
        telegram: {
          botToken: "telegram-token",
        },
      },
    });

    const cronState = await createDirectCronState();

    try {
      const addRes = await directCronReq(cronState, "cron.add", {
        name: "main default agent",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        agentId: "ops",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });
      expect(addRes.ok).toBe(true);
      const jobIdValue = (addRes.payload as { id?: unknown } | null)?.id;
      const jobId = typeof jobIdValue === "string" ? jobIdValue : "";
      expect(jobId.length > 0).toBe(true);

      const updateRes = await directCronReq(cronState, "cron.update", {
        id: jobId,
        patch: {
          delivery: { mode: "announce", channel: "telegram", to: "19098680" },
        },
      });

      expect(updateRes.ok).toBe(true);
      const updated = updateRes.payload as { delivery?: unknown } | undefined;
      expect(updated?.delivery).toBeUndefined();
    } finally {
      await cleanupCronTestRun({ cronState, prevSkipCron });
    }
  });

  test("accepts implicit announce delivery when extra configured channels are disabled", async () => {
    const { prevSkipCron } = await setupCronTestRun({
      tempPrefix: "openclaw-gw-cron-disabled-channel-ambiguity-",
      cronEnabled: false,
    });

    await writeCronConfig({
      session: {
        mainKey: "main",
      },
      channels: {
        telegram: {
          botToken: "telegram-token",
        },
        slack: {
          enabled: false,
          botToken: "xoxb-slack-token",
          appToken: "xapp-slack-token",
        },
      },
    });

    const cronState = await createDirectCronState();

    try {
      const addRes = await directCronReq(cronState, "cron.add", {
        name: "disabled extra channel",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello" },
        delivery: { mode: "announce" },
      });

      if (!addRes.ok) {
        throw new Error(addRes.error?.message ?? "cron.add failed");
      }
      expect(addRes.ok).toBe(true);
    } finally {
      await cleanupCronTestRun({ cronState, prevSkipCron });
    }
  });

  test("keeps delivery updates valid after gateway config changes the default agent", async () => {
    const { prevSkipCron } = await setupCronTestRun({
      tempPrefix: "openclaw-gw-cron-main-default-agent-drift-",
      cronEnabled: false,
    });

    await writeCronConfig({
      session: {
        mainKey: "main",
      },
      agents: {
        list: [{ id: "ops", default: true }],
      },
      channels: {
        telegram: {
          botToken: "telegram-token",
        },
      },
    });

    const cronState = await createDirectCronState();

    try {
      const addRes = await directCronReq(cronState, "cron.add", {
        name: "main default agent drift",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        agentId: "ops",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
      });
      expect(addRes.ok).toBe(true);
      const jobIdValue = (addRes.payload as { id?: unknown } | null)?.id;
      const jobId = typeof jobIdValue === "string" ? jobIdValue : "";
      expect(jobId.length > 0).toBe(true);

      await writeCronConfig({
        session: {
          mainKey: "main",
        },
        agents: {
          list: [{ id: "main", default: true }, { id: "ops" }],
        },
        channels: {
          telegram: {
            botToken: "telegram-token",
          },
        },
      });

      const agentIds =
        cronState
          .getRuntimeConfig()
          .agents?.list?.map((agent) => agent.id)
          .filter((id): id is string => typeof id === "string") ?? [];
      expect(agentIds).toContain("main");
      expect(agentIds).toContain("ops");

      const updateRes = await directCronReq(cronState, "cron.update", {
        id: jobId,
        patch: {
          delivery: { mode: "announce", channel: "telegram", to: "19098680" },
        },
      });

      if (!updateRes.ok) {
        throw new Error(updateRes.error?.message ?? "cron.update failed");
      }
      expect(updateRes.ok).toBe(true);
    } finally {
      await cleanupCronTestRun({ cronState, prevSkipCron });
    }
  });

  test("ignores ambient disabled channel env when validating announce delivery", async () => {
    vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
    vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-ambient");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "ambient-telegram");
    const { prevSkipCron } = await setupCronTestRun({
      tempPrefix: "openclaw-gw-cron-ambient-disabled-delivery-",
      cronEnabled: false,
    });

    await writeCronConfig({
      session: {
        mainKey: "main",
      },
      plugins: {
        allow: ["memory-core"],
      },
    });

    const cronState = await createDirectCronState();

    try {
      const addRes = await directCronReq(cronState, "cron.add", {
        name: "ambient disabled announce",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello" },
        delivery: { mode: "announce" },
      });

      expect(addRes.ok).toBe(true);
    } finally {
      await cleanupCronTestRun({ cronState, prevSkipCron });
    }
  });

  test("writes cron run history and auto-runs due jobs", async () => {
    const { prevSkipCron } = await setupCronTestRun({
      tempPrefix: "openclaw-gw-cron-log-",
      cronEnabled: true,
    });
    const events = createCronEventCollector();
    const cronState = await createDirectCronState({ broadcast: events.broadcast });

    try {
      const addRes = await directCronReq(cronState, "cron.add", {
        name: "log test",
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

      const finishedRun = events.wait(
        (payload) => payload?.jobId === jobId && payload?.action === "finished",
      );
      const runRes = await directCronReq(cronState, "cron.run", { id: jobId, mode: "force" });
      expect(runRes.ok).toBe(true);
      expectEnqueuedRunPayload(runRes.payload);
      const manualRunId = (runRes.payload as { runId?: unknown } | null)?.runId;
      expect(typeof manualRunId).toBe("string");
      const finishedPayload = await finishedRun;
      expectRecordFields(finishedPayload, {
        jobId,
        action: "finished",
        status: "ok",
        summary: "hello",
        deliveryStatus: "not-requested",
      });

      const runsRes = await directCronReq(cronState, "cron.runs", { id: jobId, limit: 50 });
      expect(runsRes.ok).toBe(true);
      const entries = (runsRes.payload as { entries?: unknown } | null)?.entries;
      expect(Array.isArray(entries)).toBe(true);
      expect((entries as Array<{ jobId?: unknown }>).at(-1)?.jobId).toBe(jobId);
      expect((entries as Array<{ summary?: unknown }>).at(-1)?.summary).toBe("hello");
      expect((entries as Array<{ deliveryStatus?: unknown }>).at(-1)?.deliveryStatus).toBe(
        "not-requested",
      );
      expect((entries as Array<{ runId?: unknown }>).at(-1)?.runId).toBe(manualRunId);
      const allRunsRes = await directCronReq(cronState, "cron.runs", {
        scope: "all",
        limit: 50,
        statuses: ["ok"],
      });
      expect(allRunsRes.ok).toBe(true);
      const allEntries = (allRunsRes.payload as { entries?: unknown } | null)?.entries;
      expect(Array.isArray(allEntries)).toBe(true);
      expect(
        (allEntries as Array<{ jobId?: unknown }>).some((entry) => entry.jobId === jobId),
      ).toBe(true);

      const statusRes = await directCronReq(cronState, "cron.status", {});
      expect(statusRes.ok).toBe(true);
      const statusPayload = statusRes.payload as
        | { enabled?: unknown; storePath?: unknown }
        | undefined;
      expect(statusPayload?.enabled).toBe(true);
      const storePath = typeof statusPayload?.storePath === "string" ? statusPayload.storePath : "";
      expect(storePath).toContain("jobs.json");

      const autoRes = await directCronReq(cronState, "cron.add", {
        name: "auto run test",
        enabled: true,
        schedule: { kind: "at", at: new Date(Date.now() - 1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "auto" },
      });
      expect(autoRes.ok).toBe(true);
      const autoJobIdValue = (autoRes.payload as { id?: unknown } | null)?.id;
      const autoJobId = typeof autoJobIdValue === "string" ? autoJobIdValue : "";
      expect(autoJobId.length > 0).toBe(true);

      const autoFinished = events.wait(
        (payload) => payload?.jobId === autoJobId && payload?.action === "finished",
      );
      await cronState.cron.start();
      await autoFinished;
      const autoEntries = (
        await directCronReq(cronState, "cron.runs", { id: autoJobId, limit: 10 })
      ).payload as { entries?: Array<{ jobId?: unknown }> } | undefined;
      expect(Array.isArray(autoEntries?.entries)).toBe(true);
      const runs = autoEntries?.entries ?? [];
      expect(runs.at(-1)?.jobId).toBe(autoJobId);
    } finally {
      await cleanupCronTestRun({ cronState, prevSkipCron });
    }
  }, 45_000);

  test("fails closed for persisted unsafe custom session ids", async () => {
    const now = Date.now();
    const { prevSkipCron } = await setupCronTestRun({
      tempPrefix: "openclaw-gw-cron-persisted-bad-session-target-",
      cronEnabled: false,
      jobs: [
        {
          id: "bad-custom-session-job",
          name: "bad custom session job",
          enabled: true,
          createdAtMs: now,
          updatedAtMs: now,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "session:../../outside",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "hello" },
          state: {},
        },
      ],
    });

    cronIsolatedRun.mockClear();
    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      const runRes = await rpcReq(ws, "cron.run", {
        id: "bad-custom-session-job",
        mode: "force",
      });
      expect(runRes.ok).toBe(true);
      expect(runRes.payload).toEqual({ ok: true, ran: false, reason: "invalid-spec" });
      expect(cronIsolatedRun).not.toHaveBeenCalled();
    } finally {
      await cleanupCronTestRun({ ws, server, prevSkipCron });
    }
  });

  test("returns from cron.run immediately while isolated work continues in background", async () => {
    const { prevSkipCron } = await setupCronTestRun({
      tempPrefix: "openclaw-gw-cron-run-detached-",
      cronEnabled: false,
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    let resolveRun: ((value: { status: "ok"; summary: string }) => void) | undefined;
    cronIsolatedRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve as (value: { status: "ok"; summary: string }) => void;
        }),
    );

    try {
      const addRes = await rpcReq(ws, "cron.add", {
        name: "detached run test",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "do work" },
        delivery: { mode: "none" },
      });
      expect(addRes.ok).toBe(true);
      const jobIdValue = (addRes.payload as { id?: unknown } | null)?.id;
      const jobId = typeof jobIdValue === "string" ? jobIdValue : "";
      expect(jobId.length > 0).toBe(true);

      const startedRun = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === jobId && payload?.action === "started",
      );
      const runRes = await rpcReq(ws, "cron.run", { id: jobId, mode: "force" }, 1_000);
      expect(runRes.ok).toBe(true);
      expectEnqueuedRunPayload(runRes.payload);
      await startedRun;
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

      const finishedRun = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === jobId && payload?.action === "finished",
      );
      resolveRun?.({ status: "ok", summary: "background finished" });
      const finishedPayload = await finishedRun;
      expectRecordFields(finishedPayload, {
        jobId,
        action: "finished",
        status: "ok",
        summary: "background finished",
      });
    } finally {
      await cleanupCronTestRun({ ws, server, prevSkipCron });
    }
  });

  test("returns already-running without starting background work", async () => {
    const now = Date.now();
    let resolveRun: ((result: { status: "ok"; summary: string }) => void) | undefined;
    cronIsolatedRun.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRun = resolve;
        }),
    );

    const { prevSkipCron } = await setupCronTestRun({
      tempPrefix: "openclaw-gw-cron-run-busy-",
      cronEnabled: false,
      jobs: [
        {
          id: "busy-job",
          name: "busy job",
          enabled: true,
          createdAtMs: now - 60_000,
          updatedAtMs: now - 60_000,
          schedule: { kind: "at", at: new Date(now + 60_000).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "still busy" },
          delivery: { mode: "none" },
          state: {
            nextRunAtMs: now + 60_000,
          },
        },
      ],
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      const startedRun = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === "busy-job" && payload?.action === "started",
      );
      const firstRunRes = await rpcReq(ws, "cron.run", { id: "busy-job", mode: "force" }, 1_000);
      expect(firstRunRes.ok).toBe(true);
      expectEnqueuedRunPayload(firstRunRes.payload);
      await startedRun;
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

      const secondRunRes = await rpcReq(ws, "cron.run", { id: "busy-job", mode: "force" }, 1_000);
      expect(secondRunRes.ok).toBe(true);
      expect(secondRunRes.payload).toEqual({ ok: true, ran: false, reason: "already-running" });
      expect(cronIsolatedRun).toHaveBeenCalledTimes(1);

      const finishedRun = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === "busy-job" && payload?.action === "finished",
      );
      resolveRun?.({ status: "ok", summary: "busy done" });
      await finishedRun;
    } finally {
      await cleanupCronTestRun({ ws, server, prevSkipCron });
    }
  });

  test("returns not-due without starting background work", async () => {
    const now = Date.now();
    const { prevSkipCron } = await setupCronTestRun({
      tempPrefix: "openclaw-gw-cron-run-not-due-",
      cronEnabled: false,
      jobs: [
        {
          id: "future-job",
          name: "future job",
          enabled: true,
          createdAtMs: now - 60_000,
          updatedAtMs: now - 60_000,
          schedule: { kind: "at", at: new Date(now + 60_000).toISOString() },
          sessionTarget: "isolated",
          wakeMode: "next-heartbeat",
          payload: { kind: "agentTurn", message: "not yet" },
          delivery: { mode: "none" },
          state: {
            nextRunAtMs: now + 60_000,
          },
        },
      ],
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);
    cronIsolatedRun.mockClear();

    try {
      const runRes = await rpcReq(ws, "cron.run", { id: "future-job", mode: "due" }, 1_000);
      expect(runRes.ok).toBe(true);
      expect(runRes.payload).toEqual({ ok: true, ran: false, reason: "not-due" });
      expect(cronIsolatedRun).not.toHaveBeenCalled();
    } finally {
      await cleanupCronTestRun({ ws, server, prevSkipCron });
    }
  });

  test("posts webhooks for delivery mode and legacy notify fallback only when summary exists", async () => {
    const legacyNotifyJob = {
      id: "legacy-notify-job",
      name: "legacy notify job",
      enabled: true,
      notify: true,
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "legacy webhook" },
      state: {},
    };
    const { prevSkipCron } = await setupCronTestRun({
      tempPrefix: "openclaw-gw-cron-webhook-",
      cronEnabled: false,
      jobs: [legacyNotifyJob],
    });

    await writeCronConfig({
      cron: {
        webhook: "https://legacy.example.invalid/cron-finished",
        webhookToken: "cron-webhook-token",
      },
    });

    fetchWithSsrFGuardMock.mockClear();

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      const invalidWebhookRes = await rpcReq(ws, "cron.add", {
        name: "invalid webhook",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "invalid" },
        delivery: { mode: "webhook", to: "ftp://example.invalid/cron-finished" },
      });
      expect(invalidWebhookRes.ok).toBe(false);

      const notifyJobId = await addWebhookCronJob({
        ws,
        name: "webhook enabled",
        delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
      });
      await runCronJobAndWaitForFinished(ws, notifyJobId);
      const notifyCall = getWebhookCall(0);
      expect(notifyCall.url).toBe("https://example.invalid/cron-finished");
      expect(notifyCall.init.method).toBe("POST");
      expect(notifyCall.init.headers?.Authorization).toBe("Bearer cron-webhook-token");
      expect(notifyCall.init.headers?.["Content-Type"]).toBe("application/json");
      const notifyBody = notifyCall.body;
      expect(notifyBody.action).toBe("finished");
      expect(notifyBody.jobId).toBe(notifyJobId);

      const legacyFinished = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === "legacy-notify-job" && payload?.action === "finished",
      );
      const legacyRunRes = await rpcReq(
        ws,
        "cron.run",
        { id: "legacy-notify-job", mode: "force" },
        20_000,
      );
      expect(legacyRunRes.ok).toBe(true);
      expectEnqueuedRunPayload(legacyRunRes.payload);
      await legacyFinished;
      const legacyCall = getWebhookCall(1);
      expect(legacyCall.url).toBe("https://legacy.example.invalid/cron-finished");
      expect(legacyCall.init.method).toBe("POST");
      expect(legacyCall.init.headers?.Authorization).toBe("Bearer cron-webhook-token");
      const legacyBody = legacyCall.body;
      expect(legacyBody.action).toBe("finished");
      expect(legacyBody.jobId).toBe("legacy-notify-job");

      const silentRes = await rpcReq(ws, "cron.add", {
        name: "webhook disabled",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "do not send" },
      });
      expect(silentRes.ok).toBe(true);
      const silentJobIdValue = (silentRes.payload as { id?: unknown } | null)?.id;
      const silentJobId = typeof silentJobIdValue === "string" ? silentJobIdValue : "";
      expect(silentJobId.length > 0).toBe(true);

      const silentFinished = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === silentJobId && payload?.action === "finished",
      );
      const silentRunRes = await rpcReq(ws, "cron.run", { id: silentJobId, mode: "force" }, 20_000);
      expect(silentRunRes.ok).toBe(true);
      expectEnqueuedRunPayload(silentRunRes.payload);
      await silentFinished;
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(2);

      fetchWithSsrFGuardMock.mockClear();
      cronIsolatedRun.mockResolvedValueOnce({ status: "error", summary: "delivery failed" });
      const failureDestJobId = await addWebhookCronJob({
        ws,
        name: "failure destination webhook",
        sessionTarget: "isolated",
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "19098680",
          failureDestination: {
            mode: "webhook",
            to: "https://example.invalid/failure-destination",
          },
        },
      });
      const failureDestFinished = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === failureDestJobId && payload?.action === "finished",
      );
      await runCronJobForce(ws, failureDestJobId);
      await failureDestFinished;
      const failureDestCall = getWebhookCall(0);
      expect(failureDestCall.url).toBe("https://example.invalid/failure-destination");
      const failureDestBody = failureDestCall.body;
      expect(failureDestBody.message).toBe(
        'Cron job "failure destination webhook" failed: unknown error',
      );

      fetchWithSsrFGuardMock.mockClear();
      cronIsolatedRun.mockResolvedValueOnce({ status: "error", summary: "best-effort failed" });
      const bestEffortFailureDestJobId = await addWebhookCronJob({
        ws,
        name: "best effort failure destination webhook",
        sessionTarget: "isolated",
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "19098680",
          bestEffort: true,
          failureDestination: {
            mode: "webhook",
            to: "https://example.invalid/failure-destination",
          },
        },
      });
      const bestEffortFailureDestFinished = waitForCronEvent(
        ws,
        (payload) =>
          payload?.jobId === bestEffortFailureDestJobId && payload?.action === "finished",
      );
      await runCronJobForce(ws, bestEffortFailureDestJobId);
      await bestEffortFailureDestFinished;
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();

      cronIsolatedRun.mockResolvedValueOnce({ status: "ok", summary: "" });
      const noSummaryJobId = await addWebhookCronJob({
        ws,
        name: "webhook no summary",
        sessionTarget: "isolated",
        delivery: { mode: "webhook", to: "https://example.invalid/cron-finished" },
      });
      const noSummaryFinished = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === noSummaryJobId && payload?.action === "finished",
      );
      await runCronJobForce(ws, noSummaryJobId);
      await noSummaryFinished;
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    } finally {
      await cleanupCronTestRun({ ws, server, prevSkipCron });
    }
  }, 60_000);

  test("falls back to the primary delivery channel on job failure and preserves sessionKey", async () => {
    const { prevSkipCron } = await setupCronTestRun({
      tempPrefix: "openclaw-gw-cron-failure-primary-fallback-",
      cronEnabled: false,
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      cronIsolatedRun.mockResolvedValueOnce({ status: "error", summary: "delivery failed" });
      const jobId = await addWebhookCronJob({
        ws,
        name: "primary delivery fallback",
        sessionTarget: "isolated",
        delivery: {
          mode: "announce",
          channel: "last",
        },
      });

      const updateRes = await rpcReq(ws, "cron.update", {
        id: jobId,
        patch: {
          sessionKey: "agent:main:telegram:direct:123:thread:99",
        },
      });
      expect(updateRes.ok).toBe(true);

      const finished = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === jobId && payload?.action === "finished",
      );
      await runCronJobForce(ws, jobId);
      await finished;

      expectFailureAnnounceCall({
        jobId,
        channel: "last",
        sessionKey: "agent:main:telegram:direct:123:thread:99",
        message: '⚠️ Cron job "primary delivery fallback" failed: unknown error',
      });
    } finally {
      await cleanupCronTestRun({ ws, server, prevSkipCron });
    }
  }, 45_000);

  test("prefers sessionTarget session context for failure announcements over creator sessionKey", async () => {
    const { prevSkipCron } = await setupCronTestRun({
      tempPrefix: "openclaw-gw-cron-failure-session-target-",
      cronEnabled: false,
    });

    const { server, ws } = await startServerWithClient();
    await connectOk(ws);

    try {
      cronIsolatedRun.mockResolvedValueOnce({ status: "error", summary: "delivery failed" });
      const addRes = await rpcReq(ws, "cron.add", {
        name: "session target failure fallback",
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "session:agent:avery:feishu:direct:ou_founder",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "test" },
        delivery: {
          mode: "announce",
          channel: "feishu",
          to: "ou_founder",
        },
      });
      const jobId = expectCronJobIdFromResponse(addRes);

      const updateRes = await rpcReq(ws, "cron.update", {
        id: jobId,
        patch: {
          sessionKey: "agent:avery:feishu:group:oc_group:sender:ou_founder",
        },
      });
      expect(updateRes.ok).toBe(true);

      const finished = waitForCronEvent(
        ws,
        (payload) => payload?.jobId === jobId && payload?.action === "finished",
      );
      await runCronJobForce(ws, jobId);
      await finished;

      expectFailureAnnounceCall({
        jobId,
        channel: "feishu",
        to: "ou_founder",
        sessionKey: "agent:avery:feishu:direct:ou_founder",
        message: '⚠️ Cron job "session target failure fallback" failed: unknown error',
      });
    } finally {
      await cleanupCronTestRun({ ws, server, prevSkipCron });
    }
  }, 45_000);

  test("rejects malformed cron.webhookToken objects at startup", async () => {
    const { prevSkipCron } = await setupCronTestRun({
      tempPrefix: "openclaw-gw-cron-webhook-secretinput-",
      cronEnabled: false,
    });

    await writeCronConfig({
      cron: {
        webhookToken: {
          opaque: true,
        },
      },
    });

    await expect(startServerWithClient()).rejects.toThrow("cron.webhookToken: Invalid input");
    await cleanupCronTestRun({ prevSkipCron });
  }, 45_000);
});
