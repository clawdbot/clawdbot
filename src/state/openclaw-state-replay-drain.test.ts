import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import {
  openOpenClawAgentDatabase,
  closeOpenClawAgentDatabasesAsync,
} from "./openclaw-agent-db.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";
import { assertOpenClawStateReplayWritersStopped } from "./openclaw-state-replay-drain.js";

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
function family(file: string) {
  return [file, `${file}-wal`, `${file}-shm`, `${file}-journal`].map((name) =>
    fs.existsSync(name) ? createHash("sha256").update(fs.readFileSync(name)).digest("hex") : null,
  );
}
function fixture() {
  const root = fs.realpathSync(dirs.make("replay-writer-evidence-"));
  const env = { HOME: root, OPENCLAW_STATE_DIR: root };
  const file = openOpenClawStateDatabase({ env }).path;
  closeOpenClawStateDatabaseForTest();
  return { root, file, env };
}
it("does not turn a missing family into drainage evidence or create state", () => {
  const f = fixture();
  const missing = path.join(f.root, "missing.sqlite");
  expect(() =>
    assertOpenClawStateReplayWritersStopped({ path: missing, env: f.env }, () => {}),
  ).toThrow("evidence is missing");
  expect(fs.existsSync(missing)).toBe(false);
});
it("refuses a real open agent lease without deleting it or changing source artifacts", async () => {
  const f = fixture();
  const agent = openOpenClawAgentDatabase({ agentId: "active", env: f.env });
  expect(agent).toBeDefined();
  closeOpenClawStateDatabaseForTest();
  const before = family(f.file);
  expect(() =>
    assertOpenClawStateReplayWritersStopped({ path: f.file, env: f.env }, () => {}),
  ).toThrow("agent database writer");
  expect(family(f.file)).toEqual(before);
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawStateDatabaseForTest();
  expect(() =>
    assertOpenClawStateReplayWritersStopped({ path: f.file, env: f.env }, () => {}),
  ).not.toThrow();
});
it("refuses the real plugin owner and accepts only after its ordinary release", async () => {
  const f = fixture();
  await withPluginLifecycleLease({ env: f.env }, async (lease) => {
    lease.assertOwned();
    closeOpenClawStateDatabaseForTest();
    const before = family(f.file);
    expect(() =>
      assertOpenClawStateReplayWritersStopped({ path: f.file, env: f.env }, () =>
        lease.assertOwned(),
      ),
    ).toThrow("maintenance lease");
    closeOpenClawStateDatabaseForTest();
    expect(family(f.file)).toEqual(before);
  });
  closeOpenClawStateDatabaseForTest();
  expect(() =>
    assertOpenClawStateReplayWritersStopped({ path: f.file, env: f.env }, () => {}),
  ).not.toThrow();
});
it.each([1, null])("preserves lease rows and refuses unknown expiry (%s)", (expiresAt) => {
  const f = fixture();
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.prepare(
        "INSERT INTO state_leases (scope, lease_key, owner, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      ).run("core:plugin-lifecycle", "global", "historical-owner", expiresAt, 0, 0);
    },
    { env: f.env },
  );
  closeOpenClawStateDatabaseForTest();
  const before = family(f.file);
  const inspect = () =>
    assertOpenClawStateReplayWritersStopped({ path: f.file, env: f.env }, () => {});
  if (expiresAt === null) {
    expect(inspect).toThrow("maintenance lease");
  } else {
    expect(inspect).not.toThrow();
  }
  expect(family(f.file)).toEqual(before);
});
