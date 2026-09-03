import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveTranscriptsConfig } from "./config.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";
import { TranscriptsStore } from "./store.js";
import { readTranscriptSummary } from "./summary-persistence.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => closeOpenClawStateDatabaseForTest());

describe("readTranscriptSummary", () => {
  it("falls back to heuristic notes when no agent can be resolved for the model", async () => {
    const stateDir = tempDirs.make("openclaw-transcript-summary-");
    const store = new TranscriptsStore(path.join(stateDir, "transcripts"), {
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    // Ownerless row (no metadata.agentId) on a multi-agent host with explicit
    // ownership and no default marker: resolveDefaultAgentId throws for this shape.
    const session: TranscriptSessionDescriptor = {
      sessionId: "session-1",
      source: { providerId: "manual-transcript" },
      startedAt: "2026-07-01T10:00:00.000Z",
      stoppedAt: "2026-07-01T10:30:00.000Z",
      metadata: {},
    };
    await store.writeSession(session);
    await store.appendUtteranceForSession(session, {
      speaker: { label: "Ada" },
      text: "We agreed to ship the checklist.",
      final: true,
    });
    const cfg = {
      agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } },
    } as OpenClawConfig;

    const summary = await readTranscriptSummary({
      config: resolveTranscriptsConfig(undefined),
      cfg,
      store,
      session,
    });

    expect(summary.source).toBe("heuristic");
    expect(summary.participants).toEqual(["Ada"]);
    expect(summary.utteranceCount).toBe(1);
  });
});
