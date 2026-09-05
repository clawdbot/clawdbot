import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UPDATE_RUN_PHASES } from "../../packages/gateway-protocol/src/update-run-vocabulary.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { assertSqliteSchemaContains } from "./sqlite-schema-contract.js";
import {
  createUpdateRun,
  findActiveUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunPhase,
  recordUpdateRunRepairAttempt,
  recordUpdateRunStep,
  recordUpdateRunVerification,
} from "./update-run-ledger.js";
import { UpdateRunRecordSchema, type UpdateRunRecord } from "./update-run-record.js";

const tempDirs = createTempDirTracker();

function isolatedOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-update-ledger-") } };
}

afterEach(() => {
  vi.restoreAllMocks();
  closeOpenClawStateDatabaseForTest();
  tempDirs.cleanup();
});

describe("update run ledger", () => {
  it("keeps reads non-creating and adds the table on first write without changing the older schema", () => {
    const options = isolatedOptions();
    const runId = randomUUID();
    const filename = resolveOpenClawStateSqlitePath(options.env);
    expect(getUpdateRun(runId, options)).toBeUndefined();
    expect(listUpdateRuns({}, options)).toEqual([]);
    expect(findActiveUpdateRun(options)).toBeUndefined();
    expect(fs.existsSync(filename)).toBe(false);

    const initial = openOpenClawStateDatabase(options);
    const hasLedger = () =>
      initial.db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'update_runs'").get();
    expect(hasLedger()).toBeUndefined();
    const version = initial.db.prepare("PRAGMA user_version").get();
    const metadata = initial.db.prepare("SELECT * FROM schema_meta").all();
    const previousSchema = initial.db
      .prepare(
        "SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY rowid",
      )
      .all()
      .map((row) => row.sql)
      .join(";\n");
    expect(listUpdateRuns({}, options)).toEqual([]);
    expect(hasLedger()).toBeUndefined();
    expect(() => recordUpdateRunPhase(runId, "staging", {}, options)).toThrow("Unknown update run");
    expect(hasLedger()).toBeUndefined();

    const created = createUpdateRun({ runId, trigger: "cli" }, options);
    expect(created).toMatchObject({ runId, phase: "requested", status: "running" });
    closeOpenClawStateDatabaseForTest();
    const olderReader = new DatabaseSync(filename);
    try {
      assertSqliteSchemaContains(olderReader, filename, previousSchema);
      olderReader.prepare("UPDATE schema_meta SET updated_at = updated_at").run();
      expect(olderReader.prepare("PRAGMA user_version").get()).toEqual(version);
      expect(olderReader.prepare("SELECT * FROM schema_meta").all()).toEqual(metadata);
    } finally {
      olderReader.close();
    }
    expect(getUpdateRun(runId, options)).toEqual(created);
    expect(createUpdateRun({ runId, trigger: "api" }, options)).toEqual(created);
    expect(listUpdateRuns({}, options)).toEqual([created]);
  });

  it("keeps phase order and merges repeated steps while preserving terminal outcomes and later boot facts", () => {
    const options = isolatedOptions();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const run = createUpdateRun(
      {
        trigger: "chat",
        origin: { sessionKey: "agent:main:update" },
        before: { version: "2026.9.1" },
      },
      options,
    );
    clock.mockReturnValue(2_000);
    recordUpdateRunPhase(run.runId, "staging", { target: { kind: "git", sha: "abcdef" } }, options);
    recordUpdateRunStep(
      run.runId,
      { step: "fetch", status: "in_progress", startedAtMs: 2_100 },
      options,
    );
    clock.mockReturnValue(3_000);
    recordUpdateRunPhase(
      run.runId,
      "validating",
      {
        step: { step: "fetch", status: "completed", endedAtMs: 2_900 },
      },
      options,
    );
    recordUpdateRunPhase(run.runId, "requested", { origin: { campaignId: "campaign-1" } }, options);
    const current = getUpdateRun(run.runId, options);
    expect(current).toMatchObject({
      phase: "validating",
      target: { kind: "git", sha: "abcdef" },
      origin: { sessionKey: "agent:main:update", campaignId: "campaign-1" },
    });
    expect(current?.steps).toEqual([
      { step: "requested", status: "completed", startedAtMs: 1_000, endedAtMs: 2_000 },
      { step: "staging", status: "completed", startedAtMs: 2_000, endedAtMs: 3_000 },
      { step: "fetch", status: "completed", startedAtMs: 2_100, endedAtMs: 2_900 },
      { step: "validating", status: "in_progress", startedAtMs: 3_000 },
    ]);
    clock.mockReturnValue(4_000);
    const terminal = finishUpdateRun(
      run.runId,
      {
        status: "failed",
        reason: "doctor-failed",
        after: { version: "2026.9.3" },
        downtimeMs: 400,
      },
      options,
    );
    expect(terminal).toMatchObject({
      phase: "finished",
      status: "failed",
      finishedAtMs: 4_000,
      downtimeMs: 400,
    });
    expect(finishUpdateRun(run.runId, { status: "succeeded" }, options)).toEqual(terminal);
    expect(recordUpdateRunPhase(run.runId, "staging", {}, options)).toEqual(terminal);
    expect(recordUpdateRunStep(run.runId, { step: "late", status: "completed" }, options)).toEqual(
      terminal,
    );
    expect(
      recordUpdateRunRepairAttempt(
        run.runId,
        { attempt: 1, status: "succeeded", startedAtMs: 4_000 },
        options,
      ),
    ).toEqual(terminal);
    expect(
      recordUpdateRunVerification(run.runId, { serviceRunning: true }, options).confirmedAtMs,
    ).toBeNull();
    clock.mockReturnValue(5_000);
    const booted = recordUpdateRunVerification(
      run.runId,
      { booted: true, versionMatch: true },
      options,
    );
    expect(booted).toMatchObject({
      status: "failed",
      reason: "doctor-failed",
      finishedAtMs: 4_000,
      confirmedAtMs: 5_000,
      verification: { booted: true, serviceRunning: true, versionMatch: true },
    });
    clock.mockReturnValue(6_000);
    expect(
      recordUpdateRunVerification(run.runId, { noticeDelivered: true }, options).confirmedAtMs,
    ).toBe(5_000);
  });

  it("lists newest runs deterministically and excludes terminal runs from active discovery", () => {
    const options = isolatedOptions();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const oldest = createUpdateRun({ trigger: "cli" }, options);
    clock.mockReturnValue(2_000);
    const tied = [
      createUpdateRun({ trigger: "api" }, options),
      createUpdateRun({ trigger: "campaign" }, options),
    ].toSorted((left, right) => right.runId.localeCompare(left.runId));
    expect(listUpdateRuns({ limit: 2 }, options).map((run) => run.runId)).toEqual(
      tied.map((run) => run.runId),
    );
    expect(findActiveUpdateRun(options)).toEqual(tied[0]);
    for (const run of tied) {
      finishUpdateRun(run.runId, { status: "skipped", reason: "dry-run" }, options);
    }
    expect(listUpdateRuns({ active: true }, options)).toEqual([oldest]);
    finishUpdateRun(oldest.runId, { status: "succeeded" }, options);
    expect(findActiveUpdateRun(options)).toBeUndefined();
    expect(listUpdateRuns({}, options)).toHaveLength(3);
  });

  it("bounds every JSON column deterministically without splitting Unicode or losing the phase timeline", () => {
    const options = isolatedOptions();
    const large = "🦞".repeat(512);
    const origin = {
      requester: { channel: large, senderId: large },
      sessionKey: large,
      deliveryContext: { channel: large, to: large, accountId: large, threadId: large },
      campaignId: large,
      doctorHint: large,
      nextAction: large,
    };
    const run = createUpdateRun({ trigger: "cli", origin }, options);
    const repeated = createUpdateRun(
      { trigger: "cli", origin: { ...origin, requester: { senderId: large, channel: large } } },
      options,
    );
    expect(run.origin).toEqual(repeated.origin);
    recordUpdateRunPhase(run.runId, "staging", {}, options);
    for (let index = 0; index < 140; index += 1) {
      recordUpdateRunStep(
        run.runId,
        { step: `build-${index}`, status: "failed", detail: large },
        options,
      );
    }
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      recordUpdateRunRepairAttempt(
        run.runId,
        { attempt, status: "failed", startedAtMs: attempt, summary: large },
        options,
      );
    }
    recordUpdateRunRepairAttempt(
      run.runId,
      { attempt: 20, status: "succeeded", startedAtMs: 20 },
      options,
    );
    recordUpdateRunVerification(
      run.runId,
      { pluginErrors: Array.from({ length: 40 }, (_, index) => `${index}: ${large}`) },
      options,
    );
    const persisted = getUpdateRun(run.runId, options);
    expect(persisted?.steps.slice(0, 2).map((step) => step.step)).toEqual(["requested", "staging"]);
    expect(persisted?.steps.at(-1)?.step).toBe("build-139");
    expect(persisted?.repair.filter((attempt) => attempt.attempt === 20)).toEqual([
      { attempt: 20, status: "succeeded", startedAtMs: 20 },
    ]);
    expect(persisted?.verification.pluginErrors?.at(-1)).toContain("39:");
    const { db } = openOpenClawStateDatabase(options);
    const row = db.prepare("SELECT * FROM update_runs WHERE run_id = ?").get(run.runId);
    const columns = Object.entries(row ?? {}).filter(([key]) => key.endsWith("_json"));
    expect(columns).toHaveLength(7);
    for (const [column, value] of columns) {
      expect(typeof value, column).toBe("string");
      if (typeof value !== "string") {
        throw new Error(`Expected JSON in ${column}`);
      }
      expect(Buffer.byteLength(value), column).toBeLessThanOrEqual(16 * 1024);
      expect(() => JSON.parse(value), column).not.toThrow();
      expect(value, column).not.toMatch(/\\u[dD][89a-fA-F][0-9a-fA-F]{2}/u);
    }
    recordUpdateRunStep(
      run.runId,
      { step: "unicode", status: "completed", detail: `${"x".repeat(1_023)}🦞tail` },
      options,
    );
    expect(getUpdateRun(run.runId, options)?.steps.at(-1)?.detail).toBe("x".repeat(1_023));
  });

  it("preserves every phase and its timestamps when multibyte details exceed the JSON budget", () => {
    const options = isolatedOptions();
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const run = createUpdateRun({ trigger: "cli" }, options);
    const phases = UPDATE_RUN_PHASES.filter((phase) => phase !== "finished");
    for (const [index, phase] of phases.entries()) {
      clock.mockReturnValue(1_000 + index * 100);
      recordUpdateRunPhase(
        run.runId,
        phase,
        { step: { step: phase, status: "in_progress", detail: "界".repeat(1_024) } },
        options,
      );
    }
    clock.mockReturnValue(2_000);
    finishUpdateRun(run.runId, { status: "failed", reason: "restart-unhealthy" }, options);
    const persisted = getUpdateRun(run.runId, options)!;
    expect(persisted.steps.map(({ step }) => step)).toEqual(phases);
    expect(persisted.steps.map(({ startedAtMs }) => startedAtMs)).toEqual(
      phases.map((_, index) => 1_000 + index * 100),
    );
    expect(persisted.steps.map(({ endedAtMs }) => endedAtMs)).toEqual(
      phases.map((_, index) => (index === phases.length - 1 ? 2_000 : 1_100 + index * 100)),
    );
    expect(persisted.steps.at(-1)?.status).toBe("failed");
    expect(Buffer.byteLength(JSON.stringify(persisted.steps))).toBeLessThanOrEqual(16 * 1024);
  });

  it("persists safe diagnostic summaries while dropping raw logs, secrets, and private absolute paths", () => {
    const options = {
      env: {
        ...isolatedOptions().env,
        HOME: "/Users/example",
        USERPROFILE: "C:\\Users\\example",
      },
    };
    const run = createUpdateRun({ trigger: "cli" }, options);
    const detail =
      "doctor failed in /Users/example/private/config.json and C:\\Users\\example\\private.json with token=synthetic-test-token";
    const step = {
      step: "doctor",
      status: "failed" as const,
      detail,
      stdout: "RAW_LOG_MUST_NOT_PERSIST",
    };
    recordUpdateRunStep(run.runId, step, options);
    const persisted = getUpdateRun(run.runId, options);
    const serialized = JSON.stringify(persisted);
    expect(serialized).toContain("doctor failed");
    for (const privateValue of [
      "/Users/example",
      "Users\\\\example",
      "synthetic-test-token",
      "RAW_LOG_MUST_NOT_PERSIST",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(persisted?.steps.at(-1)?.detail).toContain("~/private/config.json");
  });

  it("preserves model refs, slash commands, URLs, and usable home-relative recovery selectors", () => {
    const options = {
      env: { ...isolatedOptions().env, HOME: "/home/operator" },
      redactPaths: ["/opt/openclaw-candidate", "\\\\host\\share"],
    };
    const run = createUpdateRun(
      {
        trigger: "cli",
        origin: {
          nextAction: "Run openclaw update cleanup --dry-run for state /home/operator/.openclaw.",
        },
      },
      options,
    );
    const summary = `openai/gpt-5.6-luna: use /update; see https://docs.openclaw.ai/cli/update, http://host/share/x and https://host/share/x. Read config:${options.env.OPENCLAW_STATE_DIR}/state/openclaw.sqlite and file:///home/operator/module.js and /opt/openclaw-candidate/config.json and \\\\host\\share\\x; token=synthetic-test-token`;
    recordUpdateRunRepairAttempt(
      run.runId,
      { attempt: 1, status: "failed", startedAtMs: 1, summary },
      options,
    );
    const persisted = getUpdateRun(run.runId, options)!;
    expect(persisted.origin.nextAction).toContain("~/.openclaw");
    expect(persisted.repair[0]?.summary).toContain("openai/gpt-5.6-luna: use /update");
    expect(persisted.repair[0]?.summary).toContain("https://docs.openclaw.ai/cli/update");
    expect(persisted.repair[0]?.summary).toContain("http://host/share/x");
    expect(persisted.repair[0]?.summary).toContain("https://host/share/x");
    expect(persisted.repair[0]?.summary).not.toContain("\\\\host\\share");
    for (const privateValue of [
      "/home/operator",
      options.env.OPENCLAW_STATE_DIR,
      "/opt/openclaw-candidate",
      "synthetic-test-token",
    ]) {
      expect(JSON.stringify(persisted)).not.toContain(privateValue);
    }
  });

  it("rejects invalid public record identities and vocabulary before writing", () => {
    const options = isolatedOptions();
    expect(() => createUpdateRun({ runId: "not-a-uuid", trigger: "cli" }, options)).toThrow();
    expect(listUpdateRuns({}, options)).toEqual([]);
    const valid = createUpdateRun({ trigger: "cli" }, options);
    for (const patch of [
      { phase: "installing" },
      { status: "ok" },
      { trigger: "unknown" },
      { downtimeMs: -1 },
    ]) {
      expect(UpdateRunRecordSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
    }
  });

  it("merges independent CLI and gateway process writes into the same WAL run", async () => {
    const options = isolatedOptions();
    const run = createUpdateRun({ trigger: "cli" }, options);
    const database = openOpenClawStateDatabase(options);
    expect(database.db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    const children = ["cli", "gateway"].map((role) => {
      const child = fork(
        new URL("./update-run-ledger.process.test-support.ts", import.meta.url),
        [run.runId, role],
        {
          execArgv: ["--import", "tsx"],
          env: { ...process.env, ...options.env },
          stdio: ["ignore", "pipe", "pipe", "ipc"],
        },
      );
      let output = "";
      child.stdout?.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr?.on("data", (chunk) => {
        output += chunk;
      });
      const ready = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) =>
          reject(new Error(`${role} exited before readiness (${code}): ${output}`)),
        );
        child.once("message", (message) =>
          message === "ready" ? resolve() : reject(new Error(`Unexpected ${role} message`)),
        );
      });
      const exited = new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(`${role} exited ${code}: ${output}`)),
        );
      });
      return { child, ready, exited };
    });
    const deadline = setTimeout(() => {
      for (const { child } of children) {
        child.kill();
      }
    }, 20_000);
    try {
      await Promise.all(children.map(({ ready }) => ready));
      for (const { child } of children) {
        child.send("start");
      }
      await Promise.all(children.map(({ exited }) => exited));
      const persisted = getUpdateRun(run.runId, options);
      const expected = ["cli", "gateway"].flatMap((role) =>
        Array.from({ length: 16 }, (_, index) => `${role}-${index}`),
      );
      expect(
        persisted?.steps
          .filter((step) => expected.includes(step.step))
          .map((step) => step.step)
          .toSorted(),
      ).toEqual(expected.toSorted());
      expect(persisted).toMatchObject({
        phase: "verifying",
        after: { version: "2026.9.3" },
        verification: {
          booted: true,
          serviceRunning: true,
          versionMatch: true,
          channelsReady: true,
        },
      } satisfies Partial<UpdateRunRecord>);
      expect(persisted?.confirmedAtMs).toEqual(expect.any(Number));
    } finally {
      clearTimeout(deadline);
      for (const { child } of children) {
        if (child.exitCode === null) {
          child.kill();
        }
      }
      await Promise.allSettled(children.map(({ exited }) => exited));
    }
  }, 30_000);
});
