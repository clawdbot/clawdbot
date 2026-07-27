/**
 * Gateway session preview resolve tests.
 */
import path from "node:path";
import { expect, test } from "vitest";
import {
  applySessionEntryLifecycleMutation,
  listSessionEntries,
  loadSessionEntry,
} from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createToolSummaryPreviewTranscriptLines } from "./session-preview.test-helpers.js";
import { rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  getMainPreviewEntry,
  directSessionReq,
  loadSeededTranscriptEvents,
  seedLinearSessionTranscript,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

async function replaceSessionEntries(
  storePath: string,
  entries: Record<string, Partial<SessionEntry>>,
  agentId = "main",
): Promise<void> {
  clearSessionStoreCacheForTest();
  await applySessionEntryLifecycleMutation({
    agentId,
    storePath,
    removals: listSessionEntries({ agentId, storePath }).map(({ sessionKey }) => ({ sessionKey })),
    upserts: Object.entries(entries).map(([sessionKey, entry]) => ({
      sessionKey,
      entry: {
        updatedAt: 0,
        ...entry,
        sessionId: entry.sessionId ?? sessionKey,
      },
    })),
    skipMaintenance: true,
  });
  clearSessionStoreCacheForTest();
}

async function previewMainAliasFromStore(params: {
  transcripts: Record<string, string>;
  store: Record<string, { sessionId: string; updatedAt: number }>;
}): Promise<Awaited<ReturnType<typeof getMainPreviewEntry>>> {
  const { dir } = await createSessionStoreDir();
  const storePath = path.join(dir, "agents", "ops", "sessions", "sessions.json");
  testState.sessionStorePath = storePath;
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  testState.sessionConfig = { mainKey: "work" };

  await writeSessionStore({ agentId: "ops", entries: {} });
  await replaceSessionEntries(storePath, params.store, "ops");
  for (const [sessionKey, entry] of Object.entries(params.store)) {
    const content = params.transcripts[entry.sessionId];
    if (content) {
      await seedSessionTranscript({
        agentId: "ops",
        sessionId: entry.sessionId,
        sessionKey,
        storePath,
        messages: [{ role: "assistant", content }],
      });
    }
  }

  const { ws } = await openClient();
  try {
    return await getMainPreviewEntry(ws);
  } finally {
    ws.close();
  }
}

test("sessions.preview returns transcript previews", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-preview";
  const lines = createToolSummaryPreviewTranscriptLines(sessionId);

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(sessionId),
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

test("sessions.preview resolves legacy main alias with custom mainKey", async () => {
  const sessionId = "sess-legacy-main";

  const entry = await previewMainAliasFromStore({
    transcripts: {
      [sessionId]: "Legacy alias transcript",
    },
    store: {
      "agent:ops:main": {
        sessionId,
        updatedAt: Date.now(),
      },
    },
  });
  expect(entry?.items[0]?.text).toContain("Legacy alias transcript");
});

test("sessions.preview prefers the freshest duplicate row for a legacy main alias", async () => {
  const entry = await previewMainAliasFromStore({
    transcripts: {
      "sess-stale-main": "stale preview",
      "sess-fresh-main": "fresh preview",
    },
    store: {
      "agent:ops:work": {
        sessionId: "sess-stale-main",
        updatedAt: 1,
      },
      "agent:ops:main": {
        sessionId: "sess-fresh-main",
        updatedAt: 2,
      },
    },
  });
  expect(entry?.items[0]?.text).toContain("fresh preview");
});

test("sessions.resolve and mutators clean legacy main-alias ghost keys", async () => {
  const { dir } = await createSessionStoreDir();
  const storePath = path.join(dir, "agents", "ops", "sessions", "sessions.json");
  testState.sessionStorePath = storePath;
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  testState.sessionConfig = { mainKey: "work" };
  const sessionId = "sess-alias-cleanup";
  await writeSessionStore({ agentId: "ops", entries: {} });
  await seedLinearSessionTranscript({
    agentId: "ops",
    contents: Array.from({ length: 8 }, (_, index) => `line ${index}`),
    sessionId,
    sessionKey: "agent:ops:work",
    storePath,
  });

  const writeRawStore = async (store: Record<string, Partial<SessionEntry>>) => {
    await replaceSessionEntries(storePath, store, "ops");
  };
  const readStoreKeys = () =>
    listSessionEntries({ agentId: "ops", storePath }).map(({ sessionKey }) => sessionKey);
  const readWorkEntry = () =>
    loadSessionEntry({
      agentId: "ops",
      sessionKey: "agent:ops:work",
      storePath,
    });

  await writeRawStore({
    "agent:ops:main": { sessionId, updatedAt: Date.now() - 1_000 },
  });

  const { ws } = await openClient();

  const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
    key: "main",
  });
  expect(resolved.ok).toBe(true);
  expect(resolved.payload?.key).toBe("agent:ops:work");
  expect(readStoreKeys().toSorted()).toEqual(["agent:ops:work"]);

  await writeRawStore({
    "agent:ops:work": readWorkEntry() ?? { sessionId },
    "agent:ops:main": readWorkEntry() ?? { sessionId },
  });
  const patched = await rpcReq<{ ok: true; key: string }>(ws, "sessions.patch", {
    key: "main",
    thinkingLevel: "medium",
  });
  expect(patched.ok).toBe(true);
  expect(patched.payload?.key).toBe("agent:ops:work");
  expect(readStoreKeys().toSorted()).toEqual(["agent:ops:work"]);
  expect(readWorkEntry()?.thinkingLevel).toBe("medium");

  await writeRawStore({
    "agent:ops:work": readWorkEntry() ?? { sessionId },
    "agent:ops:main": readWorkEntry() ?? { sessionId },
  });
  const compacted = await rpcReq<{ ok: true; compacted: boolean }>(ws, "sessions.compact", {
    key: "main",
    maxLines: 3,
  });
  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(true);
  expect(readStoreKeys().toSorted()).toEqual(["agent:ops:work"]);
  const compactedEvents = await loadSeededTranscriptEvents({
    agentId: "ops",
    sessionId,
    sessionKey: "agent:ops:work",
    storePath,
  });
  expect(
    compactedEvents
      .map((event) =>
        event && typeof event === "object" && "message" in event
          ? (event as { message?: { content?: unknown } }).message?.content
          : undefined,
      )
      .filter((content) => content !== undefined),
  ).toEqual(["line 6", "line 7"]);

  await writeRawStore({
    "agent:ops:work": readWorkEntry() ?? { sessionId },
    "agent:ops:main": readWorkEntry() ?? { sessionId },
  });
  const reset = await rpcReq<{ ok: true; key: string }>(ws, "sessions.reset", { key: "main" });
  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe("agent:ops:work");
  expect(readStoreKeys().toSorted()).toEqual(["agent:ops:work"]);

  ws.close();
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
