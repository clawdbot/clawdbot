// Sessions model resolution tests cover displayed model metadata for stored session records.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
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
  }>;
};

async function resolveSubagentModel(
  runtimeFields: Record<string, unknown>,
  sessionId: string,
): Promise<string | null | undefined> {
  return await withSqliteStore(
    "sessions-model",
    {
      "agent:research:subagent:demo": {
        sessionId,
        updatedAt: Date.now() - 2 * 60_000,
        ...runtimeFields,
      },
    },
    async (store) => {
      const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
      return payload.sessions?.find((row) => row.key === "agent:research:subagent:demo")?.model;
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

  it("separates Claude CLI runtime from canonical model provider in JSON output", async () => {
    setMockSessionsConfig(() => ({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-7" },
          models: {
            "anthropic/claude-opus-4-7": { agentRuntime: { id: "claude-cli" } },
          },
          contextTokens: 200_000,
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
          contextTokens: 200_000,
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
          contextTokens: 200_000,
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
});
