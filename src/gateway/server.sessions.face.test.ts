/** Gateway durable session-face behavior. */
import { expect, test } from "vitest";
import { SqliteBoardStore } from "../boards/sqlite-board-store.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import {
  listOpenIncognitoAgentDatabases,
  openOpenClawAgentDatabase,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { boardStore } from "./board-store.js";
import { rpcReq, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq,
  setupGatewaySessionsTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

test("a write-scoped face patch is visible to another client", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: Date.now() },
    },
  });

  const firstClient = await openClient({ scopes: ["operator.read", "operator.write"] });
  try {
    const patched = await rpcReq<{ ok: true; entry: { boardFace?: string } }>(
      firstClient.ws,
      "sessions.patch",
      { key: "agent:main:main", boardFace: "dashboard" },
    );
    expect(patched.ok).toBe(true);
    expect(patched.payload?.entry.boardFace).toBe("dashboard");

    const unknownField = await rpcReq(firstClient.ws, "sessions.patch", {
      key: "agent:main:main",
      futureFace: "dashboard",
    });
    expect(unknownField.ok).toBe(false);
    expect(unknownField.error?.message).toContain("missing scope: operator.admin");
  } finally {
    firstClient.ws.close();
  }

  const secondClient = await openClient({ scopes: ["operator.read"] });
  try {
    const listed = await rpcReq<{ sessions: Array<{ key: string; boardFace?: string }> }>(
      secondClient.ws,
      "sessions.list",
      { boardFace: "dashboard" },
    );
    expect(listed.ok).toBe(true);
    expect(listed.payload?.sessions).toMatchObject([
      { key: "agent:main:main", boardFace: "dashboard" },
    ]);
  } finally {
    secondClient.ws.close();
  }
});

test("sessions.list applies face filtering before pagination", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  await writeSessionStore({
    entries: {
      ...Object.fromEntries(
        Array.from({ length: 51 }, (_, index) => [
          `chat-${index}`,
          { sessionId: `sess-chat-${index}`, updatedAt: now - index },
        ]),
      ),
      dashboard: {
        sessionId: "sess-dashboard",
        updatedAt: now - 10_000,
        boardFace: "dashboard",
      },
    },
  });

  const listed = await directSessionReq<{
    sessions: Array<{ key: string; boardFace?: string }>;
    totalCount: number;
  }>("sessions.list", { boardFace: "dashboard", limit: 50 });

  expect(listed.ok).toBe(true);
  expect(listed.payload?.totalCount).toBe(1);
  expect(listed.payload?.sessions).toEqual([
    expect.objectContaining({ key: "agent:main:dashboard", boardFace: "dashboard" }),
  ]);
});

test("sessions.list filters dashboard sessions by board existence instead of saved face", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  await writeSessionStore({
    entries: {
      board: {
        sessionId: "sess-board",
        updatedAt: now,
        boardFace: "chat",
      },
      faceOnly: {
        sessionId: "sess-face-only",
        updatedAt: now - 1,
        boardFace: "dashboard",
      },
    },
  });
  boardStore.applyOps({ sessionKey: "agent:main:board" }, [
    { kind: "tab_create", tabId: "main", title: "Dashboard" },
  ]);

  const listed = await directSessionReq<{
    sessions: Array<{ key: string; boardFace?: string }>;
    totalCount: number;
  }>("sessions.list", { hasBoard: true, limit: 50 });

  expect(listed.ok).toBe(true);
  expect(listed.payload?.totalCount).toBe(1);
  expect(listed.payload?.sessions).toEqual([
    expect.objectContaining({ key: "agent:main:board", boardFace: "chat" }),
  ]);

  const withoutBoards = await directSessionReq<{
    sessions: Array<{ key: string }>;
    totalCount: number;
  }>("sessions.list", { hasBoard: false, limit: 50 });
  expect(withoutBoards.ok).toBe(true);
  expect(withoutBoards.payload?.totalCount).toBe(1);
  expect(withoutBoards.payload?.sessions).toEqual([
    expect.objectContaining({ key: "agent:main:faceonly" }),
  ]);
});

test("sessions.list includes boards stored with incognito sessions", async () => {
  await createSessionStoreDir();
  const sessionKey = "agent:main:dashboard:incognito-board";
  const incognitoPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" });
  openOpenClawAgentDatabase({ agentId: "main", path: incognitoPath });
  replaceSessionEntrySync(
    { agentId: "main", sessionKey, storePath: incognitoPath },
    { sessionId: "sess-incognito", updatedAt: 1, incognito: true },
  );
  const incognitoBoardStore = new SqliteBoardStore({
    resolveSession: () => ({ agentId: "main", path: incognitoPath, sessionKey }),
  });
  incognitoBoardStore.applyOps({ sessionKey }, [
    { kind: "tab_create", tabId: "main", title: "Incognito dashboard" },
  ]);
  expect(listOpenIncognitoAgentDatabases()).toContainEqual({
    agentId: "main",
    storePath: incognitoPath,
  });

  const client = { connect: { scopes: ["operator.admin"] } } as never;
  const unfiltered = await directSessionReq<{ sessions: Array<{ key: string }> }>(
    "sessions.list",
    {},
    { client },
  );
  expect(unfiltered.payload?.sessions).toEqual([expect.objectContaining({ key: sessionKey })]);

  const listed = await directSessionReq<{ sessions: Array<{ key: string }> }>(
    "sessions.list",
    { hasBoard: true },
    { client },
  );
  expect(listed.ok).toBe(true);
  expect(listed.payload?.sessions).toEqual([expect.objectContaining({ key: sessionKey })]);
});
