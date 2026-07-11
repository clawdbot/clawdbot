/**
 * Gateway session store RPC tests.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  persistSessionTranscriptTurn,
} from "../config/sessions/session-accessor.js";
import { agentDiscoveryMock, rpcReq, testState, writeSessionStore } from "./test-helpers.js";
import {
  directSessionReq as directSessionHandlerReq,
  setupGatewaySessionsTestHarness,
  getGatewayConfigModule,
  getSessionsHandlers,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir, openClient } = setupGatewaySessionsTestHarness();

async function seedLinearTranscript(params: {
  contents: string[];
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<void> {
  await persistSessionTranscriptTurn(
    {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    {
      updateMode: "none",
      messages: params.contents.map((content, index) => ({
        message: { role: "user", content, timestamp: index + 1 },
        now: Date.parse(`2026-06-19T12:00:${String(index + 1).padStart(2, "0")}.000Z`),
      })),
    },
  );
}

async function loadTranscriptRows(params: {
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<unknown[]> {
  return await loadTranscriptEvents({
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
}

test("lists and patches session store via sessions.* RPC", async () => {
  const { storePath } = await createSessionStoreDir();
  const now = Date.now();
  const recent = now - 30_000;
  const stale = now - 15 * 60_000;

  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-main",
        updatedAt: recent,
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
        inputTokens: 10,
        outputTokens: 20,
        thinkingLevel: "low",
        verboseLevel: "on",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        lastAccountId: "work",
        lastThreadId: "1737500000.123456",
      },
      "discord:group:dev": {
        sessionId: "sess-group",
        updatedAt: stale,
        totalTokens: 50,
      },
      "agent:main:subagent:one": {
        sessionId: "sess-subagent",
        updatedAt: stale,
        spawnedBy: "agent:main:main",
      },
      global: {
        sessionId: "sess-global",
        updatedAt: now - 10_000,
      },
    },
  });
  await seedLinearTranscript({
    contents: Array.from({ length: 10 }, (_, index) => `line ${index}`),
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
  });
  await seedLinearTranscript({
    contents: ["group line 0"],
    sessionId: "sess-group",
    sessionKey: "agent:main:discord:group:dev",
    storePath,
  });
  await expect(
    loadTranscriptRows({
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      storePath,
    }),
  ).resolves.toHaveLength(11);

  const { ws, hello } = await openClient();
  const methods = (hello as { features?: { methods?: string[] } }).features?.methods ?? [];
  expect(methods).toContain("sessions.list");
  expect(methods).toContain("sessions.preview");
  expect(methods).toContain("sessions.cleanup");
  expect(methods).toContain("sessions.patch");
  expect(methods).toContain("sessions.reset");
  expect(methods).toContain("sessions.delete");
  expect(methods).toContain("sessions.compact");
  const sessionsHandlers = await getSessionsHandlers();
  const { getRuntimeConfig } = await getGatewayConfigModule();
  const directContext = {
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    logGateway: { debug: vi.fn() },
    loadGatewayModelCatalog: async () => agentDiscoveryMock.models,
    getRuntimeConfig,
  };
  async function directSessionReq<TPayload = unknown>(
    method: keyof typeof sessionsHandlers,
    params: Record<string, unknown>,
    coercePayload?: (payload: unknown) => TPayload,
  ): Promise<{ ok: boolean; payload?: TPayload; error?: unknown }> {
    let result:
      | {
          ok: boolean;
          payload?: TPayload;
          error?: unknown;
        }
      | undefined;
    await sessionsHandlers[method]({
      req: {} as never,
      params,
      respond: (ok, payload, error) => {
        result = {
          ok,
          payload:
            payload === undefined
              ? undefined
              : coercePayload
                ? coercePayload(payload)
                : (payload as TPayload),
          error,
        };
      },
      context: directContext as never,
      client: null,
      isWebchatConnect: () => false,
    });
    if (!result) {
      throw new Error(`${method} did not respond`);
    }
    return result;
  }

  const resolvedByKey = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
    key: "main",
  });
  expect(resolvedByKey.ok).toBe(true);
  expect(resolvedByKey.payload?.key).toBe("agent:main:main");

  const resolvedBySessionId = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
    sessionId: "sess-group",
  });
  expect(resolvedBySessionId.ok).toBe(true);
  expect(resolvedBySessionId.payload?.key).toBe("agent:main:discord:group:dev");
  ws.close();

  const list1 = await directSessionReq<{
    path: string;
    defaults?: { model?: string | null; modelProvider?: string | null };
    sessions: Array<{
      key: string;
      totalTokens?: number;
      totalTokensFresh?: boolean;
      thinkingLevel?: string;
      verboseLevel?: string;
      lastAccountId?: string;
      deliveryContext?: { channel?: string; to?: string; accountId?: string };
    }>;
  }>("sessions.list", { includeGlobal: false, includeUnknown: false });

  expect(list1.ok).toBe(true);
  expect(list1.payload?.path).toBe(storePath);
  expect(list1.payload?.sessions.map((session) => session.key)).not.toContain("global");
  expect(list1.payload?.defaults?.modelProvider).toBe("anthropic");
  const main = list1.payload?.sessions.find((s) => s.key === "agent:main:main");
  expect(main?.totalTokens).toBeUndefined();
  expect(main?.totalTokensFresh).toBe(false);
  expect(main?.thinkingLevel).toBe("low");
  expect(main?.verboseLevel).toBe("on");
  expect(main?.lastAccountId).toBe("work");
  expect(main?.deliveryContext).toEqual({
    channel: "whatsapp",
    to: "+1555",
    accountId: "work",
    threadId: "1737500000.123456",
  });

  const active = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {
    includeGlobal: false,
    includeUnknown: false,
    activeMinutes: 5,
  });
  expect(active.ok).toBe(true);
  expect(active.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:main"]);

  const limited = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {
    includeGlobal: true,
    includeUnknown: false,
    limit: 1,
  });
  expect(limited.ok).toBe(true);
  expect(limited.payload?.sessions).toHaveLength(1);
  expect(limited.payload?.sessions[0]?.key).toBe("global");

  const patched = await directSessionReq<{ ok: true; key: string }>("sessions.patch", {
    key: "agent:main:main",
    thinkingLevel: "medium",
    verboseLevel: "off",
  });
  expect(patched.ok).toBe(true);
  expect(patched.payload?.ok).toBe(true);
  expect(patched.payload?.key).toBe("agent:main:main");

  const sendPolicyPatched = await directSessionReq<{
    ok: true;
    entry: { sendPolicy?: string };
  }>("sessions.patch", { key: "agent:main:main", sendPolicy: "deny" });
  expect(sendPolicyPatched.ok).toBe(true);
  expect(sendPolicyPatched.payload?.entry.sendPolicy).toBe("deny");

  const labelPatched = await directSessionReq<{
    ok: true;
    entry: { label?: string };
  }>("sessions.patch", {
    key: "agent:main:subagent:one",
    label: "Briefing",
  });
  expect(labelPatched.ok).toBe(true);
  expect(labelPatched.payload?.entry.label).toBe("Briefing");

  const labelPatchedDuplicate = await directSessionReq("sessions.patch", {
    key: "agent:main:discord:group:dev",
    label: "Briefing",
  });
  expect(labelPatchedDuplicate.ok).toBe(false);

  const mainArchive = await directSessionReq("sessions.patch", {
    key: "agent:main:main",
    archived: true,
  });
  expect(mainArchive.ok).toBe(false);

  const pinned = await directSessionReq<{
    entry: { pinnedAt?: number };
  }>("sessions.patch", {
    key: "agent:main:subagent:one",
    pinned: true,
  });
  expect(pinned.ok).toBe(true);
  expect(pinned.payload?.entry.pinnedAt).toEqual(expect.any(Number));

  const pinnedList = await directSessionReq<{
    sessions: Array<{ key: string; pinned?: boolean }>;
  }>("sessions.list", {});
  expect(pinnedList.payload?.sessions[0]).toMatchObject({
    key: "agent:main:subagent:one",
    pinned: true,
  });

  const archived = await directSessionReq<{
    entry: { archivedAt?: number; pinnedAt?: number };
  }>("sessions.patch", {
    key: "agent:main:subagent:one",
    archived: true,
  });
  expect(archived.ok).toBe(true);
  expect(archived.payload?.entry.archivedAt).toEqual(expect.any(Number));
  expect(archived.payload?.entry.pinnedAt).toBeUndefined();

  const activeAfterArchive = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {});
  expect(activeAfterArchive.payload?.sessions.map((session) => session.key)).not.toContain(
    "agent:main:subagent:one",
  );
  const archivedList = await directSessionReq<{
    sessions: Array<{ key: string; archived?: boolean }>;
  }>("sessions.list", { archived: true });
  expect(archivedList.payload?.sessions).toMatchObject([
    { key: "agent:main:subagent:one", archived: true },
  ]);

  const archivedSend = await directSessionReq("sessions.send", {
    key: "agent:main:subagent:one",
    message: "blocked while archived",
  });
  expect(archivedSend).toMatchObject({
    ok: false,
    error: {
      message:
        'Session "agent:main:subagent:one" is archived. Restore it before starting new work.',
    },
  });

  const cachedArchivedRunId = "cached-before-archive";
  directContext.dedupe.set(`chat:${cachedArchivedRunId}`, {
    ts: Date.now(),
    ok: true,
    payload: { runId: cachedArchivedRunId, status: "ok" },
  });
  const cachedArchivedSend = await directSessionReq("sessions.send", {
    key: "agent:main:subagent:one",
    message: "already completed before archive",
    idempotencyKey: cachedArchivedRunId,
  });
  expect(cachedArchivedSend).toMatchObject({
    ok: true,
    payload: { runId: cachedArchivedRunId, status: "ok" },
  });

  const archivedReset = await directSessionReq("sessions.reset", {
    key: "agent:main:subagent:one",
  });
  expect(archivedReset).toMatchObject({
    ok: false,
    error: {
      message:
        'Session "agent:main:subagent:one" is archived. Restore it before starting new work.',
    },
  });

  const restored = await directSessionReq<{
    entry: { archivedAt?: number };
  }>("sessions.patch", {
    key: "agent:main:subagent:one",
    archived: false,
  });
  expect(restored.ok).toBe(true);
  expect(restored.payload?.entry.archivedAt).toBeUndefined();

  const list2 = await directSessionReq<{
    sessions: Array<{
      key: string;
      thinkingLevel?: string;
      verboseLevel?: string;
      sendPolicy?: string;
      label?: string;
      displayName?: string;
    }>;
  }>("sessions.list", {});
  expect(list2.ok).toBe(true);
  const main2 = list2.payload?.sessions.find((s) => s.key === "agent:main:main");
  expect(main2?.thinkingLevel).toBe("medium");
  expect(main2?.verboseLevel).toBe("off");
  expect(main2?.sendPolicy).toBe("deny");
  const subagent = list2.payload?.sessions.find((s) => s.key === "agent:main:subagent:one");
  expect(subagent?.label).toBe("Briefing");
  expect(subagent?.displayName).toBe("Briefing");

  const clearedVerbose = await directSessionReq<{ ok: true; key: string }>("sessions.patch", {
    key: "agent:main:main",
    verboseLevel: null,
  });
  expect(clearedVerbose.ok).toBe(true);

  const list3 = await directSessionReq<{
    sessions: Array<{
      key: string;
      verboseLevel?: string;
    }>;
  }>("sessions.list", {});
  expect(list3.ok).toBe(true);
  const main3 = list3.payload?.sessions.find((s) => s.key === "agent:main:main");
  expect(main3?.verboseLevel).toBeUndefined();

  const listByLabel = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {
    includeGlobal: false,
    includeUnknown: false,
    label: "Briefing",
  });
  expect(listByLabel.ok).toBe(true);
  expect(listByLabel.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:subagent:one"]);

  const resolvedByLabel = await directSessionReq<{ ok: true; key: string }>("sessions.resolve", {
    label: "Briefing",
    agentId: "main",
  });
  expect(resolvedByLabel.ok).toBe(true);
  expect(resolvedByLabel.payload?.key).toBe("agent:main:subagent:one");

  const spawnedOnly = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {
    includeGlobal: true,
    includeUnknown: true,
    spawnedBy: "agent:main:main",
  });
  expect(spawnedOnly.ok).toBe(true);
  expect(spawnedOnly.payload?.sessions.map((s) => s.key)).toEqual(["agent:main:subagent:one"]);

  const spawnedPatched = await directSessionReq<{
    ok: true;
    entry: { spawnedBy?: string };
  }>("sessions.patch", {
    key: "agent:main:subagent:two",
    spawnedBy: "agent:main:main",
  });
  expect(spawnedPatched.ok).toBe(true);
  expect(spawnedPatched.payload?.entry.spawnedBy).toBe("agent:main:main");

  const acpPatched = await directSessionReq<{
    ok: true;
    entry: { spawnedBy?: string; spawnDepth?: number };
  }>("sessions.patch", {
    key: "agent:main:acp:child",
    spawnedBy: "agent:main:main",
    spawnDepth: 1,
  });
  expect(acpPatched.ok).toBe(true);
  expect(acpPatched.payload?.entry.spawnedBy).toBe("agent:main:main");
  expect(acpPatched.payload?.entry.spawnDepth).toBe(1);

  const spawnedPatchedInvalidKey = await directSessionReq("sessions.patch", {
    key: "agent:main:main",
    spawnedBy: "agent:main:main",
  });
  expect(spawnedPatchedInvalidKey.ok).toBe(false);

  const cleaned = await directSessionReq<{
    applied: true;
    missing: number;
    appliedCount: number;
  }>("sessions.cleanup", {
    enforce: true,
    fixMissing: true,
  });
  expect(cleaned.ok).toBe(true);
  expect(cleaned.payload?.missing).toBeGreaterThanOrEqual(1);
  const listAfterCleanup = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {});
  expect(listAfterCleanup.payload?.sessions.map((session) => session.key)).not.toContain(
    "agent:main:subagent:one",
  );

  agentDiscoveryMock.enabled = true;
  agentDiscoveryMock.models = [{ id: "gpt-test-a", name: "A", provider: "openai" }];
  const modelPatched = await directSessionReq<{
    ok: true;
    entry: {
      modelOverride?: string;
      providerOverride?: string;
      model?: string;
      modelProvider?: string;
    };
    resolved?: {
      model?: string;
      modelProvider?: string;
      agentRuntime?: { id: string; source: string };
    };
  }>("sessions.patch", {
    key: "agent:main:main",
    model: "openai/gpt-test-a",
  });
  expect(modelPatched.ok).toBe(true);
  expect(modelPatched.payload?.entry.modelOverride).toBe("gpt-test-a");
  expect(modelPatched.payload?.entry.providerOverride).toBe("openai");
  expect(modelPatched.payload?.entry.model).toBeUndefined();
  expect(modelPatched.payload?.entry.modelProvider).toBeUndefined();
  expect(modelPatched.payload?.resolved?.modelProvider).toBe("openai");
  expect(modelPatched.payload?.resolved?.model).toBe("gpt-test-a");
  expect(modelPatched.payload?.resolved?.agentRuntime).toEqual({
    id: "openclaw",
    source: "implicit",
  });

  const listAfterModelPatch = await directSessionReq<{
    sessions: Array<{
      key: string;
      modelProvider?: string;
      model?: string;
      agentRuntime?: { id: string; source: string };
    }>;
  }>("sessions.list", {});
  expect(listAfterModelPatch.ok).toBe(true);
  const mainAfterModelPatch = listAfterModelPatch.payload?.sessions.find(
    (session) => session.key === "agent:main:main",
  );
  expect(mainAfterModelPatch?.modelProvider).toBe("openai");
  expect(mainAfterModelPatch?.model).toBe("gpt-test-a");
  expect(mainAfterModelPatch?.agentRuntime).toEqual({ id: "openclaw", source: "implicit" });

  const compacted = await directSessionReq<{ ok: true; compacted: boolean }>("sessions.compact", {
    key: "agent:main:main",
    maxLines: 3,
  });
  expect(compacted.ok).toBe(true);
  expect(compacted.payload?.compacted).toBe(true);
  await expect(
    loadTranscriptRows({
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      storePath,
    }),
  ).resolves.toHaveLength(3);

  const deleted = await directSessionReq<{
    archived: string[];
    ok: true;
    deleted: boolean;
  }>("sessions.delete", { key: "agent:main:discord:group:dev" });
  expect(deleted.ok).toBe(true);
  expect(deleted.payload?.deleted).toBe(true);
  expect(deleted.payload?.archived).toHaveLength(1);
  expect(path.basename(deleted.payload?.archived[0] ?? "")).toMatch(
    /^sess-group\.jsonl\.deleted\./,
  );
  const listAfterDelete = await directSessionReq<{
    sessions: Array<{ key: string }>;
  }>("sessions.list", {});
  expect(listAfterDelete.ok).toBe(true);
  expect(listAfterDelete.payload?.sessions.map((session) => session.key)).not.toContain(
    "agent:main:discord:group:dev",
  );
  await expect(
    loadTranscriptRows({
      sessionId: "sess-group",
      sessionKey: "agent:main:discord:group:dev",
      storePath,
    }),
  ).resolves.toEqual([]);

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      sessionId: string;
      modelProvider?: string;
      model?: string;
      lastAccountId?: string;
      lastThreadId?: string | number;
    };
  }>("sessions.reset", { key: "agent:main:main" });
  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe("agent:main:main");
  expect(reset.payload?.entry.sessionId).not.toBe("sess-main");
  expect(reset.payload?.entry.modelProvider).toBe("openai");
  expect(reset.payload?.entry.model).toBe("gpt-test-a");
  expect(reset.payload?.entry.lastAccountId).toBe("work");
  expect(reset.payload?.entry.lastThreadId).toBe("1737500000.123456");
  const entryAfterReset = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
  expect(entryAfterReset?.lastAccountId).toBe("work");
  expect(entryAfterReset?.lastThreadId).toBe("1737500000.123456");
  await expect(
    loadTranscriptRows({
      sessionId: "sess-main",
      sessionKey: "agent:main:main",
      storePath,
    }),
  ).resolves.toEqual([]);

  const badThinking = await directSessionReq("sessions.patch", {
    key: "agent:main:main",
    thinkingLevel: "banana",
  });
  expect(badThinking.ok).toBe(false);
  expect((badThinking.error as { message?: unknown } | undefined)?.message ?? "").toMatch(
    /invalid thinkinglevel/i,
  );
});

test("sessions.list configuredAgentsOnly keeps configured-agent children and hides unrelated stores", async () => {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("OPENCLAW_STATE_DIR is required for gateway session tests");
  }
  testState.agentsConfig = { list: [{ id: "main", default: true }] };
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH is required for gateway session tests");
  }
  await fs.writeFile(
    configPath,
    JSON.stringify({ acp: { defaultAgent: "claude", allowedAgents: ["gemini"] } }, null, 2),
    "utf-8",
  );
  testState.sessionConfig = {
    store: path.join(stateDir, "agents", "{agentId}", "sessions", "sessions.json"),
  };

  const mainStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  const acpStorePath = path.join(stateDir, "agents", "claude", "sessions", "sessions.json");
  const childStorePath = path.join(stateDir, "agents", "codex", "sessions", "sessions.json");
  const diskOnlyStorePath = path.join(stateDir, "agents", "local", "sessions", "sessions.json");
  await writeSessionStore({
    storePath: mainStorePath,
    agentId: "main",
    entries: { main: { sessionId: "sess-main", updatedAt: 20 } },
  });
  await writeSessionStore({
    storePath: acpStorePath,
    agentId: "claude",
    entries: {
      "agent:claude:acp:25f77580-de30-4d80-9bc3-7cbc6374bce7": {
        sessionId: "sess-claude-acp",
        updatedAt: 30,
        acp: {
          backend: "acpx",
          agent: "claude",
          runtimeSessionName: "agent:claude:acp:25f77580-de30-4d80-9bc3-7cbc6374bce7",
          mode: "oneshot",
          state: "idle",
          lastActivityAt: 30,
        },
      },
    },
  });
  await writeSessionStore({
    storePath: childStorePath,
    agentId: "codex",
    entries: {
      "agent:codex:subagent:app-server-child": {
        sessionId: "sess-codex-child",
        updatedAt: 25,
        spawnedBy: "agent:main:main",
      },
    },
  });
  await writeSessionStore({
    storePath: diskOnlyStorePath,
    agentId: "local",
    entries: { main: { sessionId: "sess-local", updatedAt: 10 } },
  });

  const configuredOnly = await directSessionHandlerReq<{ sessions: Array<{ key: string }> }>(
    "sessions.list",
    { includeGlobal: false, includeUnknown: false, configuredAgentsOnly: true },
  );
  expect(configuredOnly.ok).toBe(true);
  expect(configuredOnly.payload?.sessions.map((session) => session.key)).toEqual([
    "agent:claude:acp:25f77580-de30-4d80-9bc3-7cbc6374bce7",
    "agent:codex:subagent:app-server-child",
    "agent:main:main",
  ]);

  const broad = await directSessionHandlerReq<{ sessions: Array<{ key: string }> }>(
    "sessions.list",
    { includeGlobal: false, includeUnknown: false },
  );
  expect(broad.ok).toBe(true);
  expect(broad.payload?.sessions.map((session) => session.key)).toEqual([
    "agent:claude:acp:25f77580-de30-4d80-9bc3-7cbc6374bce7",
    "agent:codex:subagent:app-server-child",
    "agent:main:main",
    "agent:local:main",
  ]);
});

test("sessions.list hides phantom agent store placeholder rows", async () => {
  await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      sessions: {},
      main: {
        sessionId: "sess-main",
        updatedAt: 20,
      },
    },
  });

  const listed = await directSessionHandlerReq<{ sessions: Array<{ key: string }> }>(
    "sessions.list",
    { includeGlobal: false, includeUnknown: false },
  );
  expect(listed.ok).toBe(true);
  expect(listed.payload?.sessions.map((session) => session.key)).toEqual(["agent:main:main"]);
});

test("write-scoped operators manage chat organization but not admin session settings", async () => {
  await createSessionStoreDir();
  const now = Date.now();
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt: now },
      "topic-a": {
        sessionId: "sess-topic-a",
        updatedAt: now - 60_000,
        // Stored channel-derived name; a user rename (label) must beat it.
        displayName: "channel topic",
      },
      "topic-b": { sessionId: "sess-topic-b", updatedAt: now - 30_000 },
    },
  });

  const { ws } = await openClient({ scopes: ["operator.read", "operator.write"] });
  try {
    const renamed = await rpcReq<{ ok: true; entry: { label?: string } }>(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      label: "Trip planning",
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.payload?.entry.label).toBe("Trip planning");

    const pinned = await rpcReq<{ ok: true; entry: { pinnedAt?: number } }>(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      pinned: true,
    });
    expect(pinned.ok).toBe(true);
    expect(pinned.payload?.entry.pinnedAt).toEqual(expect.any(Number));

    const organized = await rpcReq<{
      ok: true;
      entry: { category?: string; markedUnreadAt?: number };
    }>(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      category: "Travel",
      unread: true,
    });
    expect(organized.ok).toBe(true);
    expect(organized.payload?.entry.category).toBe("Travel");

    // Patched categories are absorbed into the gateway group catalog.
    const groupsAfterPatch = await rpcReq<{ groups: Array<{ name: string; position: number }> }>(
      ws,
      "sessions.groups.list",
      {},
    );
    expect(groupsAfterPatch.ok).toBe(true);
    expect(groupsAfterPatch.payload?.groups).toContainEqual({ name: "Travel", position: 0 });

    const reordered = await rpcReq<{ ok: true; groups: Array<{ name: string }> }>(
      ws,
      "sessions.groups.put",
      { names: ["Someday", "Travel"] },
    );
    expect(reordered.ok).toBe(true);
    expect(reordered.payload?.groups.map((group) => group.name)).toEqual(["Someday", "Travel"]);

    const renamedGroup = await rpcReq<{ ok: true; updatedSessions?: number }>(
      ws,
      "sessions.groups.rename",
      { name: "Travel", to: "Trips" },
    );
    expect(renamedGroup.ok).toBe(true);
    expect(renamedGroup.payload?.updatedSessions).toBe(1);
    const describedAfterRename = await rpcReq<{ session?: { category?: string } }>(
      ws,
      "sessions.describe",
      { key: "agent:main:topic-a" },
    );
    expect(describedAfterRename.ok).toBe(true);
    expect(describedAfterRename.payload?.session?.category).toBe("Trips");

    const deletedGroup = await rpcReq<{ ok: true; updatedSessions?: number }>(
      ws,
      "sessions.groups.delete",
      { name: "Trips" },
    );
    expect(deletedGroup.ok).toBe(true);
    expect(deletedGroup.payload?.updatedSessions).toBe(1);

    const archived = await rpcReq<{ ok: true; entry: { archivedAt?: number } }>(
      ws,
      "sessions.patch",
      { key: "agent:main:topic-b", archived: true },
    );
    expect(archived.ok).toBe(true);
    expect(archived.payload?.entry.archivedAt).toEqual(expect.any(Number));

    const searched = await rpcReq<{
      sessions: Array<{ key: string; pinned?: boolean; displayName?: string }>;
    }>(ws, "sessions.list", { search: "trip plan" });
    expect(searched.ok).toBe(true);
    expect(searched.payload?.sessions.map((session) => session.key)).toEqual([
      "agent:main:topic-a",
    ]);
    expect(searched.payload?.sessions[0]?.displayName).toBe("Trip planning");

    const archivedList = await rpcReq<{ sessions: Array<{ key: string }> }>(ws, "sessions.list", {
      archived: true,
    });
    expect(archivedList.ok).toBe(true);
    expect(archivedList.payload?.sessions.map((session) => session.key)).toEqual([
      "agent:main:topic-b",
    ]);

    const unflaggedDeleteDenied = await rpcReq(ws, "sessions.delete", {
      key: "agent:main:topic-b",
    });
    expect(unflaggedDeleteDenied.ok).toBe(false);
    expect(unflaggedDeleteDenied.error?.message).toContain("missing scope: operator.admin");

    const activeDeleteDenied = await rpcReq(ws, "sessions.delete", {
      key: "agent:main:topic-a",
      archivedOnly: true,
    });
    expect(activeDeleteDenied.ok).toBe(false);
    expect(activeDeleteDenied.error?.message).toContain("Archive it first");

    const archivedDeleted = await rpcReq<{ ok: true }>(ws, "sessions.delete", {
      key: "agent:main:topic-b",
      archivedOnly: true,
    });
    expect(archivedDeleted.ok).toBe(true);
    const archivedAfterDelete = await rpcReq<{ sessions: Array<{ key: string }> }>(
      ws,
      "sessions.list",
      { archived: true },
    );
    expect(archivedAfterDelete.payload?.sessions).toEqual([]);

    const adminFieldDenied = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      sendPolicy: "deny",
    });
    expect(adminFieldDenied.ok).toBe(false);
    expect(adminFieldDenied.error?.message).toContain("missing scope: operator.admin");

    const mixedFieldsDenied = await rpcReq(ws, "sessions.patch", {
      key: "agent:main:topic-a",
      label: "Sneaky",
      model: "anthropic/claude-sonnet-5",
    });
    expect(mixedFieldsDenied.ok).toBe(false);
    expect(mixedFieldsDenied.error?.message).toContain("missing scope: operator.admin");
  } finally {
    ws.close();
  }
});

test("sessions.list breaks timestamp ties by key for stable paging", async () => {
  await createSessionStoreDir();
  const updatedAt = Date.now() - 5_000;
  await writeSessionStore({
    entries: {
      main: { sessionId: "sess-main", updatedAt },
      "tie-c": { sessionId: "sess-tie-c", updatedAt },
      "tie-a": { sessionId: "sess-tie-a", updatedAt },
      "tie-b": { sessionId: "sess-tie-b", updatedAt },
    },
  });

  const expectedOrder = [
    "agent:main:main",
    "agent:main:tie-a",
    "agent:main:tie-b",
    "agent:main:tie-c",
  ];
  const listed = await directSessionHandlerReq<{ sessions: Array<{ key: string }> }>(
    "sessions.list",
    { includeGlobal: false, includeUnknown: false },
  );
  expect(listed.ok).toBe(true);
  expect(listed.payload?.sessions.map((session) => session.key)).toEqual(expectedOrder);

  const paged = await directSessionHandlerReq<{ sessions: Array<{ key: string }> }>(
    "sessions.list",
    { includeGlobal: false, includeUnknown: false, limit: 2, offset: 2 },
  );
  expect(paged.ok).toBe(true);
  expect(paged.payload?.sessions.map((session) => session.key)).toEqual(expectedOrder.slice(2));
});
