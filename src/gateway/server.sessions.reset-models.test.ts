/**
 * Gateway session reset model-selection tests.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { MODEL_SELECTION_LOCKED_RESET_MESSAGE } from "../sessions/model-overrides.js";
import { listSessionStateEventsSince } from "../sessions/session-state-events.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { testState, writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsTestHarness,
  sessionStoreEntry,
  directSessionReq,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsTestHarness();

type ResetSessionEntry = {
  sessionId?: string;
  sessionFile?: string;
  chatType?: string;
  delivery?: SessionEntry["delivery"];
  groupId?: string;
  subject?: string;
  groupChannel?: string;
  space?: string;
  spawnedBy?: string;
  spawnedWorkspaceDir?: string;
  spawnedCwd?: string;
  parentSessionKey?: string;
  createdVia?: string;
  createdActor?: { type: string; id?: string };
  createdAt?: number;
  forkSource?: { sessionKey: string; sessionId: string; entryId?: string };
  previousSessionId?: string;
  forkedFromParent?: boolean;
  spawnDepth?: number;
  subagentRole?: string;
  subagentControlScope?: string;
  elevatedLevel?: string;
  ttsAuto?: string;
  providerOverride?: string;
  modelOverride?: string;
  modelOverrideSource?: string;
  authProfileOverride?: string;
  modelProvider?: string;
  model?: string;
  authProfileOverrideSource?: string;
  authProfileOverrideCompactionCount?: number;
  fallbackNoticeSelectedModel?: string;
  fallbackNoticeActiveModel?: string;
  fallbackNoticeReason?: string;
  sendPolicy?: string;
  queueMode?: string;
  queueDebounceMs?: number;
  queueCap?: number;
  queueDrop?: string;
  groupActivation?: string;
  groupActivationNeedsSystemIntro?: boolean;
  execHost?: string;
  execSecurity?: string;
  execAsk?: string;
  execNode?: string;
  displayName?: string;
  cliSessionBindings?: Record<
    string,
    {
      sessionId?: string;
      authProfileId?: string;
      extraSystemPromptHash?: string;
      mcpConfigHash?: string;
    }
  >;
  cliSessionIds?: Record<string, string>;
  claudeCliSessionId?: string;
  label?: string;
};

type ModelResetEntry = Pick<
  ResetSessionEntry,
  "providerOverride" | "modelOverride" | "modelOverrideSource" | "modelProvider" | "model"
>;
type ResolvedSessionModel = { modelProvider: string; model: string };
type SessionEntryOverrides = NonNullable<Parameters<typeof sessionStoreEntry>[1]>;

test("sessions.reset stamps provenance when it materializes a missing row", async () => {
  await createSessionStoreDir();
  const reset = await directSessionReq<{ entry: ResetSessionEntry }>(
    "sessions.reset",
    { key: "agent:main:subagent:missing" },
    {
      client: {
        authenticatedUserProfile: { profileId: "profile-reset-creator" },
      } as never,
    },
  );

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry).toMatchObject({
    createdVia: "operator",
    createdActor: { type: "human", id: "profile-reset-creator" },
    createdAt: expect.any(Number),
  });
  expect(
    listSessionStateEventsSince("agent:main:subagent:missing", "main", 0, 20).events,
  ).toContainEqual(
    expect.objectContaining({
      kind: "created",
      actorType: "human",
      actorId: "profile-reset-creator",
    }),
  );
});

const ownedChildMetadata = {
  chatType: "group",
  delivery: normalizeSessionDeliveryState({
    context: {
      channel: "discord",
      to: "discord:child",
      accountId: "acct-1",
      threadId: "thread-1",
    },
    origin: { provider: "discord", chatType: "group" },
  }),
  groupId: "group-1",
  subject: "Ops Thread",
  groupChannel: "dev",
  space: "hq",
  spawnedBy: "agent:main:main",
  spawnedWorkspaceDir: "/tmp/child-workspace",
  spawnedCwd: "/tmp/task-repo",
  parentSessionKey: "agent:main:main",
  forkedFromParent: true,
  spawnDepth: 2,
  subagentRole: "orchestrator",
  subagentControlScope: "children",
  elevatedLevel: "on",
  ttsAuto: "always",
  providerOverride: "anthropic",
  modelOverride: "claude-opus-4-1",
  modelOverrideSource: "user",
  authProfileOverride: "work",
  authProfileOverrideSource: "user",
  authProfileOverrideCompactionCount: 7,
  sendPolicy: "deny",
  queueMode: "interrupt",
  queueDebounceMs: 250,
  queueCap: 9,
  queueDrop: "old",
  groupActivation: "always",
  groupActivationNeedsSystemIntro: true,
  execHost: "gateway",
  execSecurity: "allowlist",
  execAsk: "on-miss",
  execNode: "mac-mini",
  displayName: "Ops Child",
  cliSessionIds: {
    "claude-cli": "cli-session-123",
  },
  cliSessionBindings: {
    "claude-cli": {
      sessionId: "cli-session-123",
      authProfileId: "anthropic:work",
      extraSystemPromptHash: "prompt-hash",
    },
  },
  claudeCliSessionId: "cli-session-123",
  label: "owned child",
} satisfies SessionEntryOverrides & ResetSessionEntry;

function expectSqliteSessionFile(entry: ResetSessionEntry | undefined) {
  expect(entry?.sessionFile).toContain(`sqlite:main:${entry?.sessionId}:`);
}

function expectOwnedChildMetadata(entry: ResetSessionEntry | undefined) {
  expectSqliteSessionFile(entry);
  expect(entry).toMatchObject({
    ...ownedChildMetadata,
  });
}

async function expectMainResetModelFields(params: {
  defaultPrimary: string;
  sessionId: string;
  entry: SessionEntryOverrides & ModelResetEntry;
  expected: ModelResetEntry;
  expectedResolved: ResolvedSessionModel;
}) {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: params.defaultPrimary,
    },
  };

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(params.sessionId, params.entry),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: ModelResetEntry;
    resolved: ResolvedSessionModel;
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.resolved).toEqual(params.expectedResolved);
  const selectionKeys: Array<
    keyof Pick<ModelResetEntry, "providerOverride" | "modelOverride" | "modelOverrideSource">
  > = ["providerOverride", "modelOverride", "modelOverrideSource"];
  for (const key of selectionKeys) {
    expect(reset.payload?.entry?.[key]).toBe(params.expected[key]);
  }
  expect(reset.payload?.entry.modelProvider).toBe(params.expectedResolved.modelProvider);
  expect(reset.payload?.entry.model).toBe(params.expectedResolved.model);

  const stored = loadSessionEntry({ sessionKey: "agent:main:main", storePath }) as
    | ModelResetEntry
    | undefined;
  for (const key of selectionKeys) {
    expect(stored?.[key]).toBe(params.expected[key]);
  }
  expect(stored?.modelProvider).toBeUndefined();
  expect(stored?.model).toBeUndefined();
}

test("sessions.reset rejects a model-locked session without replacing native state", async () => {
  const { storePath } = await createSessionStoreDir();
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-model-locked", {
        agentHarnessId: "codex",
        modelSelectionLocked: true,
        pluginExtensions: {
          codex: { threadId: "codex-thread-1" },
        },
      }),
    },
  });
  const before = loadSessionEntry({ sessionKey: "agent:main:main", storePath });

  const reset = await directSessionReq("sessions.reset", { key: "main" });

  expect(reset).toMatchObject({
    ok: false,
    error: { message: MODEL_SELECTION_LOCKED_RESET_MESSAGE },
  });
  const after = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
  expect(after).toEqual(before);
});

test("sessions.reset recomputes model from defaults instead of stale runtime model", async () => {
  await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: "openai/gpt-test-a",
    },
  };

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-stale-model", {
        modelProvider: "qwencode",
        model: "qwen3.5-plus-2026-02-15",
        contextTokens: 123456,
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      sessionId: string;
      sessionFile?: string;
      modelProvider?: string;
      model?: string;
      contextTokens?: number;
    };
    resolved: ResolvedSessionModel;
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.key).toBe("agent:main:main");
  expect(reset.payload?.entry.sessionId).toBe("sess-stale-model");
  const sessionFile = reset.payload?.entry.sessionFile;
  if (!sessionFile) {
    throw new Error("expected reset session file");
  }
  expect(reset.payload?.resolved).toEqual({
    modelProvider: "openai",
    model: "gpt-test-a",
  });
  expect(reset.payload?.entry.modelProvider).toBe("openai");
  expect(reset.payload?.entry.model).toBe("gpt-test-a");
  expect(reset.payload?.entry.contextTokens).toBeUndefined();
  expect(sessionFile).toContain(`sqlite:main:${reset.payload?.entry.sessionId}:`);
});

test("sessions.reset clears stale estimated context budget status", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: "openai/gpt-test-a",
    },
  };

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-stale-budget", {
        totalTokens: 0,
        totalTokensFresh: false,
        contextTokens: 123456,
        contextBudgetStatus: {
          schemaVersion: 1,
          source: "pre-prompt-estimate",
          updatedAt: 1,
          provider: "qwencode",
          model: "qwen3.5-plus-2026-02-15",
          route: "compact_then_truncate",
          shouldCompact: true,
          estimatedPromptTokens: 120_000,
          contextTokenBudget: 80_000,
          promptBudgetBeforeReserve: 70_000,
          reserveTokens: 10_000,
          effectiveReserveTokens: 10_000,
          remainingPromptBudgetTokens: 0,
          overflowTokens: 50_000,
          toolResultReducibleChars: 0,
          messageCount: 10,
          unwindowedMessageCount: 10,
          sessionId: "sess-stale-budget",
        },
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    entry: {
      sessionId: string;
      contextBudgetStatus?: unknown;
      contextTokens?: number;
    };
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.sessionId).toBe("sess-stale-budget");
  expect(reset.payload?.entry.contextBudgetStatus).toBeUndefined();
  expect(reset.payload?.entry.contextTokens).toBeUndefined();

  const stored = loadSessionEntry({ sessionKey: "agent:main:main", storePath }) as
    | { contextBudgetStatus?: unknown; contextTokens?: number }
    | undefined;
  expect(stored?.contextBudgetStatus).toBeUndefined();
  expect(stored?.contextTokens).toBeUndefined();
});

test("sessions.reset drops cached skills snapshot so /new rebuilds visible skills", async () => {
  const { storePath } = await createSessionStoreDir();
  testState.agentConfig = {
    model: {
      primary: "openai/gpt-test-a",
    },
  };

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry("sess-stale-skills", {
        skillsSnapshot: {
          prompt: "<available_skills><skill><name>stale</name></skill></available_skills>",
          skills: [{ name: "stale" }],
          version: 0,
        },
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      sessionId: string;
      skillsSnapshot?: unknown;
    };
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.sessionId).toBe("sess-stale-skills");
  expect(reset.payload?.entry.skillsSnapshot).toBeUndefined();

  const stored = loadSessionEntry({ sessionKey: "agent:main:main", storePath }) as
    | { skillsSnapshot?: unknown }
    | undefined;
  expect(stored?.skillsSnapshot).toBeUndefined();
});

test("sessions.reset rotates generated topic transcript files with the new session id", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  const previousSessionId = "11111111-1111-4111-8111-111111111111";
  const previousSessionFile = path.join(dir, `${previousSessionId}-topic-456.jsonl`);
  await fs.writeFile(previousSessionFile, `${JSON.stringify({ role: "user", content: "old" })}\n`);

  await writeSessionStore({
    entries: {
      "agent:main:telegram:group:123:topic:456": sessionStoreEntry(previousSessionId, {
        sessionFile: previousSessionFile,
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      sessionId: string;
      sessionFile?: string;
    };
  }>("sessions.reset", {
    key: "agent:main:telegram:group:123:topic:456",
  });

  expect(reset.ok).toBe(true);
  const nextSessionId = reset.payload?.entry.sessionId;
  const nextSessionFile = reset.payload?.entry.sessionFile;
  if (!nextSessionId || !nextSessionFile) {
    throw new Error("expected reset session id and file");
  }
  expect(nextSessionId).toBe(previousSessionId);
  expect(nextSessionFile).toContain(`sqlite:main:${nextSessionId}:`);

  const persistedEntry = loadSessionEntry({
    sessionKey: "agent:main:telegram:group:123:topic:456",
    storePath,
  });
  expect(persistedEntry?.sessionId).toBe(nextSessionId);
  expect(persistedEntry?.sessionFile).toBe(nextSessionFile);
});

test("sessions.reset rotates an already-stale generated transcript file to the new session id", async () => {
  const { dir, storePath } = await createSessionStoreDir();
  // Post-upgrade state: the stored sessionFile still embeds an OLDER generated id
  // that no longer matches the entry's logical sessionId, so rotation must key off
  // the file's embedded id rather than the current sessionId (issue #77770).
  const staleFileSessionId = "11111111-1111-4111-8111-111111111111";
  const currentSessionId = "22222222-2222-4222-8222-222222222222";
  const staleSessionFile = path.join(dir, `${staleFileSessionId}.jsonl`);
  await fs.writeFile(staleSessionFile, `${JSON.stringify({ role: "user", content: "old" })}\n`);

  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(currentSessionId, {
        sessionFile: staleSessionFile,
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: {
      sessionId: string;
      sessionFile?: string;
    };
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  const nextSessionId = reset.payload?.entry.sessionId;
  const nextSessionFile = reset.payload?.entry.sessionFile;
  if (!nextSessionId || !nextSessionFile) {
    throw new Error("expected reset session id and file");
  }
  expect(nextSessionId).toBe(currentSessionId);
  expect(nextSessionFile).toContain(`sqlite:main:${nextSessionId}:`);
  expect(nextSessionFile).not.toContain(staleFileSessionId);

  const persistedEntry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
  expect(persistedEntry?.sessionId).toBe(nextSessionId);
  expect(persistedEntry?.sessionFile).toBe(nextSessionFile);
});

test("sessions.reset replaces a SQLite marker for a different transcript target", async () => {
  const { storePath } = await createSessionStoreDir();
  const sessionId = "current-session";
  const sessionKey = "agent:main:main";
  await writeSessionStore({
    entries: {
      main: sessionStoreEntry(sessionId),
    },
  });
  const current = loadSessionEntry({ sessionKey, storePath });
  if (!current) {
    throw new Error("expected current session entry");
  }
  const staleMarker = formatSqliteSessionFileMarker({
    agentId: "main",
    sessionId: "stale-session",
    storePath,
  });
  await replaceSessionEntry(
    { sessionKey, storePath },
    {
      ...current,
      sessionFile: staleMarker,
    },
  );

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: { sessionId: string; sessionFile?: string };
  }>("sessions.reset", { key: "main" });

  expect(reset.ok).toBe(true);
  expect(reset.payload?.entry.sessionId).toBe(sessionId);
  expect(reset.payload?.entry.sessionFile).toBe(
    formatSqliteSessionFileMarker({ agentId: "main", sessionId, storePath }),
  );
  expect(reset.payload?.entry.sessionFile).not.toBe(staleMarker);
});

test("sessions.reset preserves legacy explicit model overrides without modelOverrideSource", async () => {
  await expectMainResetModelFields({
    defaultPrimary: "openai/gpt-test-a",
    sessionId: "sess-explicit-model-override",
    entry: {
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-1",
      modelProvider: "openai",
      model: "gpt-test-a",
    },
    expected: {
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-1",
      modelOverrideSource: "user",
    },
    expectedResolved: { modelProvider: "anthropic", model: "claude-opus-4-1" },
  });
});

test("sessions.reset clears fallback-pinned model overrides and restores the selected model", async () => {
  await expectMainResetModelFields({
    defaultPrimary: "openai/gpt-test-a",
    sessionId: "sess-fallback-model-override",
    entry: {
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-1",
      modelOverrideSource: "auto",
      fallbackNoticeSelectedModel: "openai/gpt-test-a",
      fallbackNoticeActiveModel: "anthropic/claude-opus-4-1",
      fallbackNoticeReason: "rate limit",
    },
    expected: {
      providerOverride: undefined,
      modelOverride: undefined,
    },
    expectedResolved: { modelProvider: "openai", model: "gpt-test-a" },
  });
});

test("sessions.reset follows the updated default after an auto fallback pinned an older default", async () => {
  await expectMainResetModelFields({
    defaultPrimary: "openai/gpt-test-c",
    sessionId: "sess-fallback-stale-default",
    entry: {
      providerOverride: "anthropic",
      modelOverride: "claude-opus-4-1",
      modelOverrideSource: "auto",
      fallbackNoticeSelectedModel: "openai/gpt-test-a",
      fallbackNoticeActiveModel: "anthropic/claude-opus-4-1",
      fallbackNoticeReason: "rate limit",
    },
    expected: {
      providerOverride: undefined,
      modelOverride: undefined,
    },
    expectedResolved: { modelProvider: "openai", model: "gpt-test-c" },
  });
});

test("sessions.reset preserves spawned session ownership metadata", async () => {
  const { storePath } = await createSessionStoreDir();
  const customSessionFile = path.join(
    await fs.realpath(path.dirname(storePath)),
    "custom-owned-child-transcript.jsonl",
  );
  await writeSessionStore({
    entries: {
      "subagent:child": sessionStoreEntry("sess-owned-child", {
        sessionFile: customSessionFile,
        ...ownedChildMetadata,
        forkedFromParent: undefined,
        createdVia: "spawn",
        createdActor: { type: "agent", id: "agent:main:main" },
        createdAt: 1_000,
        forkSource: {
          sessionKey: "agent:main:root",
          sessionId: "root-session",
          entryId: "root-entry",
        },
      }),
    },
  });

  const reset = await directSessionReq<{
    ok: true;
    key: string;
    entry: ResetSessionEntry;
  }>("sessions.reset", { key: "subagent:child" });

  expect(reset.ok).toBe(true);
  expectOwnedChildMetadata(reset.payload?.entry);
  expect(reset.payload?.entry).toMatchObject({
    createdVia: "spawn",
    createdActor: { type: "agent", id: "agent:main:main" },
    createdAt: 1_000,
    forkSource: {
      sessionKey: "agent:main:root",
      sessionId: "root-session",
      entryId: "root-entry",
    },
  });

  const stored = loadSessionEntry({ sessionKey: "agent:main:subagent:child", storePath }) as
    | ResetSessionEntry
    | undefined;
  expectOwnedChildMetadata(stored);
  expect(stored).toMatchObject({
    createdVia: "spawn",
    createdActor: { type: "agent", id: "agent:main:main" },
    createdAt: 1_000,
    forkSource: {
      sessionKey: "agent:main:root",
      sessionId: "root-session",
      entryId: "root-entry",
    },
  });
});
