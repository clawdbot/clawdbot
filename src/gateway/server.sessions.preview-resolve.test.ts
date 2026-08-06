/**
 * Gateway session preview resolve tests.
 */
import { expect, test } from "vitest";
import { createToolSummaryPreviewTranscriptLines } from "./session-preview.test-helpers.js";
import { rpcReq, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  directSessionReq,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

test("sessions.preview returns transcript previews", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-preview";
  const lines = createToolSummaryPreviewTranscriptLines(sessionId);

  await writeSessionStore({
    entries: {
      "agent:main:main": sessionStoreEntry(sessionId),
    },
  });
  await seedSessionTranscript({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    messages: lines
      .map((line) => JSON.parse(line) as { message?: Record<string, unknown> })
      .map((record) => record.message)
      .filter((message): message is Record<string, unknown> => Boolean(message))
      .map((message) => Object.assign({ role: String(message.role) }, message)),
  });

  const preview = await directSessionReq<{
    previews: Array<{
      key: string;
      status: string;
      items: Array<{ role: string; text: string }>;
    }>;
  }>("sessions.preview", { keys: ["main"], limit: 3, maxChars: 120 });
  expect(preview.ok).toBe(true);
  const entry = preview.payload?.previews[0];
  expect(entry?.key).toBe("main");
  expect(entry?.status).toBe("ok");
  expect(entry?.items.map((item) => item.role)).toEqual(["assistant", "tool", "assistant"]);
  expect(entry?.items[1]?.text).toContain("call weather");
});

test("sessions.resolve by sessionId ignores fuzzy-search list limits and returns the exact match", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  const entries: Record<string, { sessionId: string; updatedAt: number; label?: string }> = {
    "agent:main:subagent:target": {
      sessionId: "sess-target-exact",
      updatedAt: now - 20_000,
    },
  };
  for (let i = 0; i < 9; i += 1) {
    entries[`agent:main:subagent:noisy-${i}`] = {
      sessionId: `sess-noisy-${i}`,
      updatedAt: now - i * 1_000,
      label: `sess-target-exact noisy ${i}`,
    };
  }
  await writeSessionStore({ entries });

  const { ws } = await openClient();
  const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
    sessionId: "sess-target-exact",
  });

  expect(resolved.ok).toBe(true);
  expect(resolved.payload?.key).toBe("agent:main:subagent:target");
});

test("sessions.resolve can probe a missing selector without returning an RPC error", async () => {
  await createSessionStoreDir();
  const { ws } = await openClient();

  const resolved = await rpcReq<{ ok: false }>(ws, "sessions.resolve", {
    key: "agent:main:missing",
    allowMissing: true,
  });

  expect(resolved.ok).toBe(true);
  expect(resolved.payload).toEqual({ ok: false });
});

test("sessions.resolve by key respects spawnedBy visibility filters", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  await writeSessionStore({
    entries: {
      "agent:main:subagent:visible-parent": {
        sessionId: "sess-visible-parent",
        updatedAt: now - 3_000,
        spawnedBy: "agent:main:main",
      },
      "agent:main:subagent:hidden-parent": {
        sessionId: "sess-hidden-parent",
        updatedAt: now - 2_000,
        spawnedBy: "agent:main:main",
      },
      "agent:main:subagent:shared-child-key-filter": {
        sessionId: "sess-shared-child-key-filter",
        updatedAt: now - 1_000,
        spawnedBy: "agent:main:subagent:hidden-parent",
      },
    },
  });

  const { ws } = await openClient();
  const resolved = await rpcReq(ws, "sessions.resolve", {
    key: "agent:main:subagent:shared-child-key-filter",
    spawnedBy: "agent:main:subagent:visible-parent",
  });

  expect(resolved.ok).toBe(false);
  expect(resolved.error?.message).toContain(
    "No session found: agent:main:subagent:shared-child-key-filter",
  );
});
