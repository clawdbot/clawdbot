// Gateway Protocol tests cover cron validators behavior.
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

/**
 * Cron validator regressions for public scheduler RPC payloads.
 *
 * The cases cover both canonical `id` selectors and legacy `jobId` aliases,
 * delivery routing, update clears, and run-log path traversal guards.
 */

/** Smallest valid cron job create payload shared by add/update variations. */
const minimalAddParams = {
  name: "daily-summary",
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
  payload: { kind: "systemEvent", text: "tick" },
} as const;

const agentToolCallerScope = {
  kind: "agentTool",
  agentId: "ops",
} as const;

describe("cron protocol validators", () => {
  it("accepts minimal add params", () => {
    expect(validateCronAddParams(minimalAddParams)).toBe(true);
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

    expect(validateCronUpdateParams({ id: "job-1", patch: { failureAlert } })).toBe(true);
    expect(validateCronAddParams({ ...minimalAddParams, failureAlert })).toBe(false);
    expect(validateCronUpdateParams({ id: "job-1", patch: { failureAlert: null } })).toBe(true);
    expect(validateCronAddParams({ ...minimalAddParams, failureAlert: null })).toBe(false);
  });

  it("rejects schedule integers that SQLite cannot round-trip safely", () => {
    const unsafe = Number.MAX_SAFE_INTEGER + 1;
    expect(
      validateCronAddParams({
        ...minimalAddParams,
        schedule: { kind: "every", everyMs: unsafe },
      }),
    ).toBe(false);
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: { schedule: { kind: "every", everyMs: 60_000, anchorMs: unsafe } },
      }),
    ).toBe(false);
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: { schedule: { kind: "cron", expr: "0 * * * *", staggerMs: unsafe } },
      }),
    ).toBe(false);
  });

  it("accepts trigger add, patch, and clear shapes", () => {
    expect(
      validateCronAddParams({
        ...minimalAddParams,
        trigger: { script: "json({ fire: true })", once: true },
      }),
    ).toBe(true);
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: { trigger: { script: "json({ fire: false })" } },
      }),
    ).toBe(true);
    expect(validateCronUpdateParams({ id: "job-1", patch: { trigger: null } })).toBe(true);
  });

  it("accepts toolsAllow on systemEvent payloads", () => {
    expect(
      validateCronAddParams({
        ...minimalAddParams,
        payload: {
          kind: "systemEvent",
          text: "tick",
          toolsAllow: ["read", "cron"],
          toolsAllowIsDefault: true,
        },
      }),
    ).toBe(true);
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: {
          payload: {
            kind: "systemEvent",
            toolsAllow: ["read", "cron"],
            toolsAllowIsDefault: true,
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects invalid trigger scripts and additional properties", () => {
    expect(validateCronAddParams({ ...minimalAddParams, trigger: { script: "" } })).toBe(false);
    expect(
      validateCronAddParams({
        ...minimalAddParams,
        trigger: { script: "json({ fire: true })", unexpected: true },
      }),
    ).toBe(false);
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: { trigger: { script: "json({ fire: true })", unexpected: true } },
      }),
    ).toBe(false);
  });

  it("rejects public caller scope on cron admin params", () => {
    expect(validateCronListParams({ callerScope: agentToolCallerScope })).toBe(false);
    expect(validateCronGetParams({ id: "job-1", callerScope: agentToolCallerScope })).toBe(false);
    expect(validateCronAddParams({ ...minimalAddParams, callerScope: agentToolCallerScope })).toBe(
      false,
    );
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: { enabled: false },
        callerScope: agentToolCallerScope,
      }),
    ).toBe(false);
    expect(validateCronRemoveParams({ jobId: "job-1", callerScope: agentToolCallerScope })).toBe(
      false,
    );
    expect(validateCronRunParams({ id: "job-1", callerScope: agentToolCallerScope })).toBe(false);
    expect(validateCronRunsParams({ id: "job-1", callerScope: agentToolCallerScope })).toBe(false);
  });

  it("accepts current and custom session targets", () => {
    expect(
      validateCronAddParams({
        ...minimalAddParams,
        sessionTarget: "current",
        payload: { kind: "agentTurn", message: "tick" },
      }),
    ).toBe(true);
    expect(
      validateCronAddParams({
        ...minimalAddParams,
        sessionTarget: "session:project-alpha",
        payload: { kind: "agentTurn", message: "tick" },
      }),
    ).toBe(true);
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: { sessionTarget: "session:project-alpha" },
      }),
    ).toBe(true);
  });

  it("accepts command cron payloads", () => {
    expect(
      validateCronAddParams({
        ...minimalAddParams,
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
    ).toBe(true);
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: {
          payload: {
            kind: "command",
            argv: ["sh", "-lc", "echo updated"],
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects add params when required scheduling fields are missing", () => {
    const { wakeMode: _wakeMode, ...withoutWakeMode } = minimalAddParams;
    expect(validateCronAddParams(withoutWakeMode)).toBe(false);
  });

  it("accepts update params for id and jobId selectors", () => {
    expect(validateCronUpdateParams({ id: "job-1", patch: { enabled: false } })).toBe(true);
    expect(validateCronUpdateParams({ jobId: "job-2", patch: { enabled: true } })).toBe(true);
  });

  it("accepts only non-empty cron config revisions", () => {
    expect(
      validateCronUpdateParams({
        id: "job-1",
        expectedConfigRevision: "sha256:current",
        patch: { enabled: false },
      }),
    ).toBe(true);
    expect(
      validateCronUpdateParams({
        id: "job-1",
        expectedConfigRevision: "",
        patch: { enabled: false },
      }),
    ).toBe(false);
    expect(
      validateCronUpdateParams({
        id: "job-1",
        expectedConfigRevision: 1,
        patch: { enabled: false },
      }),
    ).toBe(false);
    expect(
      validateCronUpdateParams({
        id: "job-1",
        expectedConfigRevision: "x".repeat(129),
        patch: { enabled: false },
      }),
    ).toBe(false);
  });

  it("accepts nullable model clears only on update payload patches", () => {
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: {
          payload: {
            kind: "agentTurn",
            model: null,
          },
        },
      }),
    ).toBe(true);
    expect(
      validateCronAddParams({
        ...minimalAddParams,
        payload: {
          kind: "agentTurn",
          message: "tick",
          model: null,
        },
      }),
    ).toBe(false);
  });

  it("accepts get params for id and jobId selectors", () => {
    expect(validateCronGetParams({ id: "job-1" })).toBe(true);
    expect(validateCronGetParams({ jobId: "job-2" })).toBe(true);
    expect(validateCronGetParams({})).toBe(false);
    expect(validateCronGetParams({ id: "" })).toBe(false);
  });

  it("accepts delivery threadId on add and update params", () => {
    expect(
      validateCronAddParams({
        ...minimalAddParams,
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "-100123",
          threadId: 42,
        },
      }),
    ).toBe(true);
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: {
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "-100123",
            threadId: "topic-42",
          },
        },
      }),
    ).toBe(true);
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: {
          delivery: {
            threadId: 42,
          },
        },
      }),
    ).toBe(true);
  });

  it("accepts nullable delivery clears on update params", () => {
    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: {
          delivery: {
            channel: null,
            to: null,
            threadId: null,
            accountId: null,
            failureDestination: null,
          },
        },
      }),
    ).toBe(true);

    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: {
          delivery: {
            failureDestination: {
              channel: null,
              to: null,
              accountId: null,
              mode: null,
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("rejects blank cron delivery target strings", () => {
    expect(
      validateCronAddParams({
        ...minimalAddParams,
        delivery: {
          mode: "announce",
          channel: "telegram",
          to: "   ",
        },
      }),
    ).toBe(false);

    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: {
          delivery: {
            channel: "\t",
          },
        },
      }),
    ).toBe(false);

    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: {
          delivery: {
            failureDestination: {
              channel: null,
              to: " ",
            },
          },
        },
      }),
    ).toBe(false);

    expect(
      validateCronUpdateParams({
        id: "job-1",
        patch: {
          failureAlert: {
            channel: "last",
            to: "\n\t",
          },
        },
      }),
    ).toBe(false);
  });

  it("accepts remove params for id and jobId selectors", () => {
    expect(validateCronRemoveParams({ id: "job-1" })).toBe(true);
    expect(validateCronRemoveParams({ jobId: "job-2" })).toBe(true);
  });

  it("accepts run params mode for id and jobId selectors", () => {
    expect(
      validateCronRunParams({
        id: "job-1",
        mode: "force",
        expectedProcessInstanceId: "process-1",
      }),
    ).toBe(true);
    expect(validateCronRunParams({ jobId: "job-2", mode: "due" })).toBe(true);
    expect(validateCronRunParams({ id: "job-1", expectedProcessInstanceId: "" })).toBe(false);
  });

  it("accepts list paging/filter/sort params", () => {
    expect(
      validateCronListParams({
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
      }),
    ).toBe(true);
    expect(validateCronListParams({ offset: -1 })).toBe(false);
    expect(validateCronListParams({ agentId: "" })).toBe(false);
    expect(validateCronListParams({ scheduleKind: "yearly" })).toBe(false);
    expect(validateCronListParams({ lastRunStatus: "pending" })).toBe(false);
  });

  it("enforces runs limit minimum for id and jobId selectors", () => {
    expect(validateCronRunsParams({ id: "job-1", limit: 1 })).toBe(true);
    expect(validateCronRunsParams({ jobId: "job-2", limit: 1 })).toBe(true);
    expect(validateCronRunsParams({ id: "job-1", limit: 0 })).toBe(false);
    expect(validateCronRunsParams({ jobId: "job-2", limit: 0 })).toBe(false);
  });

  it("rejects cron.runs path traversal ids", () => {
    expect(validateCronRunsParams({ id: "../job-1" })).toBe(false);
    expect(validateCronRunsParams({ id: "nested/job-1" })).toBe(false);
    expect(validateCronRunsParams({ jobId: "..\\job-2" })).toBe(false);
    expect(validateCronRunsParams({ jobId: "nested\\job-2" })).toBe(false);
  });

  it("accepts runs paging/filter/sort params", () => {
    expect(
      validateCronRunsParams({
        id: "job-1",
        runId: "manual:job-1:123:0",
        limit: 50,
        offset: 0,
        status: "error",
        query: "timeout",
        sortDir: "desc",
      }),
    ).toBe(true);
    expect(validateCronRunsParams({ id: "job-1", offset: -1 })).toBe(false);
    expect(validateCronRunsParams({ id: "job-1", runId: "" })).toBe(false);
  });

  it("accepts all-scope runs with multi-select filters", () => {
    expect(
      validateCronRunsParams({
        scope: "all",
        agentId: "ops",
        limit: 25,
        statuses: ["ok", "error"],
        deliveryStatuses: ["delivered", "not-requested"],
        query: "fail",
        sortDir: "desc",
      }),
    ).toBe(true);
    expect(validateCronRunsParams({ scope: "all", agentId: "" })).toBe(false);
    expect(
      validateCronRunsParams({
        scope: "job",
        statuses: [],
      }),
    ).toBe(false);
  });
});
