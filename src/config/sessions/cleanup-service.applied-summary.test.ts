import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";

const cleanupRace = vi.hoisted(() => ({
  afterPreview: undefined as (() => void) | undefined,
}));

vi.mock("./disk-budget.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./disk-budget.js")>();
  return {
    ...actual,
    pruneUnreferencedSessionArtifacts: vi.fn(async (params) => {
      const result = await actual.pruneUnreferencedSessionArtifacts(params);
      if (params.dryRun && cleanupRace.afterPreview) {
        const afterPreview = cleanupRace.afterPreview;
        cleanupRace.afterPreview = undefined;
        afterPreview();
      }
      return result;
    }),
  };
});

import { runSessionsCleanup } from "./cleanup-service.js";
import {
  appendTranscriptMessageSync,
  loadSessionEntry,
  replaceSessionEntry,
} from "./session-accessor.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("sessions cleanup applied summary", () => {
  afterEach(() => {
    cleanupRace.afterPreview = undefined;
    closeOpenClawAgentDatabasesForTest();
  });

  it("reports authoritative counts when a preview removal becomes stale before apply", async () => {
    const storePath = path.join(
      tempDirs.make("openclaw-cleanup-applied-summary-"),
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    const sessionKey = "agent:main:preview-became-live";
    const sessionId = "preview-became-live";
    const scope = { sessionId, sessionKey, storePath };
    await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
    cleanupRace.afterPreview = () => {
      appendTranscriptMessageSync(scope, {
        eventId: "message-after-preview",
        message: { role: "user", content: [{ type: "text", text: "keep this session" }] },
      });
    };

    const result = await runSessionsCleanup({
      cfg: {},
      opts: { enforce: true, fixMissing: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(result.appliedSummaries[0]).toMatchObject({
      applied: true,
      appliedCount: 1,
      beforeCount: 1,
      afterCount: 1,
      missing: 0,
      wouldMutate: false,
    });
    expect(loadSessionEntry({ sessionKey, storePath })).toMatchObject({ sessionId });
  });
});
