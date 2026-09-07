// Covers command-session resolution for a yielded parent whose children complete
// after its transcript was admitted: the parent generation must survive.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  appendTranscriptEvent,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { deriveGatewaySessionLifecycleSnapshot } from "../../gateway/session-lifecycle-state.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveSession } from "./session.js";

describe("resolveSession with a yielded running parent", () => {
  let stateDir: string;
  let storePath: string;

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-yielded-parent-"));
    storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("keeps the parent session generation across sibling completions", async () => {
    const agentId = "main";
    const sessionKey = "agent:main:main";
    const parentSessionId = "parent-session-0001";
    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const startedAt = Date.now() - 60_000;
    const yieldedAt = startedAt + 20_000;

    // The parent run starts, then yields; the Gateway projection keeps it running
    // while recording the settled run's endedAt.
    const running = deriveGatewaySessionLifecycleSnapshot({
      session: { updatedAt: startedAt },
      event: {
        ts: startedAt,
        sessionId: parentSessionId,
        runId: "parent-run",
        data: { phase: "start", startedAt },
      },
    });
    const yielded = deriveGatewaySessionLifecycleSnapshot({
      session: running,
      event: {
        ts: yieldedAt,
        sessionId: parentSessionId,
        runId: "parent-run",
        data: {
          phase: "end",
          endedAt: yieldedAt,
          yielded: true,
          livenessState: "paused",
          stopReason: "end_turn",
        },
      },
    });
    expect(yielded).toMatchObject({ status: "running", endedAt: yieldedAt });
    await upsertSessionEntryCore(
      { agentId, sessionKey, storePath },
      {
        sessionId: parentSessionId,
        sessionFile: `sqlite:main:${parentSessionId}:${resolveOpenClawAgentSqlitePath({
          agentId,
          env: { OPENCLAW_STATE_DIR: stateDir },
        })}`,
        updatedAt: yieldedAt,
        startedAt,
        status: yielded.status,
        endedAt: yielded.endedAt,
      },
    );

    const first = resolveSession({ cfg, sessionKey, agentId });
    expect(first.sessionId).toBe(parentSessionId);

    // The first completion's prompt admission lands after the registry row.
    await appendTranscriptEvent(
      { agentId, sessionId: parentSessionId, sessionKey, storePath },
      { type: "custom", timestamp: new Date().toISOString() },
    );
    expect(loadSessionEntry({ agentId, sessionKey, storePath })).toMatchObject({
      status: "running",
      endedAt: yieldedAt,
    });

    const second = resolveSession({ cfg, sessionKey, agentId });
    expect(second.sessionId).toBe(parentSessionId);
    expect(second.isNewSession).toBe(false);
    expect(second.previousSessionId).toBeUndefined();
  });
});
