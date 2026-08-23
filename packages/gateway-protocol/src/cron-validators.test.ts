// Gateway Protocol tests cover cron validators behavior.
import { MAX_DATE_TIMESTAMP_MS } from "@openclaw/normalization-core/number-coercion";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  validateCronAddParams,
  validateCronGetParams,
  validateCronListParams,
  validateCronRemoveParams,
  validateCronRunParams,
  validateCronRunsParams,
  validateCronUpdateParams,
} from "./index.js";
import { CronJobSchema } from "./schema/cron.js";

/**
 * Cron validator regressions for public scheduler RPC payloads.
 *
 * The cases cover both canonical `id` selectors and legacy `jobId` aliases,
 * delivery routing, update clears, and run-log path traversal guards.
 */
const minimalAddParams = {
  name: "daily-summary",
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
  payload: { kind: "systemEvent", text: "tick" },
} as const;
const add = (overrides: Record<string, unknown> = {}) => ({ ...minimalAddParams, ...overrides });
const update = (patch: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  id: "job-1",
  patch,
  ...overrides,
});
const agentToolCallerScope = { kind: "agentTool", agentId: "ops" } as const;
function expectCases(
  validate: (value: unknown) => boolean,
  expected: boolean,
  values: readonly unknown[],
) {
  for (const value of values) {
    expect(validate(value)).toBe(expected);
  }
}

describe("cron protocol validators", () => {
  it("accepts minimal add params", () => {
    expectCases(validateCronAddParams, true, [minimalAddParams]);
  });

  it("reports auto-disable state without accepting it in writable patches", () => {
    const job = {
      ...minimalAddParams,
      id: "job-1",
      enabled: false,
      createdAtMs: 1,
      updatedAtMs: 2,
      state: {
        consecutiveErrors: 10,
        autoDisabled: {
          reason: "consecutive-failures",
          atMs: MAX_DATE_TIMESTAMP_MS,
          consecutiveErrors: 10,
        },
      },
    };
    expect(Value.Check(CronJobSchema, job)).toBe(true);
    expect(
      Value.Check(CronJobSchema, {
        ...job,
        state: {
          ...job.state,
          autoDisabled: { ...job.state.autoDisabled, atMs: MAX_DATE_TIMESTAMP_MS + 1 },
        },
      }),
    ).toBe(false);
    expect(validateCronUpdateParams(update({ state: job.state }))).toBe(false);
  });

  it("rejects client-authored scheduled authority provenance", () => {
    const scheduledToolPolicy = { version: 1, mode: "trusted" } as const;
    expectCases(validateCronAddParams, false, [add({ scheduledToolPolicy })]);
    expectCases(validateCronUpdateParams, false, [update({ scheduledToolPolicy })]);
  });

  it("accepts failure alert field clears only in update patches", () => {
    const failureAlert = {
      after: null,
      channel: null,
      to: null,
      cooldownMs: null,
      includeSkipped: null,
      mode: null,
      accountId: null,
    };
    expectCases(validateCronUpdateParams, true, [update({ failureAlert })]);
    expectCases(validateCronAddParams, false, [add({ failureAlert })]);
    expectCases(validateCronUpdateParams, true, [update({ failureAlert: null })]);
    expectCases(validateCronAddParams, false, [add({ failureAlert: null })]);
  });

  it("rejects schedule integers that SQLite cannot round-trip safely", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    expectCases(validateCronAddParams, false, [
      add({ schedule: { kind: "every", everyMs: unsafe } }),
    ]);
    expectCases(validateCronUpdateParams, false, [
      update({ schedule: { kind: "every", everyMs: 60_000, anchorMs: unsafe } }),
      update({ schedule: { kind: "cron", expr: "0 * * * *", staggerMs: unsafe } }),
    ]);
  });

  it("rejects every schedule numbers outside the ECMAScript Date range", () => {
    const invalidTimestamp = MAX_DATE_TIMESTAMP_MS + 1;
    expectCases(validateCronAddParams, false, [
      add({ schedule: { kind: "every", everyMs: invalidTimestamp } }),
      add({ schedule: { kind: "every", everyMs: 60_000, anchorMs: invalidTimestamp } }),
      add({ schedule: { kind: "cron", expr: "0 * * * *", staggerMs: invalidTimestamp } }),
    ]);
    expectCases(validateCronUpdateParams, false, [
      update({ schedule: { kind: "every", everyMs: invalidTimestamp } }),
      update({ schedule: { kind: "every", everyMs: 60_000, anchorMs: invalidTimestamp } }),
      update({ schedule: { kind: "cron", expr: "0 * * * *", staggerMs: invalidTimestamp } }),
    ]);
  });

  it("rejects mutable scheduler state outside the ECMAScript Date range", () => {
    const invalidTimestamp = MAX_DATE_TIMESTAMP_MS + 1;
    expectCases(validateCronUpdateParams, false, [
      update({ state: { nextRunAtMs: invalidTimestamp } }),
      update({ state: { runningAtMs: invalidTimestamp } }),
      update({ state: { lastRunAtMs: invalidTimestamp } }),
    ]);
    expectCases(validateCronUpdateParams, true, [
      update({ state: { nextRunAtMs: MAX_DATE_TIMESTAMP_MS } }),
    ]);
  });

  it("accepts trigger add, patch, and clear shapes", () => {
    expectCases(validateCronAddParams, true, [
      add({ trigger: { script: "json({ fire: true })", once: true } }),
    ]);
    expectCases(validateCronUpdateParams, true, [
      update({ trigger: { script: "json({ fire: false })" } }),
      update({ trigger: null }),
    ]);
  });

  it("accepts toolsAllow on systemEvent payloads", () => {
    const payload = {
      kind: "systemEvent",
      toolsAllow: ["read", "cron"],
      toolsAllowIsDefault: true,
    };
    expectCases(validateCronAddParams, true, [add({ payload: { ...payload, text: "tick" } })]);
    expectCases(validateCronUpdateParams, true, [update({ payload })]);
  });

  it("rejects invalid trigger scripts and additional properties", () => {
    const trigger = { script: "json({ fire: true })", unexpected: true };
    expectCases(validateCronAddParams, false, [add({ trigger: { script: "" } }), add({ trigger })]);
    expectCases(validateCronUpdateParams, false, [update({ trigger })]);
  });

  it("rejects public caller scope on cron admin params", () => {
    expectCases(validateCronListParams, false, [{ callerScope: agentToolCallerScope }]);
    expectCases(validateCronGetParams, false, [{ id: "job-1", callerScope: agentToolCallerScope }]);
    expectCases(validateCronAddParams, false, [add({ callerScope: agentToolCallerScope })]);
    expectCases(validateCronUpdateParams, false, [
      update({ enabled: false }, { callerScope: agentToolCallerScope }),
    ]);
    expectCases(validateCronRemoveParams, false, [
      {
        jobId: "job-1",
        callerScope: agentToolCallerScope,
      },
    ]);
    expectCases(validateCronRunParams, false, [{ id: "job-1", callerScope: agentToolCallerScope }]);
    expectCases(validateCronRunsParams, false, [
      { id: "job-1", callerScope: agentToolCallerScope },
    ]);
  });

  it("accepts current and custom session targets", () => {
    const payload = { kind: "agentTurn", message: "tick" };
    expectCases(validateCronAddParams, true, [
      add({ sessionTarget: "current", payload }),
      add({ sessionTarget: "session:project-alpha", payload }),
    ]);
    expectCases(validateCronUpdateParams, true, [
      update({ sessionTarget: "session:project-alpha" }),
    ]);
  });

  it("accepts command cron payloads", () => {
    expectCases(validateCronAddParams, true, [
      add({
        sessionTarget: "isolated",
        payload: {
          kind: "command",
          argv: ["sh", "-lc", "echo ok"],
          cwd: "/srv/example",
          env: { FOO: "bar" },
          input: "stdin",
          timeoutSeconds: 30,
          noOutputTimeoutSeconds: 5,
          outputMaxBytes: 4096,
        },
      }),
    ]);
    expectCases(validateCronUpdateParams, true, [
      update({ payload: { kind: "command", argv: ["sh", "-lc", "echo updated"] } }),
    ]);
  });

  it("rejects add params when required scheduling fields are missing", () => {
    const { wakeMode: _wakeMode, ...withoutWakeMode } = minimalAddParams;
    expectCases(validateCronAddParams, false, [withoutWakeMode]);
  });

  it("accepts update params for id and jobId selectors", () => {
    expectCases(validateCronUpdateParams, true, [
      update({ enabled: false }),
      {
        jobId: "job-2",
        patch: { enabled: true },
      },
    ]);
  });

  it("accepts only non-empty cron config revisions", () => {
    const patch = { enabled: false };
    expectCases(validateCronUpdateParams, true, [
      update(patch, { expectedConfigRevision: "sha256:current" }),
    ]);
    expectCases(validateCronUpdateParams, false, [
      update(patch, { expectedConfigRevision: "" }),
      update(patch, { expectedConfigRevision: 1 }),
      update(patch, { expectedConfigRevision: "x".repeat(129) }),
    ]);
  });

  it("accepts nullable model clears only on update payload patches", () => {
    expectCases(validateCronUpdateParams, true, [
      update({ payload: { kind: "agentTurn", model: null } }),
    ]);
    expectCases(validateCronAddParams, false, [
      add({ payload: { kind: "agentTurn", message: "tick", model: null } }),
    ]);
  });

  it("accepts get params for id and jobId selectors", () => {
    expectCases(validateCronGetParams, true, [{ id: "job-1" }, { jobId: "job-2" }]);
    expectCases(validateCronGetParams, false, [{}, { id: "" }]);
  });

  it("accepts delivery threadId on add and update params", () => {
    expectCases(validateCronAddParams, true, [
      add({ delivery: { mode: "announce", channel: "telegram", to: "-100123", threadId: 42 } }),
    ]);
    expectCases(validateCronUpdateParams, true, [
      update({
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "-100123",
          threadId: "topic-42",
        },
      }),
      update({ delivery: { threadId: 42 } }),
    ]);
  });

  it("accepts completion webhooks only alongside announce delivery", () => {
    const completionDestination = {
      mode: "webhook",
      to: "https://example.invalid/complete",
    } as const;
    expectCases(validateCronAddParams, true, [
      add({ delivery: { mode: "announce", completionDestination } }),
    ]);
    expectCases(validateCronAddParams, false, [
      add({ delivery: { mode: "none", completionDestination } }),
      add({ delivery: { mode: "webhook", to: "https://example.invalid", completionDestination } }),
      add({ delivery: { mode: "announce", completionDestination: null } }),
    ]);
    expectCases(validateCronUpdateParams, true, [
      update({ delivery: { completionDestination } }),
      update({ delivery: { completionDestination: null } }),
    ]);
    expectCases(validateCronUpdateParams, false, [
      update({ delivery: { completionDestination: {} } }),
      update({ delivery: { completionDestination: { mode: "announce", to: "https://x.test" } } }),
    ]);
  });

  it("accepts nullable delivery clears on update params", () => {
    expectCases(validateCronUpdateParams, true, [
      update({
        delivery: {
          channel: null,
          to: null,
          threadId: null,
          accountId: null,
          failureDestination: null,
        },
      }),
      update({
        delivery: { failureDestination: { channel: null, to: null, accountId: null, mode: null } },
      }),
    ]);
  });

  it("rejects blank cron delivery target strings", () => {
    expectCases(validateCronAddParams, false, [
      add({ delivery: { mode: "announce", channel: "telegram", to: "   " } }),
    ]);
    expectCases(validateCronUpdateParams, false, [
      update({ delivery: { channel: "\t" } }),
      update({ delivery: { failureDestination: { channel: null, to: " " } } }),
      update({ failureAlert: { channel: "last", to: "\n\t" } }),
    ]);
  });

  it("accepts remove params for id and jobId selectors", () => {
    expectCases(validateCronRemoveParams, true, [{ id: "job-1" }, { jobId: "job-2" }]);
  });

  it("accepts run params mode for id and jobId selectors", () => {
    expectCases(validateCronRunParams, true, [
      { id: "job-1", mode: "force", expectedProcessInstanceId: "process-1" },
      { jobId: "job-2", mode: "due" },
    ]);
    expectCases(validateCronRunParams, false, [{ id: "job-1", expectedProcessInstanceId: "" }]);
  });

  it("accepts list paging/filter/sort params", () => {
    expectCases(validateCronListParams, true, [
      {
        includeDisabled: true,
        limit: 50,
        offset: 0,
        query: "daily",
        enabled: "all",
        scheduleKind: "cron",
        lastRunStatus: "unknown",
        sortBy: "nextRunAtMs",
        sortDir: "asc",
        agentId: "ops",
        compact: true,
        includeDeliveryPreviews: false,
      },
    ]);
    expectCases(validateCronListParams, false, [
      { offset: -1 },
      { agentId: "" },
      { scheduleKind: "yearly" },
      { lastRunStatus: "pending" },
    ]);
  });

  it("enforces runs limit minimum for id and jobId selectors", () => {
    expectCases(validateCronRunsParams, true, [
      { id: "job-1", limit: 1 },
      { jobId: "job-2", limit: 1 },
    ]);
    expectCases(validateCronRunsParams, false, [
      { id: "job-1", limit: 0 },
      { jobId: "job-2", limit: 0 },
    ]);
  });

  it("rejects cron.runs path traversal ids", () => {
    expectCases(validateCronRunsParams, false, [
      { id: "../job-1" },
      { id: "nested/job-1" },
      { jobId: "..\\job-2" },
      { jobId: "nested\\job-2" },
    ]);
  });

  it("accepts runs paging/filter/sort params", () => {
    expectCases(validateCronRunsParams, true, [
      {
        id: "job-1",
        runId: "manual:job-1:123:0",
        limit: 50,
        offset: 0,
        status: "error",
        query: "timeout",
        sortDir: "desc",
      },
    ]);
    expectCases(validateCronRunsParams, false, [
      { id: "job-1", offset: -1 },
      { id: "job-1", runId: "" },
    ]);
  });

  it("accepts all-scope runs with multi-select filters", () => {
    expectCases(validateCronRunsParams, true, [
      {
        scope: "all",
        agentId: "ops",
        limit: 25,
        statuses: ["ok", "error"],
        deliveryStatuses: ["delivered", "not-requested"],
        query: "fail",
        sortDir: "desc",
      },
    ]);
    expectCases(validateCronRunsParams, false, [
      { scope: "all", agentId: "" },
      { scope: "job", statuses: [] },
    ]);
  });
});
