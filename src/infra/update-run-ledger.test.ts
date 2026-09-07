import { fork } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
import type { UpdateRunRecord } from "./update-run-record.js";
import { UpdateRunRecordSchema } from "./update-run-schema.js";

const tempDirs = createTempDirTracker();

function isolatedOptions() {
  return { env: { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-update-ledger-") } };
}

function snapshotDatabaseFiles(filename: string) {
  const metadata = (pathname: string) => {
    const stat = fs.lstatSync(pathname, { bigint: true });
    return {
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode,
      uid: stat.uid,
      gid: stat.gid,
      size: stat.size,
      mtimeNs: stat.mtimeNs,
      ctimeNs: stat.ctimeNs,
    };
  };
  const directory = path.dirname(filename);
  return {
    directory: metadata(directory),
    entries: fs.readdirSync(directory).toSorted(),
    files: ["", "-wal", "-shm", "-journal"].map((suffix) => {
      const pathname = `${filename}${suffix}`;
      return fs.existsSync(pathname)
        ? {
            suffix,
            metadata: metadata(pathname),
            sha256: createHash("sha256").update(fs.readFileSync(pathname)).digest("hex"),
          }
        : { suffix, absent: true };
    }),
  };
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
    expect(fs.readdirSync(options.env.OPENCLAW_STATE_DIR)).toEqual([]);

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

  it.each(
    (["get", "list", "active"] as const).flatMap((reader) =>
      [false, true].map((retainedWal) => ({ reader, retainedWal })),
    ),
  )(
    "keeps cold $reader reads artifact-preserving with retained WAL=$retainedWal",
    ({ reader, retainedWal }) => {
      const sourceOptions = isolatedOptions();
      const created = createUpdateRun({ trigger: "cli" }, sourceOptions);
      const sourcePath = resolveOpenClawStateSqlitePath(sourceOptions.env);
      let options = sourceOptions;
      let expected = created;
      if (retainedWal) {
        const { db } = openOpenClawStateDatabase(sourceOptions);
        db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        expected = recordUpdateRunPhase(created.runId, "staging", {}, sourceOptions);
        options = isolatedOptions();
        const filename = resolveOpenClawStateSqlitePath(options.env);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        // Capture committed WAL bytes while the only producer is idle, then close
        // it before observing the copy. Omitting WAL must not return stale history.
        fs.copyFileSync(sourcePath, filename);
        fs.copyFileSync(`${sourcePath}-wal`, `${filename}-wal`);
        const mainOnly = path.join(tempDirs.make("openclaw-update-main-only-"), "main.sqlite");
        fs.copyFileSync(sourcePath, mainOnly);
        const control = new DatabaseSync(mainOnly, { readOnly: true });
        try {
          expect(
            control.prepare("SELECT phase FROM update_runs WHERE run_id = ?").get(created.runId),
          ).toEqual({ phase: "requested" });
        } finally {
          control.close();
        }
      }
      closeOpenClawStateDatabaseForTest();
      const filename = resolveOpenClawStateSqlitePath(options.env);
      expect(fs.existsSync(`${filename}-shm`)).toBe(false);
      expect(fs.existsSync(`${filename}-wal`)).toBe(retainedWal);
      const before = snapshotDatabaseFiles(filename);
      const result =
        reader === "get"
          ? getUpdateRun(created.runId, options)
          : reader === "list"
            ? listUpdateRuns({}, options)
            : findActiveUpdateRun(options);
      expect(result).toEqual(reader === "list" ? [expected] : expected);
      expect(snapshotDatabaseFiles(filename)).toEqual(before);
    },
  );

  it("leaves a cold store without the history table unchanged", () => {
    const options = isolatedOptions();
    const { db } = openOpenClawStateDatabase(options);
    expect(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'update_runs'").get(),
    ).toBeUndefined();
    closeOpenClawStateDatabaseForTest();
    const filename = resolveOpenClawStateSqlitePath(options.env);
    const before = snapshotDatabaseFiles(filename);
    expect(getUpdateRun(randomUUID(), options)).toBeUndefined();
    expect(listUpdateRuns({}, options)).toEqual([]);
    expect(findActiveUpdateRun(options)).toBeUndefined();
    expect(snapshotDatabaseFiles(filename)).toEqual(before);
  });

  it("keeps the idle cached writer usable after history reads", () => {
    const options = isolatedOptions();
    const created = createUpdateRun({ trigger: "cli" }, options);
    const { db } = openOpenClawStateDatabase(options);
    const filename = resolveOpenClawStateSqlitePath(options.env);
    const before = snapshotDatabaseFiles(filename);
    expect(getUpdateRun(created.runId, options)).toEqual(created);
    expect(listUpdateRuns({}, options)).toEqual([created]);
    expect(findActiveUpdateRun(options)).toEqual(created);
    expect(snapshotDatabaseFiles(filename)).toEqual(before);
    expect(db.isOpen).toBe(true);
    expect(recordUpdateRunPhase(created.runId, "staging", {}, options).phase).toBe("staging");
  });

  it("reads committed history without consuming the cached writer's transaction", () => {
    const options = isolatedOptions();
    const created = createUpdateRun({ trigger: "cli" }, options);
    const { db } = openOpenClawStateDatabase(options);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE update_runs SET phase = 'staging' WHERE run_id = ?").run(created.runId);
      expect(getUpdateRun(created.runId, options)).toEqual(created);
      expect(listUpdateRuns({}, options)).toEqual([created]);
      expect(findActiveUpdateRun(options)).toEqual(created);
      expect(db.isTransaction).toBe(true);
      expect(
        db.prepare("SELECT phase FROM update_runs WHERE run_id = ?").get(created.runId),
      ).toEqual({
        phase: "staging",
      });
      db.exec("COMMIT");
    } finally {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }
    }
    expect(getUpdateRun(created.runId, options)?.phase).toBe("staging");
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
    expect(booted.confirmedAtMs).toBeNull();
    const verified = recordUpdateRunVerification(
      run.runId,
      {
        readyz: true,
        settled: true,
        channelsReady: true,
        pluginErrors: [],
        inferenceProbe: "unavailable",
      },
      options,
    );
    expect(verified).toMatchObject({
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

  it.each([
    ["failed", "failed"],
    ["succeeded", "completed"],
    ["skipped", "skipped"],
    ["rolled-back", "completed"],
  ] as const)(
    "closes unfinished steps when the run becomes %s without changing recorded outcomes",
    (status, stepStatus) => {
      const options = isolatedOptions();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const run = createUpdateRun({ trigger: "cli" }, options);
      recordUpdateRunPhase(run.runId, "validating", {}, options);
      const recordedSteps = [
        { step: "install", status: "completed", endedAtMs: 1_000 },
        { step: "validation attempt", status: "failed", endedAtMs: 1_000, detail: "Build failed." },
        { step: "optional check", status: "skipped", endedAtMs: 1_000 },
      ] as const;
      for (const step of recordedSteps) {
        recordUpdateRunStep(run.runId, step, options);
      }
      recordUpdateRunStep(
        run.runId,
        {
          step: "openclaw doctor",
          status: "in_progress",
          startedAtMs: 1_000,
        },
        options,
      );
      clock.mockReturnValue(2_000);
      finishUpdateRun(run.runId, { status }, options);
      closeOpenClawStateDatabaseForTest();

      const persisted = getUpdateRun(run.runId, options);
      expect(persisted?.steps.some((step) => step.status === "in_progress")).toBe(false);
      expect(persisted?.steps.find((step) => step.step === "openclaw doctor")).toEqual({
        step: "openclaw doctor",
        status: stepStatus,
        startedAtMs: 1_000,
        endedAtMs: 2_000,
      });
      expect(persisted?.steps.find((step) => step.step === "validating")).toMatchObject({
        status: stepStatus,
        endedAtMs: 2_000,
      });
      for (const step of recordedSteps) {
        expect(persisted?.steps.find((entry) => entry.step === step.step)).toEqual(step);
      }
    },
  );

  it("records post-activation repair without reopening activation or retaining completed repair timestamps", () => {
    const options = isolatedOptions();
    const run = createUpdateRun({ trigger: "cli" }, options);
    const clock = vi.spyOn(Date, "now").mockReturnValue(run.createdAtMs + 100);
    recordUpdateRunPhase(run.runId, "validating", {}, options);
    recordUpdateRunPhase(run.runId, "repairing", {}, options);
    recordUpdateRunPhase(run.runId, "activating", {}, options);
    recordUpdateRunPhase(run.runId, "verifying", {}, options);
    clock.mockReturnValue(run.createdAtMs + 200);
    const repairing = recordUpdateRunPhase(run.runId, "repairing", {}, options);
    expect(repairing.phase).toBe("repairing");
    expect(repairing.steps.find((step) => step.step === "repairing")).toEqual({
      step: "repairing",
      status: "in_progress",
      startedAtMs: run.createdAtMs + 200,
    });
    for (const phase of ["activating", "restarting", "validating"] as const) {
      expect(recordUpdateRunPhase(run.runId, phase, {}, options).phase).toBe("repairing");
    }
    expect(recordUpdateRunPhase(run.runId, "verifying", {}, options).phase).toBe("verifying");
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

  it.each([
    { name: "step count", count: 130, detail: undefined },
    { name: "diagnostic bytes", count: 30, detail: "diagnostic ".repeat(80) },
    { name: "retained phase bytes", count: 0, detail: "🦞".repeat(512) },
  ])(
    "retains notice custody, restoration proof, and phases across the $name bound and database reopen",
    ({ count, detail }) => {
      const options = isolatedOptions();
      const run = createUpdateRun({ trigger: "chat" }, options);
      const notices = [
        "notice:ack",
        "notice:activating",
        "notice:verifying",
        "previous generation restoration",
      ];
      for (const step of [...UPDATE_RUN_PHASES, ...notices]) {
        recordUpdateRunStep(run.runId, { step, status: "completed", detail }, options);
      }
      for (let index = 0; index < count; index++) {
        recordUpdateRunStep(
          run.runId,
          { step: `diagnostic-${index}`, status: "completed", detail },
          options,
        );
      }
      closeOpenClawStateDatabaseForTest();
      const persisted = getUpdateRun(run.runId, options)!;
      expect(persisted.steps.map((step) => step.step)).toEqual(
        expect.arrayContaining([...UPDATE_RUN_PHASES, ...notices]),
      );
      expect(persisted.steps.every((step) => step.status === "completed")).toBe(true);
      expect(persisted.steps.length).toBeLessThanOrEqual(128);
      expect(Buffer.byteLength(JSON.stringify(persisted.steps))).toBeLessThanOrEqual(16 * 1024);
    },
  );

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
          settled: true,
          readyz: true,
          pluginErrors: [],
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
