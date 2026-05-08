import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mockSessionsConfig,
  resetMockSessionsConfig,
  runSessionsJson,
  setMockSessionsConfig,
  writeStore,
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
  const store = writeStore(
    {
      "agent:research:subagent:demo": {
        sessionId,
        updatedAt: Date.now() - 2 * 60_000,
        ...runtimeFields,
      },
    },
    "sessions-model",
  );

  const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
  return payload.sessions?.find((row) => row.key === "agent:research:subagent:demo")?.model;
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
        modelProvider: "openai-codex",
        model: "gpt-5.4",
        modelOverride: "pi:opus",
      },
      "subagent-1",
    );
    expect(model).toBe("pi:opus");
  });

  it("falls back to modelOverride when runtime model is missing", async () => {
    const model = await resolveSubagentModel(
      { modelOverride: "openai-codex/gpt-5.4" },
      "subagent-2",
    );
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
    const store = writeStore(
      {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now() - 60_000,
          modelProvider: "claude-cli",
          model: "claude-opus-4-7",
        },
      },
      "sessions-claude-runtime",
    );

    const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
    const session = payload.sessions?.find((row) => row.key === "agent:main:main");

    expect(session?.modelProvider).toBe("anthropic");
    expect(session?.model).toBe("claude-opus-4-7");
    expect(session?.agentRuntime).toEqual({
      id: "claude-cli",
      source: "model",
    });
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
    const store = writeStore(
      {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now() - 60_000,
          modelProvider: "claude-cli",
          model: "claude-opus-4-7",
        },
      },
      "sessions-claude-runtime-openai-default",
    );

    const payload = await runSessionsJson<SessionsJsonPayload>(sessionsCommand, store);
    const session = payload.sessions?.find((row) => row.key === "agent:main:main");

    expect(session?.modelProvider).toBe("anthropic");
    expect(session?.model).toBe("claude-opus-4-7");
  });
});
