/**
 * Gateway session preview resolve tests.
 */
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, onTestFinished, test, vi } from "vitest";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import * as sessionHistoryEvents from "../config/sessions/session-accessor.sqlite-history-events.js";
import type { ControlUiSessionPreview } from "./control-ui-contract.js";
import type { GatewayClient } from "./server-methods/types.js";
import { createToolSummaryPreviewTranscriptLines } from "./session-preview.test-helpers.js";
import type { SessionsListResult } from "./session-utils.types.js";
import { rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  directSessionReq,
  getGatewayConfigModule,
  seedSessionTranscript,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, createSelectedGlobalSessionStore, openClient } =
  setupGatewaySessionsTestHarness();

test("lists and previews the selected aggregate global owner over WebSocket", async () => {
  const config = await getGatewayConfigModule();
  const runtime = config.getRuntimeConfigSnapshot();
  const source = config.getRuntimeConfigSourceSnapshot();
  const previous = {
    agentsConfig: testState.agentsConfig,
    sessionConfig: testState.sessionConfig,
    sessionStorePath: testState.sessionStorePath,
  };
  const configPaths = new Set([config.CONFIG_PATH]);
  if (process.env.OPENCLAW_CONFIG_PATH) {
    configPaths.add(process.env.OPENCLAW_CONFIG_PATH);
  }
  if (process.env.OPENCLAW_STATE_DIR) {
    configPaths.add(path.join(process.env.OPENCLAW_STATE_DIR, "openclaw.json"));
  }
  const files = new Map<string, Buffer | undefined>();
  for (const configPath of configPaths) {
    try {
      files.set(configPath, await fs.readFile(configPath));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        throw error;
      }
      files.set(configPath, undefined);
    }
  }
  onTestFinished(async () => {
    Object.assign(testState, previous);
    // The connected fixture publishes both config paths as well as its runtime snapshot.
    for (const [configPath, contents] of files) {
      if (contents === undefined) {
        await fs.rm(configPath, { force: true });
      } else {
        await fs.writeFile(configPath, contents);
      }
    }
    if (runtime) {
      config.setRuntimeConfigSnapshot(runtime, source ?? undefined);
    } else {
      config.clearRuntimeConfigSnapshot();
    }
  });
  const { workStorePath } = await createSelectedGlobalSessionStore();
  testState.agentsConfig = {
    entries: {
      main: { default: true, model: { primary: "openai/gpt-5.4" } },
      work: { model: { primary: "openai/gpt-5.5" } },
    },
  };
  const sessionId = "aggregate-work-global";
  await writeSessionStore({
    agentId: "work",
    storePath: workStorePath,
    entries: { global: sessionStoreEntry(sessionId, { label: "Work global conversation" }) },
  });
  await seedSessionTranscript({
    agentId: "work",
    sessionId,
    sessionKey: "global",
    storePath: workStorePath,
    messages: [{ role: "user", content: "Work global conversation" }],
  });
  const { ws } = await openClient();
  try {
    for (const search of [undefined, "gpt-5.5"]) {
      const listed = await rpcReq<SessionsListResult>(ws, "sessions.list", {
        includeGlobal: true,
        includeDerivedTitles: true,
        includeLastMessage: true,
        ...(search ? { search } : {}),
      });
      expect(listed.ok).toBe(true);
      expect(listed.payload?.sessions).toMatchObject([
        {
          key: "global",
          sessionId,
          agentId: "work",
          model: "gpt-5.5",
          derivedTitle: "Work global conversation",
          lastMessagePreview: "Work global conversation",
        },
      ]);
    }
    const preview = await rpcReq<ControlUiSessionPreview>(ws, "controlUi.sessionPreview", {
      sessionKey: "agent:work:main",
    });
    expect(preview).toMatchObject({
      ok: true,
      payload: { status: "ok", agentId: "work", derivedTitle: "Work global conversation" },
    });
    const resolved = await rpcReq(ws, "sessions.resolve", {
      label: "Work global conversation",
      includeGlobal: true,
    });
    expect(resolved).toMatchObject({
      ok: true,
      payload: { ok: true, key: "global", agentId: "work" },
    });
  } finally {
    if (ws.readyState !== ws.CLOSED) {
      const closed = once(ws, "close");
      ws.close();
      await closed;
    }
  }
});

async function seedPreviewTail(
  sessionId: string,
  messages: Array<{ role: string; content: string }>,
): Promise<void> {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: { "agent:main:main": sessionStoreEntry(sessionId) },
  });
  await sessionAccessor.persistSessionTranscriptTurn(
    { agentId: "main", sessionId, sessionKey: "agent:main:main", storePath },
    {
      messages: messages.map((message) => ({ message })),
      touchSessionEntry: false,
    },
  );
}

function identifiedClient(profileId: string, scopes: string[] = ["operator.read"]): GatewayClient {
  return {
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      client: {
        id: "openclaw-control-ui",
        version: "test",
        platform: "test",
        mode: "webchat",
      },
      role: "operator",
      scopes,
    },
    authenticatedUserId: `${profileId}@example.com`,
    authenticatedUserProfile: {
      profileId,
      displayName: profileId,
      hasAvatar: false,
      updatedAt: 1,
    },
  };
}

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
  expect(entry?.items).toEqual([
    { role: "user", text: "Hello" },
    { role: "assistant", text: "Hi" },
    { role: "assistant", text: "Forecast ready" },
  ]);
});

test("sessions.preview honors maxChars up to the shared cap", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "sess-preview-explicit-budget";
  const maxChars = 800;

  await writeSessionStore({
    entries: {
      "agent:main:main": sessionStoreEntry(sessionId),
    },
  });
  await seedSessionTranscript({
    sessionId,
    sessionKey: "agent:main:main",
    storePath,
    messages: [{ role: "assistant", content: "a".repeat(maxChars + 20) }],
  });

  const preview = await directSessionReq<{
    previews: Array<{ items: Array<{ role: string; text: string }> }>;
  }>("sessions.preview", { keys: ["main"], limit: 1, maxChars });

  expect(preview.ok).toBe(true);
  expect(preview.payload?.previews[0]?.items).toEqual([
    { role: "assistant", text: `${"a".repeat(maxChars - 3)}...` },
  ]);

  const capped = await directSessionReq<{
    previews: Array<{ items: Array<{ role: string; text: string }> }>;
  }>("sessions.preview", { keys: ["main"], limit: 1, maxChars: Number.MAX_SAFE_INTEGER });

  expect(capped.ok).toBe(true);
  expect(capped.payload?.previews[0]?.items).toEqual([
    { role: "assistant", text: `${"a".repeat(maxChars - 3)}...` },
  ]);
});

test("sessions.preview reads only a bounded tail from a large transcript", async () => {
  await seedPreviewTail(
    "sess-preview-bounded-tail",
    Array.from({ length: 1024 }, (_, index) => ({
      role: "assistant",
      content: `message ${String(index)}`,
    })),
  );
  const fullRead = vi.spyOn(sessionAccessor, "readSessionTranscriptMessageEvents");
  const tailRead = vi.spyOn(sessionHistoryEvents, "readRecentSessionTranscriptHistoryEvents");
  const storeRead = vi.spyOn(sessionAccessor, "listSessionEntriesCore");

  try {
    const preview = await directSessionReq<{
      previews: Array<{ items: Array<{ role: string; text: string }> }>;
    }>("sessions.preview", { keys: ["main"], limit: 12, maxChars: 120 });

    expect(preview.ok).toBe(true);
    expect(preview.payload?.previews[0]?.items).toEqual(
      Array.from({ length: 12 }, (_, index) => ({
        role: "assistant",
        text: `message ${String(1012 + index)}`,
      })),
    );
    expect(fullRead).not.toHaveBeenCalled();
    expect(storeRead).not.toHaveBeenCalled();
    expect(tailRead).toHaveBeenCalledOnce();
    expect(tailRead.mock.results[0]).toMatchObject({
      type: "return",
      value: { events: { length: 64 }, totalMessages: 1024 },
    });
  } finally {
    fullRead.mockRestore();
    tailRead.mockRestore();
    storeRead.mockRestore();
  }
});

test("sessions.preview widens its bounded tail past filtered tool-result rows", async () => {
  await seedPreviewTail("sess-preview-sparse-tail", [
    ...Array.from({ length: 12 }, (_, index) => ({
      role: "assistant",
      content: `visible ${String(index)}`,
    })),
    ...Array.from({ length: 320 }, (_, index) => ({
      role: "toolResult",
      content: `tool ${String(index)}`,
    })),
  ]);
  const tailRead = vi.spyOn(sessionHistoryEvents, "readRecentSessionTranscriptHistoryEvents");

  try {
    const preview = await directSessionReq<{
      previews: Array<{ items: Array<{ role: string; text: string }> }>;
    }>("sessions.preview", { keys: ["main"], limit: 12, maxChars: 120 });

    expect(preview.payload?.previews[0]?.items).toEqual(
      Array.from({ length: 12 }, (_, index) => ({
        role: "assistant",
        text: `visible ${String(index)}`,
      })),
    );
    expect(tailRead.mock.calls.map(([, options]) => options)).toEqual([
      { maxBytes: 1024 * 1024, maxLines: 64, maxMessages: 64 },
      { maxBytes: 8 * 1024 * 1024, maxLines: 1024, maxMessages: 1024 },
    ]);
  } finally {
    tailRead.mockRestore();
  }
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

test("sessions.resolve rejects a missing key by default", async () => {
  await createSessionStoreDir();
  const { ws } = await openClient();

  const resolved = await rpcReq(ws, "sessions.resolve", {
    key: "agent:main:missing",
  });

  expect(resolved.ok).toBe(false);
  expect(resolved.error?.message).toBe("No session found: agent:main:missing");
});

test("sessions.resolve returns short-id ambiguity as a protocol-success result", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      "agent:main:thread:12345678-0aaa-4000-8000-000000000001": {
        sessionId: "sess-short-newer",
        displayName: "Newer",
        updatedAt: 20,
      },
      "agent:main:thread:12345678-0bbb-4000-8000-000000000002": {
        sessionId: "sess-short-older",
        displayName: "Older",
        updatedAt: 10,
      },
    },
  });

  const resolved = await directSessionReq<{
    ok: false;
    candidates: Array<{ key: string; displayName?: string }>;
  }>("sessions.resolve", { shortId: "12345678" });

  expect(resolved.ok).toBe(true);
  expect(resolved.payload).toEqual({
    ok: false,
    candidates: [
      {
        agentId: "main",
        key: "agent:main:thread:12345678-0aaa-4000-8000-000000000001",
        displayName: "Newer",
      },
      {
        agentId: "main",
        key: "agent:main:thread:12345678-0bbb-4000-8000-000000000002",
        displayName: "Older",
      },
    ],
  });
});

test("sessions.resolve filters discovery selectors with sessions.list visibility", async () => {
  await createSessionStoreDir();
  const visibleKey = "agent:main:thread:12345678-0aaa-4000-8000-000000000001";
  const secondVisibleKey = "agent:main:thread:12345678-0ccc-4000-8000-000000000005";
  const hiddenCollisionKey = "agent:main:thread:12345678-0bbb-4000-8000-000000000002";
  const hiddenOnlyKey = "agent:main:thread:deadbeef-0aaa-4000-8000-000000000003";
  const incognitoKey = "agent:main:thread:cafebabe-0aaa-4000-8000-000000000004";
  await writeSessionStore({
    entries: {
      [visibleKey]: {
        sessionId: "sess-collision",
        label: "collision-label",
        displayName: "Visible session",
        updatedAt: 40,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: "owner" },
      },
      [hiddenCollisionKey]: {
        sessionId: "sess-collision",
        label: "collision-label",
        displayName: "Hidden collision",
        updatedAt: 30,
        visibility: "draft",
        createdActor: { type: "human", source: "profile", id: "owner" },
      },
      [secondVisibleKey]: {
        sessionId: "sess-second-visible",
        label: "second-visible",
        displayName: "Second visible session",
        updatedAt: 35,
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: "owner" },
      },
      [hiddenOnlyKey]: {
        sessionId: "sess-hidden-only",
        label: "hidden-only",
        displayName: "Hidden only",
        updatedAt: 20,
        visibility: "draft",
        createdActor: { type: "human", source: "profile", id: "owner" },
      },
      [incognitoKey]: {
        sessionId: "sess-incognito",
        label: "incognito-only",
        displayName: "Incognito only",
        updatedAt: 10,
        visibility: "shared",
        incognito: true,
        createdActor: { type: "human", source: "profile", id: "viewer" },
      },
    },
  });
  const client = identifiedClient("viewer");

  for (const params of [
    { shortId: "deadbeef" },
    { shortId: "cafebabe" },
    { sessionId: "sess-hidden-only" },
    { label: "hidden-only" },
  ]) {
    const hidden = await directSessionReq("sessions.resolve", params, { client });
    expect(hidden.ok).toBe(false);
    expect(hidden.error?.message).toContain("No session found");
  }

  const ambiguous = await directSessionReq<{
    ok: false;
    candidates: Array<{ key: string; displayName?: string }>;
  }>("sessions.resolve", { shortId: "12345678" }, { client });
  expect(ambiguous).toMatchObject({
    ok: true,
    payload: {
      ok: false,
      candidates: [{ key: visibleKey }, { key: secondVisibleKey }],
    },
  });

  for (const params of [{ sessionId: "sess-collision" }, { label: "collision-label" }]) {
    const resolved = await directSessionReq<{ ok: true; key: string }>("sessions.resolve", params, {
      client,
    });
    expect(resolved).toMatchObject({ ok: true, payload: { ok: true, key: visibleKey } });
  }

  const exactKey = await directSessionReq<{ ok: true; key: string }>(
    "sessions.resolve",
    { key: hiddenOnlyKey },
    { client },
  );
  expect(exactKey).toMatchObject({ ok: true, payload: { ok: true, key: hiddenOnlyKey } });

  for (const key of [hiddenOnlyKey, "agent:main:hidden-only"]) {
    const reference = await directSessionReq(
      "sessions.resolve",
      { reference: { key, slug: "hidden-only" }, agentId: "main", allowMissing: true },
      { client },
    );
    expect(reference).toMatchObject({ ok: true, payload: { ok: false } });
  }

  const ownerDraft = await directSessionReq<{ ok: true; key: string }>(
    "sessions.resolve",
    { shortId: "deadbeef" },
    { client: identifiedClient("owner") },
  );
  expect(ownerDraft).toMatchObject({ ok: true, payload: { ok: true, key: hiddenOnlyKey } });

  const adminIncognito = await directSessionReq<{ ok: true; key: string }>(
    "sessions.resolve",
    { shortId: "cafebabe" },
    { client: identifiedClient("admin", ["operator.admin"]) },
  );
  expect(adminIncognito).toMatchObject({ ok: true, payload: { ok: true, key: incognitoKey } });
});

test.each([
  { params: { shortId: "xyz" }, message: "shortId must be 8-32 hexadecimal characters" },
  { params: { label: "release", slugHint: "release" }, message: "slugHint requires shortId" },
])("sessions.resolve rejects invalid short-ref params: $message", async ({ params, message }) => {
  await createSessionStoreDir();

  const resolved = await directSessionReq("sessions.resolve", params);

  expect(resolved.ok).toBe(false);
  expect(resolved.error?.code).toBe("INVALID_REQUEST");
  expect(resolved.error?.message).toBe(message);
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
