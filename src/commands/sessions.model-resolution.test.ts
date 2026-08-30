// Sessions model resolution tests cover displayed model metadata for stored session records.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  mockSessionsConfig,
  resetMockSessionsConfig,
  runSessionsJson,
  setMockSessionsConfig,
} from "./sessions.test-helpers.js";

mockSessionsConfig();

import { sessionsCommand } from "./sessions.js";

type SessionsJsonPayload = {
  sessions?: Array<{
    key: string;
    modelProvider?: string | null;
    model?: string | null;
    agentRuntime?: { id: string; source: string };
    contextTokens?: number | null;
  }>;
};

async function resolveSubagentModel(
  runtimeFields: Record<string, unknown>,
  sessionId: string,
): Promise<string | null | undefined> {
  const sessionKey = "agent:main:subagent:demo";
  return await withSqliteStore(
    "sessions-model",
    {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now() - 2 * 60_000,
        ...runtimeFields,
      },
    },
    async (store) => {
      const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
      return payload.sessions?.find((row) => row.key === sessionKey)?.model;
    },
  );
}

async function withSqliteStore<T>(
  prefix: string,
  entries: Record<string, SessionEntry>,
  run: (storePath: string) => Promise<T>,
): Promise<T> {
  // Use a sessions.json-shaped path so the accessor targets the same SQLite
  // database layout that command code resolves from configured session stores.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const storePath = path.join(dir, "sessions.json");
  try {
    await Promise.all(
      Object.entries(entries).map(([sessionKey, entry]) =>
        replaceSessionEntry({ agentId: "main", sessionKey, storePath }, entry),
      ),
    );
    return await run(storePath);
  } finally {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

describe("sessionsCommand model resolution", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-06T00:00:00Z"));
  });

  afterEach(() => {
    resetMockSessionsConfig();
    vi.useRealTimers();
  });

  it("prefers the persisted override model for subagent sessions in JSON output", async () => {
    const model = await resolveSubagentModel(
      {
        modelProvider: "openai",
        model: "gpt-5.4",
        modelOverride: "test:opus",
      },
      "subagent-1",
    );
    expect(model).toBe("test:opus");
  });

  it("falls back to modelOverride when runtime model is missing", async () => {
    const model = await resolveSubagentModel({ modelOverride: "openai/gpt-5.4" }, "subagent-2");
    expect(model).toBe("gpt-5.4");
  });

  it.each([
    {
      name: "a nested router model",
      provider: "clawrouter",
      model: "openai/gpt-5.6",
      configured: false,
      expected: "openai/gpt-5.6",
    },
    {
      name: "a literal configured self-prefix",
      provider: "literal-provider",
      model: "literal-provider/model",
      configured: true,
      expected: "literal-provider/model",
    },
    {
      name: "an unconfigured legacy provider prefix",
      provider: "literal-provider",
      model: "literal-provider/model",
      configured: false,
      expected: "model",
    },
  ])("preserves $name in session JSON", async ({ provider, model, configured, expected }) => {
    if (configured) {
      setMockSessionsConfig(() => ({
        models: { providers: { [provider]: { models: [{ id: model }] } } },
      }));
    }
    const displayedModel = await resolveSubagentModel(
      { providerOverride: provider, modelOverride: model },
      "subagent-router-override",
    );
    expect(displayedModel).toBe(expected);
  });

  it("separates Claude CLI runtime from canonical model provider in JSON output", async () => {
    setMockSessionsConfig(() => ({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-7" },
          models: {
            "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    }));
    await withSqliteStore(
      "sessions-claude-runtime",
      {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now() - 60_000,
          modelProvider: "claude-cli",
          model: "claude-opus-4-7",
        },
      },
      async (store) => {
        const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
        const session = payload.sessions?.find((row) => row.key === "agent:main:main");

        expect(session?.modelProvider).toBe("anthropic");
        expect(session?.model).toBe("claude-opus-4-7");
        expect(session?.agentRuntime).toEqual({
          id: "claude-cli",
          source: "model",
        });
      },
    );
  });

  it("infers canonical provider for bare CLI models before default-provider fallback", async () => {
    setMockSessionsConfig(() => ({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.4" },
          models: {
            "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    }));
    await withSqliteStore(
      "sessions-claude-runtime-openai-default",
      {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now() - 60_000,
          modelProvider: "claude-cli",
          model: "claude-opus-4-7",
        },
      },
      async (store) => {
        const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
        const session = payload.sessions?.find((row) => row.key === "agent:main:main");

        expect(session?.modelProvider).toBe("anthropic");
        expect(session?.model).toBe("claude-opus-4-7");
      },
    );
  });

  it("reports the owning Codex harness for locked sessions despite a stale OpenClaw override", async () => {
    setMockSessionsConfig(() => ({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.5" },
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
    }));
    await withSqliteStore(
      "sessions-locked-codex-runtime",
      {
        "agent:main:main": {
          sessionId: "locked-codex-session",
          updatedAt: Date.now() - 60_000,
          modelProvider: "openai",
          model: "gpt-5.5",
          agentHarnessId: "codex",
          agentRuntimeOverride: "openclaw",
          modelSelectionLocked: true,
        },
      },
      async (store) => {
        const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
        const session = payload.sessions?.find((row) => row.key === "agent:main:main");

        expect(session?.agentRuntime).toEqual({
          id: "codex",
          source: "session",
        });
      },
    );
  });

  it("preserves a router-owned session's recorded model, runtime, and context window", async () => {
    setMockSessionsConfig(() => ({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6" },
          models: {
            "clawrouter/openai/gpt-5.6": { agentRuntime: { id: "openclaw" } },
            "openai/gpt-5.6": { agentRuntime: { id: "codex" } },
          },
        },
      },
      models: {
        providers: {
          clawrouter: { models: [{ id: "openai/gpt-5.6", contextTokens: 272_000 }] },
          openai: {
            models: [{ id: "gpt-5.6", contextTokens: 1_000_000, contextWindow: 1_050_000 }],
          },
        },
      },
    }));
    const sessionKey = "agent:main:main";
    const sessionEntry = {
      sessionId: "router-owned-session",
      updatedAt: Date.now() - 60_000,
      modelProvider: "clawrouter",
      model: "openai/gpt-5.6",
      agentHarnessId: "openclaw",
      contextTokens: 272_000,
      contextTokensSource: "runtime",
    } satisfies SessionEntry;

    await withSqliteStore(
      "sessions-router-owned-runtime-context",
      { [sessionKey]: sessionEntry },
      async (store) => {
        const databasePath = resolveSqliteTargetFromSessionStorePath(store, {
          agentId: "main",
        }).path;
        const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
        const db = getNodeSqliteKysely<
          Pick<OpenClawAgentKyselyDatabase, "session_nodes" | "session_windows">
        >(database.db);
        const persisted = executeSqliteQueryTakeFirstSync(
          database.db,
          db
            .selectFrom("session_windows")
            .innerJoin("session_nodes", "session_nodes.session_key", "session_windows.session_key")
            .select([
              "session_windows.model_provider as modelProvider",
              "session_windows.model as model",
              "session_windows.agent_harness_id as agentHarnessId",
              "session_nodes.session_key as sessionKey",
              "session_nodes.current_session_id as sessionId",
              "session_nodes.entry_json as entryJson",
            ])
            .where("session_windows.session_id", "=", sessionEntry.sessionId),
        );

        expect(persisted).toEqual({
          modelProvider: "clawrouter",
          model: "openai/gpt-5.6",
          agentHarnessId: "openclaw",
          sessionKey,
          sessionId: sessionEntry.sessionId,
          entryJson: expect.any(String),
        });
        expect(JSON.parse(persisted?.entryJson ?? "{}")).toMatchObject(sessionEntry);

        const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
        const session = payload.sessions?.find((row) => row.key === sessionKey);

        expect(session).toMatchObject({
          modelProvider: "clawrouter",
          model: "openai/gpt-5.6",
          agentRuntime: { id: "openclaw", source: "session" },
          contextTokens: 272_000,
        });
      },
    );
  });

  it("preserves recorded runtime while projecting current context after a harness change", async () => {
    setMockSessionsConfig(() => ({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
          },
        },
      },
      models: {
        providers: {
          openai: {
            models: [{ id: "gpt-5.6-sol", contextTokens: 1_000_000, contextWindow: 1_050_000 }],
          },
        },
      },
    }));
    await withSqliteStore(
      "sessions-current-runtime-context",
      {
        "agent:main:main": {
          sessionId: "stale-openclaw-window",
          updatedAt: Date.now() - 60_000,
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          agentHarnessId: "openclaw",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
        },
      },
      async (store) => {
        const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
        const session = payload.sessions?.find((row) => row.key === "agent:main:main");

        expect(session?.agentRuntime).toEqual({ id: "openclaw", source: "session" });
        expect(session?.contextTokens).toBe(1_000_000);
      },
    );
  });

  it("keeps matching runtime telemetry below a higher native window", async () => {
    setMockSessionsConfig(() => ({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
          },
        },
      },
      models: {
        providers: {
          openai: { models: [{ id: "gpt-5.6-sol", contextWindow: 1_000_000 }] },
        },
      },
    }));
    await withSqliteStore(
      "sessions-matching-runtime-context",
      {
        "agent:main:main": {
          sessionId: "matching-codex-window",
          updatedAt: Date.now() - 60_000,
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          agentHarnessId: "codex",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
        },
      },
      async (store) => {
        const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
        expect(payload.sessions?.[0]?.contextTokens).toBe(272_000);
      },
    );
  });

  it("keeps no-snapshot context resolution scoped to the selected provider", async () => {
    setMockSessionsConfig(() => ({
      agents: {
        defaults: {
          model: { primary: "provider-a/shared-model" },
          models: {
            "provider-a/shared-model": {},
            "provider-b/shared-model": {},
          },
        },
      },
      models: {
        providers: {
          "provider-a": { models: [{ id: "shared-model", contextTokens: 128_000 }] },
          "provider-b": { models: [{ id: "shared-model", contextTokens: 900_000 }] },
        },
      },
    }));
    await withSqliteStore(
      "sessions-provider-scoped-context",
      {
        "agent:main:main": {
          sessionId: "provider-a-context",
          updatedAt: Date.now() - 60_000,
          modelProvider: "provider-a",
          model: "shared-model",
        },
      },
      async (store) => {
        const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
        expect(payload.sessions?.[0]?.contextTokens).toBe(128_000);
      },
    );
  });

  it("preserves a locked runtime window above current configuration", async () => {
    setMockSessionsConfig(() => ({
      agents: {
        defaults: {
          model: { primary: "openai/gpt-5.6-sol" },
          models: {
            "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
          },
        },
      },
      models: {
        providers: {
          openai: { models: [{ id: "gpt-5.6-sol", contextTokens: 272_000 }] },
        },
      },
    }));
    await withSqliteStore(
      "sessions-locked-runtime-context",
      {
        "agent:main:main": {
          sessionId: "locked-codex-window",
          updatedAt: Date.now() - 60_000,
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          agentHarnessId: "codex",
          contextTokens: 1_000_000,
          modelSelectionLocked: true,
        },
      },
      async (store) => {
        const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
        expect(payload.sessions?.[0]?.agentRuntime).toEqual({ id: "codex", source: "session" });
        expect(payload.sessions?.[0]?.contextTokens).toBe(1_000_000);
      },
    );
  });
});
