import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../../test/helpers/temp-dir.js";
import * as agentDatabase from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryLifecycleMutation,
  loadTranscriptEvents,
  resetSessionEntryLifecycle,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import {
  readRecentSessionTranscriptActiveEvents,
  waitForSessionTranscriptProjection,
} from "./session-accessor.sqlite-active-events.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.js";

const transactionInjection = vi.hoisted(() => ({ run: null as (() => void) | null }));

vi.mock("../../state/openclaw-agent-db.js", async (importOriginal) => {
  const actual = await importOriginal<typeof agentDatabase>();
  return {
    ...actual,
    runOpenClawAgentWriteTransaction: <T>(
      run: Parameters<typeof actual.runOpenClawAgentWriteTransaction<T>>[0],
      options: Parameters<typeof actual.runOpenClawAgentWriteTransaction<T>>[1],
    ) => {
      const inject = transactionInjection.run;
      transactionInjection.run = null;
      inject?.();
      return actual.runOpenClawAgentWriteTransaction(run, options);
    },
  };
});

describe("reset boundary concurrency", () => {
  const tempDirs: string[] = [];
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = makeTempDir(tempDirs, "openclaw-reset-boundary-race-");
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    transactionInjection.run = null;
    agentDatabase.closeOpenClawAgentDatabasesForTest();
    cleanupTempDirs(tempDirs);
  });

  it.each([
    {
      name: "single reset",
      reset: async (scope: { sessionId: string; sessionKey: string; storePath: string }) =>
        resetSessionEntryLifecycle({
          buildNextEntry: () => ({ sessionId: "next-single", updatedAt: 20 }),
          resetBoundaryReason: "reset",
          storePath: scope.storePath,
          target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        }),
    },
    {
      name: "bulk lifecycle reset",
      reset: async (scope: { sessionId: string; sessionKey: string; storePath: string }) =>
        applySessionEntryLifecycleMutation({
          skipMaintenance: true,
          storePath: scope.storePath,
          upserts: [
            {
              entry: { sessionId: "next-bulk", updatedAt: 20 },
              resetBoundaryReason: "reset",
              sessionKey: scope.sessionKey,
            },
          ],
        }),
    },
  ])("parents the $name boundary after a concurrent accepted message", async ({ reset }) => {
    const scope = {
      sessionId: "current-session",
      sessionKey: "agent:main:reset-race",
      storePath,
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
    appendTranscriptMessageSync(scope, {
      eventId: "initial",
      message: { role: "user", content: "initial" },
      parentId: null,
    });
    transactionInjection.run = () => {
      appendTranscriptMessageSync(scope, {
        eventId: "concurrent",
        message: { role: "user", content: "accepted concurrently" },
        parentId: "initial",
      });
    };

    await reset(scope);

    const raw = await loadTranscriptEvents(scope);
    const boundary = raw.find(
      (event) =>
        event !== null &&
        typeof event === "object" &&
        !Array.isArray(event) &&
        (event as { type?: unknown }).type === "reset",
    );
    expect(boundary).toMatchObject({ parentId: "concurrent" });
    await waitForSessionTranscriptProjection(scope);
    expect(
      readRecentSessionTranscriptActiveEvents(scope, 10).map(
        (event) => (event as { id?: unknown }).id,
      ),
    ).toContain("concurrent");

    agentDatabase.closeOpenClawAgentDatabasesForTest();
    await waitForSessionTranscriptProjection(scope);
    expect(
      readRecentSessionTranscriptActiveEvents(scope, 10).map(
        (event) => (event as { id?: unknown }).id,
      ),
    ).toContain("concurrent");
  });
});
