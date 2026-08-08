// Orphan-transcript classification tests: doctor must never offer to archive a transcript the
// session store still points at, through any of its locator fields.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveSessionTranscriptsDirForAgent,
  resolveStorePath,
} from "../config/sessions/paths.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { noteStateIntegrity as noteStateIntegrityRaw } from "./doctor-state-integrity.js";

vi.mock("../channels/plugins/bundled-ids.js", () => ({
  listBundledChannelIds: () => ["matrix", "whatsapp"],
  listBundledChannelPluginIds: () => ["matrix", "whatsapp"],
}));

vi.mock("../channels/plugins/persisted-auth-state.js", () => ({
  listBundledChannelIdsWithPersistedAuthState: () => ["matrix", "whatsapp"],
  hasBundledChannelPersistedAuthState: () => false,
}));

const noteMock = vi.fn();

function stateIntegrityText(): string {
  return noteMock.mock.calls
    .filter((call) => call[1] === "State integrity")
    .map((call) => String(call[0]))
    .join("\n");
}

describe("doctor orphan transcript classification", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempHome = "";

  beforeEach(() => {
    envSnapshot = captureEnv([
      "HOME",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_OAUTH_DIR",
      "OPENCLAW_AGENT_DIR",
    ]);
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-orphan-"));
    const stateDir = path.join(tempHome, ".openclaw");
    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    deleteTestEnvValue("OPENCLAW_OAUTH_DIR");
    deleteTestEnvValue("OPENCLAW_AGENT_DIR");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    noteMock.mockClear();
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("keeps transcripts referenced by anything other than the live sessionId out of the orphan set", async () => {
    // `sessions.json` records one CURRENT session per key. Compaction rotation, checkpoints and
    // the system-prompt report all leave live transcripts referenced through other fields, and a
    // rotated transcript keeps a generated `<iso-stamp>_<sessionId>.jsonl` name that never equals
    // the canonical path. Counting any of those as orphans offers to archive real history.
    const cfg: OpenClawConfig = { agents: { entries: { main: { default: true } } } };
    const liveId = "31f8d80e-159f-405a-a2ae-90c0a2e8e1a3";
    const rotatedId = "2a3e99a6-7acc-436b-81e4-e7a30950e5d1";
    const checkpointSessionId = "faa9607a-33e2-4d24-8c90-fc098452571d";
    const reportId = "574bd187-b31a-4cb2-8566-1e400a97112f";

    const sessionsDir = resolveSessionTranscriptsDirForAgent("main", process.env, () => tempHome);
    const storePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(path.dirname(storePath), { recursive: true });

    const liveFile = `2026-08-08T23-07-16-077Z_${liveId}.jsonl`;
    const rotatedFile = `2026-08-03T15-43-35-713Z_${rotatedId}.jsonl`;
    for (const name of [
      liveFile,
      rotatedFile,
      `${checkpointSessionId}.jsonl`,
      `${reportId}.jsonl`,
      "real-orphan.jsonl",
    ]) {
      fs.writeFileSync(path.join(sessionsDir, name), '{"type":"session"}\n');
    }

    fs.writeFileSync(
      storePath,
      JSON.stringify(
        {
          "agent:main:main": {
            sessionId: liveId,
            updatedAt: Date.now(),
            sessionFile: path.join(sessionsDir, liveFile),
            usageFamilySessionIds: [rotatedId],
            compactionCheckpoints: [
              {
                checkpointId: "9a259ada-5ca1-42d9-9885-92c1240780bd",
                sessionKey: "agent:main:main",
                sessionId: checkpointSessionId,
                createdAt: Date.now(),
                reason: "auto-threshold",
              },
            ],
            systemPromptReport: {
              source: "run",
              generatedAt: Date.now(),
              sessionId: reportId,
            },
          },
        },
        null,
        2,
      ),
    );

    await noteStateIntegrityRaw(cfg, {
      confirmRuntimeRepair: vi.fn(async () => false),
      note: noteMock,
    });

    const text = stateIntegrityText();
    expect(text).toContain("Found 1 orphan transcript file");
    expect(text).toContain("Examples: real-orphan.jsonl");
    for (const referenced of [liveFile, rotatedFile, checkpointSessionId, reportId]) {
      expect(text).not.toContain(referenced);
    }
  });
});
