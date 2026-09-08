import { describe, expect, it } from "vitest";
import { UpdateRunRecordSchema as LedgerRecordSchema } from "../../../src/infra/update-run-schema.js";
import {
  validateUpdateRunChangedEvent,
  validateUpdateRunRecord,
  validateUpdateRunResult,
  validateUpdateRunsGetParams,
  validateUpdateRunsGetResult,
  validateUpdateRunsListParams,
  validateUpdateRunsListResult,
  validateUpdateStatusResult,
} from "./index.js";
import { UPDATE_RUN_DRIVER_LIMIT } from "./update-run-vocabulary.js";

const run = LedgerRecordSchema.parse({
  runId: "27d967ef-0485-4f98-a93a-229d50c75111",
  createdAtMs: 100,
  updatedAtMs: 300,
  trigger: "campaign",
  phase: "finished",
  status: "succeeded",
  reason: null,
  origin: {
    driver: { host: "gateway.test", pid: 1234, startIdentity: "98765" },
    previousDrivers: [{ host: "gateway.test", pid: 1200, startIdentity: "98700" }],
    requester: { channel: "telegram", accountId: "primary", senderId: "operator" },
    sessionKey: "agent:main:main",
    deliveryContext: { channel: "telegram", to: "chat", accountId: "default", threadId: "1" },
    campaignId: "campaign-1",
    doctorHint: "openclaw doctor",
    nextAction: "openclaw update status",
  },
  target: { channel: "dev", tag: "latest", kind: "git", version: "2026.9.1", sha: "abcdef" },
  before: { version: "2026.8.1", sha: null, buildId: null },
  after: { version: "2026.9.1", sha: "abcdef", buildId: "build-1" },
  steps: [{ step: "doctor", status: "completed", startedAtMs: 100, endedAtMs: 200, detail: "ok" }],
  verification: {
    booted: true,
    runningVersion: "2026.9.1",
    runningBuildId: "build-1",
    serviceRunning: true,
    pid: 123,
    port: 19001,
    versionMatch: true,
    pluginErrors: [],
    channelsReady: true,
    noticeDelivered: true,
    doctorHint: "openclaw doctor",
  },
  repair: [
    {
      attempt: 1,
      status: "succeeded",
      startedAtMs: 150,
      endedAtMs: 175,
      summary: "Repaired",
      reason: "doctor",
    },
  ],
  confirmedAtMs: 290,
  finishedAtMs: 300,
  downtimeMs: 25,
});

describe("update run wire contract", () => {
  it("carries a canonical ledger record through lookup, history, and additive status responses", () => {
    expect(validateUpdateRunRecord(run)).toBe(true);
    expect(validateUpdateRunsGetResult({ run })).toBe(true);
    expect(validateUpdateRunsGetResult({ run: null })).toBe(true);
    expect(validateUpdateRunsListResult({ runs: [run] })).toBe(true);
    expect(validateUpdateRunsListResult({ runs: [] })).toBe(true);
    expect(validateUpdateStatusResult({ sentinel: null, updateAvailable: null })).toBe(true);
    expect(
      validateUpdateStatusResult({ sentinel: null, updateAvailable: null, lastRun: run }),
    ).toBe(true);
    expect(
      validateUpdateStatusResult({
        sentinel: null,
        updateAvailable: null,
        activeRun: { ...run, phase: "staging", status: "running", finishedAtMs: null },
      }),
    ).toBe(true);
  });

  it.each([
    ["malformed UUID", { runId: "not-a-run-id" }],
    ["non-RFC UUID", { runId: "27d967ef-0485-0f98-a93a-229d50c75111" }],
    ["unknown phase", { phase: "complete" }],
    ["unknown status", { status: "ok" }],
    ["unknown trigger", { trigger: "web" }],
    ["negative timestamp", { updatedAtMs: -1 }],
    ["unsafe timestamp", { updatedAtMs: Number.MAX_SAFE_INTEGER + 1 }],
    ["oversized text", { reason: "x".repeat(1025) }],
    ["oversized steps", { steps: Array.from({ length: 129 }, () => run.steps[0]) }],
    ["oversized repairs", { repair: Array.from({ length: 17 }, () => run.repair[0]) }],
    ["invalid service port", { verification: { port: 65536 } }],
    [
      "oversized driver host",
      { origin: { driver: { ...run.origin.driver, host: "x".repeat(256) } } },
    ],
    [
      "oversized driver start identity",
      { origin: { driver: { ...run.origin.driver, startIdentity: "1".repeat(129) } } },
    ],
    [
      "too many previous drivers",
      {
        origin: {
          previousDrivers: Array.from({ length: UPDATE_RUN_DRIVER_LIMIT }, () => run.origin.driver),
        },
      },
    ],
    [
      "oversized plugin errors",
      { verification: { pluginErrors: Array.from({ length: 33 }, () => "failed") } },
    ],
  ])("rejects %s consistently with the canonical ledger", (_name, fields) => {
    const invalid = { ...run, ...fields };
    expect(LedgerRecordSchema.safeParse(invalid).success).toBe(false);
    expect(validateUpdateRunRecord(invalid)).toBe(false);
  });

  it("bounds history reads and requires an exact run identity", () => {
    expect(validateUpdateRunsGetParams({ runId: run.runId })).toBe(true);
    expect(validateUpdateRunsGetParams({ runId: "" })).toBe(false);
    expect(validateUpdateRunsGetParams({ runId: run.runId, force: true })).toBe(false);
    for (const params of [{}, { limit: 1 }, { limit: 100 }]) {
      expect(validateUpdateRunsListParams(params)).toBe(true);
    }
    for (const params of [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { limit: "10" },
      { offset: 1 },
    ]) {
      expect(validateUpdateRunsListParams(params)).toBe(false);
    }
  });

  it("requires run identity on both update admission and phase notifications", () => {
    const outcome = {
      ok: false,
      code: "owner_required",
      message: "Owner required",
      result: { status: "error", reason: "owner_required" },
    };
    expect(validateUpdateRunResult({ ...outcome, runId: run.runId })).toBe(true);
    expect(validateUpdateRunResult(outcome)).toBe(false);
    const change = { runId: run.runId, phase: "verifying", status: "running", updatedAtMs: 250 };
    expect(validateUpdateRunChangedEvent(change)).toBe(true);
    expect(validateUpdateRunChangedEvent({ ...change, phase: "complete" })).toBe(false);
    expect(validateUpdateRunChangedEvent({ ...change, status: "ok" })).toBe(false);
    expect(validateUpdateRunChangedEvent({ ...change, runId: "other" })).toBe(false);
    expect(validateUpdateRunChangedEvent({ ...change, log: "private output" })).toBe(false);
  });
});
