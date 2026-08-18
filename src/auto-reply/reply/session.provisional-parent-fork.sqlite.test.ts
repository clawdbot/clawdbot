import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  recordInboundSessionMeta,
  replaceSessionEntry,
  replaceTranscriptEvents,
  updateSessionLastRoute,
} from "../../config/sessions/session-accessor.js";
import { settleProvisionalParentFork } from "../../plugin-sdk/session-store-runtime.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { initSessionState } from "./session.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function makeStorePath(): string {
  const root = tempDirs.make("openclaw-provisional-fork-sqlite-");
  return path.join(root, "sessions", "sessions.json");
}

async function seedParentTranscript(params: {
  parentSessionId: string;
  parentSessionKey: string;
  secret: string;
  storePath: string;
}): Promise<void> {
  await replaceSessionEntry(
    { sessionKey: params.parentSessionKey, storePath: params.storePath },
    {
      sessionId: params.parentSessionId,
      totalTokens: 12,
      totalTokensFresh: true,
      updatedAt: Date.now(),
    },
  );
  await replaceTranscriptEvents(
    {
      agentId: "main",
      sessionId: params.parentSessionId,
      sessionKey: params.parentSessionKey,
      storePath: params.storePath,
    },
    [
      {
        type: "session",
        version: 3,
        id: params.parentSessionId,
        timestamp: "2026-08-04T00:00:00.000Z",
        cwd: path.dirname(params.storePath),
      },
      {
        type: "message",
        id: "parent-user",
        parentId: null,
        timestamp: "2026-08-04T00:00:01.000Z",
        message: { role: "user", content: params.secret },
      },
      {
        type: "message",
        id: "parent-assistant",
        parentId: "parent-user",
        timestamp: "2026-08-04T00:00:02.000Z",
        message: { role: "assistant", content: "parent answer" },
      },
      {
        type: "leaf",
        id: "parent-leaf",
        parentId: "parent-assistant",
        timestamp: "2026-08-04T00:00:03.000Z",
        targetId: "parent-assistant",
      },
    ],
  );
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("provisional parent fork SQLite isolation", () => {
  it("deletes copied context instead of replaying it after settlement is missed", async () => {
    const storePath = makeStorePath();
    const parentSessionKey = "agent:main:slack:channel:c1";
    const parentSessionId = "parent-session";
    const threadSessionKey = "agent:main:slack:channel:c1:thread:shared-root";
    const provisionalId = "slack:default:t1:c1:shared-root";
    const secret = "parent-only context must not survive";

    await seedParentTranscript({ parentSessionId, parentSessionKey, secret, storePath });

    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const rootContext = finalizeInboundContext({
      Body: "Start a bot-opened thread",
      ParentSessionKey: parentSessionKey,
      ProvisionalParentForkId: provisionalId,
      Provider: "slack",
      SessionKey: threadSessionKey,
    });
    await updateSessionLastRoute({
      channel: "slack",
      ctx: rootContext,
      sessionKey: threadSessionKey,
      storePath,
      threadId: "shared-root",
      to: "channel:c1",
    });
    await recordInboundSessionMeta({
      ctx: rootContext,
      sessionKey: threadSessionKey,
      storePath,
    });
    expect(
      loadSessionEntry({ sessionKey: threadSessionKey, storePath })?.provisionalParentFork,
    ).toEqual(expect.objectContaining({ id: provisionalId, parentSessionKey }));

    const provisional = await initSessionState({
      commandAuthorized: true,
      cfg,
      ctx: rootContext,
    });
    const provisionalSessionId = provisional.sessionId;
    expect(provisional.sessionEntry.provisionalParentFork?.id).toBe(provisionalId);
    expect(
      JSON.stringify(
        await loadTranscriptEvents({
          agentId: "main",
          sessionId: provisionalSessionId,
          sessionKey: threadSessionKey,
          storePath,
        }),
      ),
    ).toContain(secret);

    const isolated = await initSessionState({
      commandAuthorized: true,
      cfg,
      expectedExistingSessionId: provisionalSessionId,
      pinExpectedExistingSession: true,
      ctx: finalizeInboundContext({
        Body: "A user opens the thread after the bot stayed silent",
        ParentSessionKey: parentSessionKey,
        SessionKey: threadSessionKey,
      }),
    });

    expect(isolated.sessionId).not.toBe(provisionalSessionId);
    expect(isolated.sessionEntry).toMatchObject({
      forkedFromParent: true,
      totalTokens: 0,
      totalTokensFresh: true,
    });
    expect(isolated.sessionEntry.provisionalParentFork).toBeUndefined();
    expect(isolated.sessionEntry.forkSource).toBeUndefined();
    expect(isolated.sessionEntry.previousSessionId).toBeUndefined();
    expect(isolated.sessionEntry.usageFamilySessionIds).toBeUndefined();
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: provisionalSessionId,
        sessionKey: threadSessionKey,
        storePath,
      }),
    ).resolves.toEqual([]);
    await expect(
      loadTranscriptEvents({
        agentId: "main",
        sessionId: isolated.sessionId,
        sessionKey: threadSessionKey,
        storePath,
      }),
    ).resolves.toEqual([]);
    expect(loadSessionEntry({ sessionKey: threadSessionKey, storePath })?.sessionId).toBe(
      isolated.sessionId,
    );
  });

  it("preserves user-owned context when a provisional bot root arrives late", async () => {
    const storePath = makeStorePath();
    const parentSessionKey = "agent:main:slack:channel:c3";
    const parentSessionId = "parent-delayed-root";
    const threadSessionKey = "agent:main:slack:channel:c3:thread:user-first";
    const provisionalId = "slack:default:t1:c3:user-first";
    const parentSecret = "parent context must not replace the child";
    const childSecret = "user-created thread context must survive";
    await seedParentTranscript({
      parentSessionId,
      parentSessionKey,
      secret: parentSecret,
      storePath,
    });

    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const userTurn = await initSessionState({
      commandAuthorized: true,
      cfg,
      ctx: finalizeInboundContext({
        Body: "A user creates the thread first",
        Provider: "slack",
        SessionKey: threadSessionKey,
      }),
    });
    await replaceTranscriptEvents(
      {
        agentId: "main",
        sessionId: userTurn.sessionId,
        sessionKey: threadSessionKey,
        storePath,
      },
      [
        {
          type: "session",
          version: 3,
          id: userTurn.sessionId,
          timestamp: "2026-08-04T00:01:00.000Z",
          cwd: path.dirname(storePath),
        },
        {
          type: "message",
          id: "child-user",
          parentId: null,
          timestamp: "2026-08-04T00:01:01.000Z",
          message: { role: "user", content: childSecret },
        },
      ],
    );

    const delayedRootContext = finalizeInboundContext({
      Body: "A delayed bot root targets the occupied thread",
      ParentSessionKey: parentSessionKey,
      ProvisionalParentForkId: provisionalId,
      Provider: "slack",
      SessionKey: threadSessionKey,
    });
    await recordInboundSessionMeta({
      ctx: delayedRootContext,
      sessionKey: threadSessionKey,
      storePath,
    });
    expect(
      loadSessionEntry({ sessionKey: threadSessionKey, storePath })?.provisionalParentFork,
    ).toBeUndefined();

    const delayedRoot = await initSessionState({
      commandAuthorized: true,
      cfg,
      ctx: delayedRootContext,
    });

    expect(delayedRoot.sessionId).toBe(userTurn.sessionId);
    expect(delayedRoot.sessionEntry).toMatchObject({
      forkedFromParent: true,
      totalTokens: 0,
      totalTokensFresh: true,
    });
    expect(delayedRoot.sessionEntry.provisionalParentFork).toBeUndefined();
    expect(delayedRoot.sessionEntry.forkSource).toBeUndefined();
    const transcript = JSON.stringify(
      await loadTranscriptEvents({
        agentId: "main",
        sessionId: delayedRoot.sessionId,
        sessionKey: threadSessionKey,
        storePath,
      }),
    );
    expect(transcript).toContain(childSecret);
    expect(transcript).not.toContain(parentSecret);
  });

  it("stays isolated when Slack retirement wins during lifecycle admission drain", async () => {
    const storePath = makeStorePath();
    const parentSessionKey = "agent:main:slack:channel:c2";
    const parentSessionId = "parent-race";
    const threadSessionKey = "agent:main:slack:channel:c2:thread:race";
    const provisionalId = "slack:default:t1:c2:race";
    const secret = "raced parent context must not return";
    await seedParentTranscript({ parentSessionId, parentSessionKey, secret, storePath });

    const cfg = { session: { store: storePath } } as OpenClawConfig;
    const provisional = await initSessionState({
      commandAuthorized: true,
      cfg,
      ctx: finalizeInboundContext({
        Body: "Start another bot-opened thread",
        ParentSessionKey: parentSessionKey,
        ProvisionalParentForkId: provisionalId,
        SessionKey: threadSessionKey,
      }),
    });
    const provisionalSessionId = provisional.sessionId;
    let signalInterrupted = () => {};
    const interrupted = new Promise<void>((resolve) => {
      signalInterrupted = resolve;
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [threadSessionKey, provisionalSessionId],
      assertAllowed: () => {},
      onInterrupt: signalInterrupted,
    });
    const initialization = initSessionState({
      commandAuthorized: true,
      cfg,
      ctx: finalizeInboundContext({
        Body: "A user opens the colliding thread",
        ParentSessionKey: parentSessionKey,
        SessionKey: threadSessionKey,
      }),
    });

    try {
      await interrupted;
      await expect(
        settleProvisionalParentFork({
          id: provisionalId,
          outcome: "retire",
          sessionKey: threadSessionKey,
          storePath,
        }),
      ).resolves.toBe("retired");
      admission.release();

      const isolated = await initialization;
      expect(isolated.sessionId).not.toBe(provisionalSessionId);
      expect(isolated.previousSessionEntry?.sessionId).toBe(provisionalSessionId);
      expect(isolated.sessionEntry).toMatchObject({
        forkedFromParent: true,
        totalTokens: 0,
        totalTokensFresh: true,
      });
      expect(isolated.sessionEntry.forkSource).toBeUndefined();
      expect(
        JSON.stringify(
          await loadTranscriptEvents({
            agentId: "main",
            sessionId: isolated.sessionId,
            sessionKey: threadSessionKey,
            storePath,
          }),
        ),
      ).not.toContain(secret);
    } finally {
      admission.release();
      await initialization.catch(() => {});
    }
  });
});
