import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { getUpdateRun } from "./update-run-ledger.js";
import type {
  RecoveryPackageTestFactory,
  RecoveryPackageTestCommit,
} from "./update-run-recovery-package-fixture.test-support.js";
import { inspectUpdateRecovery, type UpdateRecoveryRecord } from "./update-run-recovery-schema.js";
import { commitUpdateRecoveryTerminal } from "./update-run-recovery-terminal.js";
import { inspectUpdateRecoveries, claimUpdateRecovery } from "./update-run-recovery.js";
// Each supplied fixture exclusively owns its disposable databases and files.
const fence = { assertCurrent() {} };

export function legacyRecord(record: UpdateRecoveryRecord) {
  const historical = structuredClone(record);
  const receipt = historical.terminal?.receipt ?? historical.verification?.receipt;
  if (!receipt) {
    throw new Error("Fixture requires saved evidence");
  }
  const legacy = {
    runId: receipt.runId,
    gateway: receipt.gateway,
    verifiedAtMs: receipt.verifiedAtMs,
    agentId: "main",
    sessionKey: "agent:main:legacy",
    sessionId: "legacy-session",
    agentRunId: randomUUID(),
    transcript: {
      generation: "legacy",
      maxSeq: 2,
      user: { entryId: "u", seq: 1 },
      assistant: { entryId: "a", seq: 2 },
    },
  };
  return {
    ...historical,
    verification: historical.verification ? { ...historical.verification, receipt: legacy } : null,
    ...(historical.terminal ? { terminal: { ...historical.terminal, receipt: legacy } } : {}),
  };
}

export function defineLegacyRecoveryInspectionTests(
  fixture: RecoveryPackageTestFactory,
  commit: RecoveryPackageTestCommit,
) {
  it("inspects legacy selected and superseded pairs byte-exactly without permitting a new terminal decision", async () => {
    const a = await fixture();
    const observedA = await a.activate();
    a.verified();
    commit(a, observedA);
    const b = await fixture(a.root, "3.0.0");
    const observedB = await b.activate();
    b.verified();
    commit(b, observedB);
    const records = [a.reload(), b.reload()];
    const legacy = records.map(legacyRecord);
    // Whitespace and property order are evidence too, not just parsed values.
    const raw = legacy.map((record) => JSON.stringify(record, null, 2));
    const { db } = openOpenClawStateDatabase(b.options);
    for (const [index, record] of records.entries()) {
      db.prepare("UPDATE config_machine_state SET value_json=? WHERE state_key=?").run(
        raw[index]!,
        "update.recovery." + record.runId,
      );
    }
    const rows = () =>
      db
        .prepare(
          "SELECT * FROM config_machine_state WHERE state_key LIKE 'update.recovery.%' ORDER BY state_key",
        )
        .all();
    const beforeRows = rows();
    const history = getUpdateRun(b.run.runId, b.options);
    closeOpenClawStateDatabaseForTest();
    const family = async () => {
      const dir = path.join(b.root, "state");
      return Promise.all(
        (await fs.readdir(dir))
          .toSorted()
          .map(async (name) => [name, await fs.readFile(path.join(dir, name))]),
      );
    };
    const beforeFamily = await family();
    const inspected = inspectUpdateRecoveries(b.options);
    expect(await family()).toEqual(beforeFamily);
    expect(inspected).toHaveLength(2);
    for (const [index, record] of records.entries()) {
      expect(inspected.find((entry) => entry.record.runId === record.runId)).toEqual({
        format: "legacy-serving",
        raw: raw[index],
        record: legacy[index],
      });
    }
    const selected = inspected.filter((entry) => entry.record.retainedPair?.state === "selected");
    expect(selected.map((entry) => entry.record.runId)).toEqual([b.run.runId]);
    expect(
      inspected.find((entry) => entry.record.runId === a.run.runId)?.record.retainedPair,
    ).toMatchObject({ state: "superseded", replacementRunId: b.run.runId });
    const assertReady = vi.fn();
    expect(() =>
      commitUpdateRecoveryTerminal(
        b.record,
        {
          status: "succeeded",
          package: observedB,
          assertReady,
        },
        fence,
        b.options,
      ),
    ).toThrow();
    expect(assertReady).not.toHaveBeenCalled();
    expect(() =>
      claimUpdateRecovery(
        b.record,
        {
          assertCurrent() {
            throw new Error("lost fence");
          },
        },
        b.options,
      ),
    ).toThrow("lost fence");
    const reopened = openOpenClawStateDatabase(b.options).db;
    expect(
      reopened
        .prepare(
          "SELECT * FROM config_machine_state WHERE state_key LIKE 'update.recovery.%' ORDER BY state_key",
        )
        .all(),
    ).toEqual(beforeRows);
    expect(getUpdateRun(b.run.runId, b.options)).toEqual(history);
    const broken = structuredClone(legacy[1]!);
    broken.terminal!.pairId = randomUUID();
    expect(() => inspectUpdateRecovery(JSON.stringify(broken), b.run.runId)).toThrow(
      "selected pair",
    );
    // A legacy receipt on an unfinished run cannot be used for a NEW terminal
    // commit, even with current claimed revision and a live readiness callback.
    const c = await fixture();
    const observedC = await c.activate();
    c.verified();
    const saved = JSON.stringify(legacyRecord(c.record));
    const cdb = openOpenClawStateDatabase(c.options).db;
    cdb
      .prepare("UPDATE config_machine_state SET value_json=? WHERE state_key=?")
      .run(saved, "update.recovery." + c.run.runId);
    expect(() =>
      commitUpdateRecoveryTerminal(
        c.record,
        {
          status: "succeeded",
          package: observedC,
          assertReady,
        },
        fence,
        c.options,
      ),
    ).toThrow();
    expect(assertReady).not.toHaveBeenCalled();
    expect(inspectUpdateRecoveries(c.options)[0]?.raw).toBe(saved);
    expect(getUpdateRun(c.run.runId, c.options)?.status).toBe("running");
  });
}
