import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { type DiscoveredSession, discoverAllSessions } from "./session-cost-usage.js";

// ---------------------------------------------------------------------------
// Checkpoint dedup regression coverage
//
// discoverAllSessions must NOT treat `<parentId>.checkpoint.<uuid>.jsonl`
// files as distinct sessions. They are pre-compaction snapshot siblings of
// the parent primary and must be grouped under the parent session id. See
// src/config/sessions/artifacts.ts for the classifier + parent-id parser.
// ---------------------------------------------------------------------------

const PARENT_UUID = "e417ba9b-8043-43db-8d18-d88f1823567d";
const OTHER_PARENT_UUID = "71029058-ffdd-4def-9a8c-c84f9e1e3f01";
const CHECKPOINT_UUIDS = [
  "21901ee7-8f22-4d07-9e39-6eaf7b224630",
  "44d92356-464c-4556-9403-77096e791375",
  "47b9a01e-169a-442c-8e42-52f2188051eb",
  "7da74434-2bd8-499e-8216-ba3fa0869884",
  "ac813e2a-ad7b-4a0f-9f7b-26c0fbac2746",
];

const USER_JSONL_LINE = JSON.stringify({
  type: "message",
  message: { role: "user", content: "hello from parent primary" },
});
const EMPTY_JSONL = "";

async function makeAgentSessionsDir(root: string, agentId = "main"): Promise<string> {
  const sessionsDir = path.join(root, "agents", agentId, "sessions");
  await fs.mkdir(sessionsDir, { recursive: true });
  return sessionsDir;
}

async function discoverUnder(stateDir: string): Promise<DiscoveredSession[]> {
  return await withEnvAsync(
    { OPENCLAW_STATE_DIR: stateDir },
    async () => await discoverAllSessions(),
  );
}

describe("discoverAllSessions — checkpoint dedup", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-discover-ckp-",
  });

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  it("(a) single primary: surfaces one discovered session", async () => {
    const root = await suiteRootTracker.make("case-a");
    const sessionsDir = await makeAgentSessionsDir(root);
    await fs.writeFile(path.join(sessionsDir, `${PARENT_UUID}.jsonl`), USER_JSONL_LINE);

    const discovered = await discoverUnder(root);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.sessionId).toBe(PARENT_UUID);
  });

  it("(b) primary + one checkpoint: one discovered session under parent id", async () => {
    const root = await suiteRootTracker.make("case-b");
    const sessionsDir = await makeAgentSessionsDir(root);
    await fs.writeFile(path.join(sessionsDir, `${PARENT_UUID}.jsonl`), USER_JSONL_LINE);
    await fs.writeFile(
      path.join(sessionsDir, `${PARENT_UUID}.checkpoint.${CHECKPOINT_UUIDS[0]}.jsonl`),
      EMPTY_JSONL,
    );

    const discovered = await discoverUnder(root);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.sessionId).toBe(PARENT_UUID);
    // Primary's sessionFile wins over checkpoint's sessionFile.
    expect(discovered[0]?.sessionFile.endsWith(`${PARENT_UUID}.jsonl`)).toBe(true);
  });

  it("(b2) newer checkpoint mtime is preserved when primary replaces the placeholder", async () => {
    // Directory iteration order is non-deterministic (readdir + concurrent
    // stat), so whether the checkpoint or the primary is scanned first varies.
    // A freshly-written checkpoint can carry a newer mtime than its parent
    // primary; the discovered session's mtime must be the MAX of the two and
    // its sessionFile must stay the primary — regardless of scan order.
    const root = await suiteRootTracker.make("case-b2");
    const sessionsDir = await makeAgentSessionsDir(root);
    const primaryPath = path.join(sessionsDir, `${PARENT_UUID}.jsonl`);
    const checkpointPath = path.join(
      sessionsDir,
      `${PARENT_UUID}.checkpoint.${CHECKPOINT_UUIDS[0]}.jsonl`,
    );
    await fs.writeFile(primaryPath, USER_JSONL_LINE);
    await fs.writeFile(checkpointPath, EMPTY_JSONL);

    const olderMtime = new Date("2026-01-01T00:00:00.000Z");
    const newerMtime = new Date("2026-01-02T00:00:00.000Z");
    // Primary is OLDER; the checkpoint captured more recent activity.
    await fs.utimes(primaryPath, olderMtime, olderMtime);
    await fs.utimes(checkpointPath, newerMtime, newerMtime);

    const discovered = await discoverUnder(root);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.sessionId).toBe(PARENT_UUID);
    // sessionFile stays the primary; mtime is the newer checkpoint value.
    expect(discovered[0]?.sessionFile.endsWith(`${PARENT_UUID}.jsonl`)).toBe(true);
    expect(discovered[0]?.mtime).toBe(newerMtime.getTime());
  });

  it("(c) five checkpoints only, parent primary missing: one discovered entry under parent id", async () => {
    const root = await suiteRootTracker.make("case-c");
    const sessionsDir = await makeAgentSessionsDir(root);
    for (const ckpUuid of CHECKPOINT_UUIDS) {
      await fs.writeFile(
        path.join(sessionsDir, `${PARENT_UUID}.checkpoint.${ckpUuid}.jsonl`),
        EMPTY_JSONL,
      );
    }

    const discovered = await discoverUnder(root);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.sessionId).toBe(PARENT_UUID);
  });

  it("(d) primary + five checkpoints: one discovered session", async () => {
    const root = await suiteRootTracker.make("case-d");
    const sessionsDir = await makeAgentSessionsDir(root);
    await fs.writeFile(path.join(sessionsDir, `${PARENT_UUID}.jsonl`), USER_JSONL_LINE);
    for (const ckpUuid of CHECKPOINT_UUIDS) {
      await fs.writeFile(
        path.join(sessionsDir, `${PARENT_UUID}.checkpoint.${ckpUuid}.jsonl`),
        EMPTY_JSONL,
      );
    }
    // Also include an unrelated session to be sure discover returns 2 total, not 6.
    await fs.writeFile(path.join(sessionsDir, `${OTHER_PARENT_UUID}.jsonl`), USER_JSONL_LINE);

    const discovered = await discoverUnder(root);
    const ids = discovered.map((d) => d.sessionId).toSorted();
    expect(ids).toEqual([OTHER_PARENT_UUID, PARENT_UUID].toSorted());
  });

  it("(e) .reset./.deleted. archives: still counted as their own entries (usage-count preserved)", async () => {
    const root = await suiteRootTracker.make("case-e");
    const sessionsDir = await makeAgentSessionsDir(root);
    // Primary present, plus one reset archive and one deleted archive for the same id.
    await fs.writeFile(path.join(sessionsDir, `${PARENT_UUID}.jsonl`), USER_JSONL_LINE);
    await fs.writeFile(
      path.join(sessionsDir, `${PARENT_UUID}.jsonl.reset.2026-01-01T00-00-00.000Z`),
      EMPTY_JSONL,
    );
    await fs.writeFile(
      path.join(sessionsDir, `${PARENT_UUID}.jsonl.deleted.2026-02-02T00-00-00.000Z`),
      EMPTY_JSONL,
    );

    const discovered = await discoverUnder(root);
    // The archives share the same session id and dedup with the primary in the
    // discover map, so final count is 1 — the primary wins sessionFile.
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.sessionId).toBe(PARENT_UUID);
    expect(discovered[0]?.sessionFile.endsWith(`${PARENT_UUID}.jsonl`)).toBe(true);
  });

  it("(f) primary with 'checkpoint' substring in session id: NOT dedup (regex anchored)", async () => {
    const root = await suiteRootTracker.make("case-f");
    const sessionsDir = await makeAgentSessionsDir(root);
    // This file name contains "checkpoint" in the session id portion, but
    // does NOT match the UUID-anchored checkpoint regex. Must be treated as
    // a distinct primary session.
    const trickyId = "my-checkpoint-review-session";
    await fs.writeFile(path.join(sessionsDir, `${trickyId}.jsonl`), USER_JSONL_LINE);

    const discovered = await discoverUnder(root);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.sessionId).toBe(trickyId);
  });
});
