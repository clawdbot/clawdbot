/** Gateway durable session-face behavior. */
import { expect, test } from "vitest";
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
