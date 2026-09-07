import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OpenClawConfig } from "../types.openclaw.js";

const cleanupRace = vi.hoisted(() => ({
  afterPreview: undefined as (() => void) | undefined,
  postCommitFailureStorePath: undefined as string | undefined,
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
      if (!params.dryRun && cleanupRace.postCommitFailureStorePath === params.storePath) {
        throw new Error("injected post-commit artifact failure");
      }
      return result;
    }),
  };
});

import { runSessionsCleanup } from "./cleanup-service.js";
import {
  appendTranscriptEventSync,
  appendTranscriptMessageSync,
  loadSessionEntry,
  replaceSessionEntry,
} from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("sessions cleanup applied summary", () => {
  afterEach(() => {
    cleanupRace.afterPreview = undefined;
    cleanupRace.postCommitFailureStorePath = undefined;
    closeOpenClawAgentDatabasesForTest();
  });

  it.each([true, false])(
    "reports a sole empty orphan as a mutation (dryRun=%s)",
    async (dryRun) => {
      await withOpenClawTestState({}, async (state) => {
        const storePath = path.join(state.sessionsDir(), "sessions.json");
        const cfg = {
          session: { maintenance: { mode: "enforce", maxDiskBytes: false, pruneAfter: "1s" } },
        } satisfies OpenClawConfig;
        await state.writeConfig(cfg);
        await fs.mkdir(state.sessionsDir(), { recursive: true });
        const orphan = path.join(state.sessionsDir(), "orphan.jsonl");
        await fs.writeFile(orphan, "");
        const old = new Date(Date.now() - 60_000);
        await fs.utimes(orphan, old, old);

        const result = await runSessionsCleanup({
          cfg,
          opts: { dryRun, enforce: true },
          targets: [{ agentId: "main", storePath }],
        });

        const expected = {
          beforeCount: 0,
          afterCount: 0,
          wouldMutate: true,
          diskBudget: null,
          unreferencedArtifacts: { removedFiles: 1, freedBytes: 0 },
        };
        expect(result.previewResults[0]?.summary).toMatchObject({ ...expected, dryRun });
        if (dryRun) {
          expect(result.appliedSummaries).toEqual([]);
          await expect(fs.readFile(orphan, "utf8")).resolves.toBe("");
        } else {
          expect(result.appliedSummaries).toMatchObject([
            { ...expected, applied: true, dryRun: false },
          ]);
          await expect(fs.stat(orphan)).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );

  it("applies the selected agent's preview without pruning a sibling behind the same selector", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const storePath = state.statePath("shared.json");
      const cfg = {
        agents: { ownership: "explicit", entries: { main: {}, beta: {} } },
        session: { store: storePath, maintenance: { mode: "warn", pruneAfter: "1d" } },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      const scopes = ["main", "beta"].map((agentId) => ({
        agentId,
        sessionKey: `agent:${agentId}:stale`,
        storePath,
      }));
      const updatedAt = Date.now() - 2 * 24 * 60 * 60_000;
      for (const scope of scopes) {
        await replaceSessionEntry(scope, {
          sessionId: `${scope.agentId}-stale`,
          updatedAt,
        });
        expect(loadSessionEntry(scope)?.updatedAt).toBe(updatedAt);
      }

      const result = await runSessionsCleanup({ cfg, opts: { agent: "beta", enforce: true } });

      expect(result.previewResults[0]?.summary).toMatchObject({
        agentId: "beta",
        beforeCount: 1,
        afterCount: 0,
        pruned: 1,
      });
      expect(result.appliedSummaries[0]).toMatchObject({
        agentId: "beta",
        beforeCount: 1,
        afterCount: 0,
        pruned: 1,
        applied: true,
      });
      expect(loadSessionEntry(scopes[0]!)).toMatchObject({ sessionId: "main-stale" });
      expect(loadSessionEntry(scopes[1]!)).toBeUndefined();
    });
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

  it.each([
    { fault: "before commit", lifecycleCommitted: false },
    { fault: "after commit", lifecycleCommitted: true },
  ])(
    "returns earlier committed summaries when a later store fails $fault",
    async ({ lifecycleCommitted }) => {
      const rootDir = tempDirs.make("openclaw-cleanup-partial-");
      const main = {
        agentId: "main",
        sessionId: "main-message-free",
        sessionKey: "agent:main:message-free",
        storePath: path.join(rootDir, "agents", "main", "sessions", "sessions.json"),
      };
      const failing = {
        agentId: "work",
        sessionId: "work-message-free",
        sessionKey: "agent:work:message-free",
        storePath: path.join(rootDir, "agents", "work", "sessions", "sessions.json"),
      };
      const stores = [main, failing];
      for (const store of stores) {
        await replaceSessionEntry(store, {
          sessionId: store.sessionId,
          updatedAt: Date.now() - 100_000_000,
        });
        appendTranscriptEventSync(store, { type: "proof", content: store.agentId });
      }
      const failingSqlitePath = resolveSqliteTargetFromSessionStorePath(failing.storePath, {
        agentId: failing.agentId,
      }).path;
      if (lifecycleCommitted) {
        cleanupRace.postCommitFailureStorePath = failing.storePath;
      } else {
        openOpenClawAgentDatabase({ agentId: failing.agentId, path: failingSqlitePath }).db.exec(`
          CREATE TRIGGER fail_second_store_delete
          BEFORE DELETE ON session_windows
          WHEN OLD.session_id = '${failing.sessionId}'
          BEGIN
            SELECT RAISE(ABORT, 'injected second-store lifecycle failure');
          END;
        `);
      }

      const outcome = await runSessionsCleanup({
        cfg: {},
        opts: { enforce: true, fixMissing: true },
        targets: stores,
      });

      expect(loadSessionEntry(main)).toBeUndefined();
      if (lifecycleCommitted) {
        expect(loadSessionEntry(failing)).toBeUndefined();
      } else {
        expect(loadSessionEntry(failing)).toMatchObject({ sessionId: failing.sessionId });
      }
      expect(outcome).toMatchObject({
        appliedSummaries: [expect.objectContaining({ agentId: "main", applied: true })],
        failure: expect.objectContaining({
          target: expect.objectContaining({ agentId: "work" }),
          lifecycleCommitted,
        }),
      });
    },
  );
});
