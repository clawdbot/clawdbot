import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { createToolSummaryPreviewTranscriptLines } from "./session-preview.test-helpers.js";
import { rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  getMainPreviewEntry,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

test("sessions.preview returns transcript previews", async () => {
  const { dir } = await createSessionStoreDir();
  const sessionId = "sess-preview";
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  const lines = createToolSummaryPreviewTranscriptLines(sessionId);
  await fs.writeFile(transcriptPath, lines.join("\n"), "utf-8");

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(sessionId),
    },
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

test("sessions.preview resolves legacy mixed-case main alias with custom mainKey", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  testState.sessionConfig = { mainKey: "work" };
  const sessionId = "sess-legacy-main";
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({ type: "session", version: 1, id: sessionId }),
    JSON.stringify({ message: { role: "assistant", content: "Legacy alias transcript" } }),
  ];
  await fs.writeFile(transcriptPath, lines.join("\n"), "utf-8");
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        "agent:ops:MAIN": {
          sessionId,
          updatedAt: Date.now(),
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const { ws } = await openClient();
  const entry = await getMainPreviewEntry(ws);
  expect(entry?.items[0]?.text).toContain("Legacy alias transcript");

  ws.close();
});

test("sessions.preview prefers the freshest duplicate row for a legacy mixed-case main alias", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  testState.sessionConfig = { mainKey: "work" };

  const staleTranscriptPath = path.join(dir, "sess-stale-main.jsonl");
  const freshTranscriptPath = path.join(dir, "sess-fresh-main.jsonl");
  await fs.writeFile(
    staleTranscriptPath,
    [
      JSON.stringify({ type: "session", version: 1, id: "sess-stale-main" }),
      JSON.stringify({ message: { role: "assistant", content: "stale preview" } }),
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(
    freshTranscriptPath,
    [
      JSON.stringify({ type: "session", version: 1, id: "sess-fresh-main" }),
      JSON.stringify({ message: { role: "assistant", content: "fresh preview" } }),
    ].join("\n"),
    "utf-8",
  );
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        "agent:ops:work": {
          sessionId: "sess-stale-main",
          updatedAt: 1,
        },
        "agent:ops:WORK": {
          sessionId: "sess-fresh-main",
          updatedAt: 2,
        },
      },
      null,
      2,
    ),
    "utf-8",
  );

  const { ws } = await openClient();
  const entry = await getMainPreviewEntry(ws);
  expect(entry?.items[0]?.text).toContain("fresh preview");

  ws.close();
});

test("sessions.resolve and mutators clean legacy main-alias ghost keys", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  testState.agentsConfig = { list: [{ id: "ops", default: true }] };
  testState.sessionConfig = { mainKey: "work" };
  const sessionId = "sess-alias-cleanup";
  const transcriptPath = path.join(dir, `${sessionId}.jsonl`);
  await fs.writeFile(
    transcriptPath,
    `${Array.from({ length: 8 })
      .map((_, idx) => JSON.stringify({ role: "assistant", content: `line ${idx}` }))
      .join("\n")}\n`,
    "utf-8",
  );

  const writeRawStore = async (store: Record<string, unknown>) => {
    await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  };
  const readStore = async () =>
    JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, Record<string, unknown>>;

  await writeRawStore({
    "agent:ops:MAIN": { sessionId, updatedAt: Date.now() - 2_000 },
    "agent:ops:Main": { sessionId, updatedAt: Date.now() - 1_000 },
  });

  const { ws } = await openClient();

  const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
    key: "main",
  });
  expect(resolved.ok).toBe(true);
  expect(resolved.payload?.key).toBe("agent:ops:work");
  let store = await readStore();
  expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);

  await writeRawStore({
    ...store,
    "agent:ops:MAIN": { ...store["agent:ops:work"] },
  });
  const patched = await rpcReq<{ ok: true; key: string }>(ws, "sessions.patch", {
    key: "main",
    thinkingLevel: "medium",
  });
  expect(patched.ok).toBe(true);
  expect(patched.payload?.key).toBe("agent:ops:work");
  store = await readStore();
  expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);
  expect(store["agent:ops:work"]?.thinkingLevel).toBe("medium");

  await writeRawStore({
    ...store,
    "agent:ops:MAIN": { ...store["agent:ops:work"] },
  });
  const compacted = await rpcReq<{ ok: true; compacted: boolean }>(ws, "sessions.compact", {
    key: "main",
    maxLines: 3,
  });
  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(true);
  store = await readStore();
  expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);

  await writeRawStore({
    ...store,
    "agent:ops:MAIN": { ...store["agent:ops:work"] },
  });
  const reset = await rpcReq<{ ok: true; key: string }>(ws, "sessions.reset", { key: "main" });
  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe("agent:ops:work");
  store = await readStore();
  expect(Object.keys(store).toSorted()).toEqual(["agent:ops:work"]);

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
