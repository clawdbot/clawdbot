import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import {
  deleteSessionEntryLifecycle,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "./session-accessor.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";

const archiveMaterializationHook = vi.hoisted(() => ({
  beforeMaterialize: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("./session-accessor.sqlite-archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-archive.js")>();
  return {
    ...actual,
    materializeSessionStateDeletePlans: async (
      ...args: Parameters<typeof actual.materializeSessionStateDeletePlans>
    ) => {
      await archiveMaterializationHook.beforeMaterialize?.();
      return await actual.materializeSessionStateDeletePlans(...args);
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite reclamation admission races", () => {
  let storePath: string;

  beforeEach(() => {
    const tempDir = tempDirs.make("openclaw-session-reclamation-admission-race-");
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(() => {
    archiveMaterializationHook.beforeMaterialize = undefined;
    closeOpenClawAgentDatabasesForTest();
  });

  it("fences new historical-generation work through the Worker commit", async () => {
    const sessionKey = "agent:main:historical-admission-race";
    const historicalSessionId = "historical-admission-previous";
    const currentSessionId = "historical-admission-current";
    const historicalEvent = {
      type: "session" as const,
      id: historicalSessionId,
      content: "historical admission transcript",
    };
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: historicalSessionId, updatedAt: 1 },
    );
    await replaceTranscriptEvents({ sessionKey, sessionId: historicalSessionId, storePath }, [
      historicalEvent,
    ]);
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: currentSessionId, updatedAt: 2 },
    );

    let markMaterializationStarted: () => void = () => undefined;
    const materializationStarted = new Promise<void>((resolve) => {
      markMaterializationStarted = resolve;
    });
    let releaseMaterialization: () => void = () => undefined;
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    archiveMaterializationHook.beforeMaterialize = async () => {
      markMaterializationStarted();
      await materializationGate;
    };

    const deletion = deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    await materializationStarted;
    const assertHistoricalGenerationExists = async () => {
      const events = await loadTranscriptEvents({
        sessionKey,
        sessionId: historicalSessionId,
        storePath,
      });
      if (events.length === 0) {
        throw new Error("historical generation no longer exists");
      }
    };
    let admissionSettled = false;
    const admissionOutcome = beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, historicalSessionId],
      assertAllowed: assertHistoricalGenerationExists,
      revalidateAllowed: assertHistoricalGenerationExists,
    })
      .then((lease) => {
        lease.release();
        return "admitted";
      })
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
      .finally(() => {
        admissionSettled = true;
      });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(admissionSettled).toBe(false);
    releaseMaterialization();

    await expect(deletion).resolves.toMatchObject({ deleted: true });
    await expect(admissionOutcome).resolves.toBe("historical generation no longer exists");
    await expect(
      loadTranscriptEvents({ sessionKey, sessionId: historicalSessionId, storePath }),
    ).resolves.toEqual([]);
  });

  it("fences new current-generation work through the Worker commit", async () => {
    const sessionKey = "agent:main:current-admission-race";
    const sessionId = "current-admission-run";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: 1 });
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
      { type: "session", id: sessionId, content: "current admission transcript" },
    ]);

    let markMaterializationStarted: () => void = () => undefined;
    const materializationStarted = new Promise<void>((resolve) => {
      markMaterializationStarted = resolve;
    });
    let releaseMaterialization: () => void = () => undefined;
    const materializationGate = new Promise<void>((resolve) => {
      releaseMaterialization = resolve;
    });
    archiveMaterializationHook.beforeMaterialize = async () => {
      markMaterializationStarted();
      await materializationGate;
    };

    const deletion = deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    await materializationStarted;
    const assertCurrentGenerationExists = async () => {
      const events = await loadTranscriptEvents({ sessionKey, sessionId, storePath });
      if (events.length === 0) {
        throw new Error("current generation no longer exists");
      }
    };
    let admissionSettled = false;
    const admissionOutcome = beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionKey, sessionId],
      assertAllowed: assertCurrentGenerationExists,
      revalidateAllowed: assertCurrentGenerationExists,
    })
      .then((lease) => {
        lease.release();
        return "admitted";
      })
      .catch((error: unknown) => (error instanceof Error ? error.message : String(error)))
      .finally(() => {
        admissionSettled = true;
      });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(admissionSettled).toBe(false);
    releaseMaterialization();

    await expect(deletion).resolves.toMatchObject({ deleted: true });
    await expect(admissionOutcome).resolves.toBe("current generation no longer exists");
    await expect(loadTranscriptEvents({ sessionKey, sessionId, storePath })).resolves.toEqual([]);
  });
});
