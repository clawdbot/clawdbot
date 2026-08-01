// Session search tests cover gateway session rows, transcript usage summaries,
// subagent state, model context limits, and cost/token display metadata.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { ANTHROPIC_CONTEXT_1M_TOKENS } from "../agents/context-resolution.js";
import { resetSubagentRegistryForTests } from "../agents/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import {
  appendTranscriptMessageSync,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { listSessionsFromStoreForTest as listSessionsFromStore } from "./session-utils-list.test-support.js";
import { buildGatewaySessionInfo } from "./session-utils.js";

const MAIN_SESSION_KEY = "agent:main:main";
const MAIN_SESSION_ID = "sess-main";
const TRANSCRIPT_TOTAL_TOKENS = 3_200;
const TRANSCRIPT_COST_USD = 0.007725;
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

type TranscriptUsageFixture = {
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  costTotal: number;
};

const ANTHROPIC_USAGE: TranscriptUsageFixture = {
  provider: "anthropic",
  model: ANTHROPIC_MODEL,
  input: 2_000,
  output: 500,
  cacheRead: 1_200,
  costTotal: TRANSCRIPT_COST_USD,
};

function createModelDefaultsConfig(params: {
  primary: string;
  models?: Record<string, Record<string, never>>;
}): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: params.primary },
        models: params.models,
      },
    },
  } as OpenClawConfig;
}

function closeSessionSqliteDatabasesForTest(): void {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}

function createLegacyRuntimeListConfig(
  models?: Record<string, Record<string, never>>,
): OpenClawConfig {
  return createModelDefaultsConfig({
    primary: "google-gemini-cli/gemini-3.1-pro-preview",
    ...(models ? { models } : {}),
  });
}

function createLegacyRuntimeStore(model: string): Record<string, SessionEntry> {
  return {
    "agent:main:main": {
      sessionId: "sess-main",
      updatedAt: Date.now(),
      model,
    } as SessionEntry,
  };
}

function buildLegacyRuntimeRow(cfg: OpenClawConfig, model: string) {
  const store = createLegacyRuntimeStore(model);
  return buildGatewaySessionInfo({
    cfg,
    storePath: "/tmp/sessions.json",
    store,
    key: MAIN_SESSION_KEY,
    entry: store[MAIN_SESSION_KEY],
  });
}

type DefaultTranscriptFixtureParams<T> = {
  prefix: string;
  transcriptId?: string;
  run: (fixture: { storePath: string; now: number }) => Promise<T> | T;
};

function appendUsageTranscriptMessage(params: {
  sessionId: string;
  sessionKey: string;
  storePath: string;
  usage: TranscriptUsageFixture;
}) {
  appendTranscriptMessageSync(
    {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
    },
    {
      message: {
        role: "assistant",
        provider: params.usage.provider,
        model: params.usage.model,
        usage: {
          input: params.usage.input,
          output: params.usage.output,
          cacheRead: params.usage.cacheRead,
          cost: { total: params.usage.costTotal },
        },
      },
    },
  );
}

async function withTranscriptFixture<T>(
  usage: TranscriptUsageFixture,
  params: DefaultTranscriptFixtureParams<T>,
): Promise<T> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), params.prefix));
  const storePath = path.join(tmpDir, "sessions.json");
  const transcriptId = params.transcriptId ?? MAIN_SESSION_ID;
  const now = Date.now();

  try {
    await replaceSessionEntry(
      {
        agentId: "main",
        sessionKey: MAIN_SESSION_KEY,
        storePath,
      },
      { sessionId: transcriptId, updatedAt: now },
    );
    appendUsageTranscriptMessage({
      sessionId: transcriptId,
      sessionKey: MAIN_SESSION_KEY,
      storePath,
      usage,
    });
    return await params.run({ storePath, now });
  } finally {
    closeSessionSqliteDatabasesForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const withAnthropicTranscriptFixture = <T>(params: DefaultTranscriptFixtureParams<T>) =>
  withTranscriptFixture(ANTHROPIC_USAGE, params);

function createAnthropicContext1mConfig(): OpenClawConfig {
  return {
    session: { mainKey: "main" },
    agents: {
      list: [{ id: "main", default: true }],
      defaults: {
        models: {
          [`anthropic/${ANTHROPIC_MODEL}`]: { params: { context1m: true } },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

async function listSingleSession(params: {
  cfg: OpenClawConfig;
  storePath: string;
  key: string;
  entry: SessionEntry;
}) {
  return await listSessionsFromStore({
    cfg: params.cfg,
    storePath: params.storePath,
    store: {
      [params.key]: params.entry,
    },
    opts: {},
  });
}

async function listMainSession(params: {
  cfg: OpenClawConfig;
  storePath: string;
  entry: SessionEntry;
}) {
  return await listSingleSession({
    cfg: params.cfg,
    storePath: params.storePath,
    key: MAIN_SESSION_KEY,
    entry: params.entry,
  });
}

type ListedSession = Awaited<ReturnType<typeof listSessionsFromStore>>["sessions"][number];

function expectSessionModel(
  session: ListedSession | undefined,
  expected: { key: string; provider: string; model: string },
) {
  expect(session?.key).toBe(expected.key);
  expect(session?.modelProvider).toBe(expected.provider);
  expect(session?.model).toBe(expected.model);
}

function expectTranscriptBackfill(
  session: ListedSession | undefined,
  expected?: { contextTokens?: number; estimatedCostUsd?: number },
) {
  expect(session?.totalTokens).toBe(TRANSCRIPT_TOTAL_TOKENS);
  expect(session?.totalTokensFresh).toBe(true);
  if (expected?.contextTokens !== undefined) {
    expect(session?.contextTokens).toBe(expected.contextTokens);
  }
  if (expected?.estimatedCostUsd !== undefined) {
    expect(session?.estimatedCostUsd).toBeCloseTo(expected.estimatedCostUsd, 8);
  }
}

function sessionEntry(overrides: Partial<SessionEntry> = {}, updatedAt = Date.now()): SessionEntry {
  return {
    sessionId: MAIN_SESSION_ID,
    updatedAt,
    ...overrides,
  } as SessionEntry;
}

function transcriptFallbackEntry(now: number, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return sessionEntry(
    {
      totalTokens: 0,
      totalTokensFresh: false,
      ...overrides,
    },
    now,
  );
}

function expectAnthropicBackfill(session: ListedSession | undefined) {
  expectTranscriptBackfill(session, {
    contextTokens: ANTHROPIC_CONTEXT_1M_TOKENS,
    estimatedCostUsd: TRANSCRIPT_COST_USD,
  });
}

function expectOpenAiGpt54Backfill(session: ListedSession | undefined) {
  expectSessionModel(session, {
    key: MAIN_SESSION_KEY,
    provider: "openai",
    model: "gpt-5.4",
  });
  expectTranscriptBackfill(session);
}

function anthropicUsageEntry(now: number, overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    sessionId: MAIN_SESSION_ID,
    updatedAt: now,
    totalTokens: 0,
    totalTokensFresh: false,
    inputTokens: ANTHROPIC_USAGE.input,
    outputTokens: ANTHROPIC_USAGE.output,
    cacheRead: ANTHROPIC_USAGE.cacheRead,
    ...overrides,
  } as SessionEntry;
}

function zeroUsageTranscriptEntry(
  now: number,
  overrides: Partial<SessionEntry> = {},
): SessionEntry {
  return transcriptFallbackEntry(now, {
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    ...overrides,
  });
}

describe("listSessionsFromStore search", () => {
  beforeAll(async () => {
    await listSessionsFromStore({
      cfg: createModelDefaultsConfig({ primary: "anthropic/claude-sonnet-4-6" }),
      store: {
        "agent:main:warm-runtime": {
          sessionId: "sess-warm-runtime",
          updatedAt: Date.now(),
        } as SessionEntry,
      },
      storePath: "/tmp/openclaw-session-search-warm.json",
      opts: { search: "anthropic" },
    });
  });

  beforeAll(async () => {
    await listSessionsFromStore({
      cfg: createModelDefaultsConfig({ primary: "openai/gpt-5.4" }),
      storePath: "/tmp/sessions.json",
      store: {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: 1,
          modelProvider: "openai",
          model: "gpt-5.4",
        },
      },
      opts: { search: "openai" },
    });
  });

  afterEach(() => {
    resetAgentEventsForTest({ preserveListeners: true });
    resetSubagentRegistryForTests();
    closeSessionSqliteDatabasesForTest();
  });

  const baseCfg = {
    session: { mainKey: "main" },
    agents: { list: [{ id: "main", default: true }] },
  } as OpenClawConfig;

  const makeStore = (): Record<string, SessionEntry> => ({
    "agent:main:work-project": {
      sessionId: "sess-work-1",
      updatedAt: Date.now(),
      displayName: "Work Project Alpha",
      label: "work",
    } as SessionEntry,
    "agent:main:personal-chat": {
      sessionId: "sess-personal-1",
      updatedAt: Date.now() - 1000,
      displayName: "Personal Chat",
      subject: "Family Reunion Planning",
    } as SessionEntry,
    "agent:main:discord:group:dev-team": {
      sessionId: "sess-discord-1",
      updatedAt: Date.now() - 2000,
      label: "discord",
      subject: "Dev Team Discussion",
    } as SessionEntry,
  });

  async function listSearchSessions(params: {
    opts: Parameters<typeof listSessionsFromStore>[0]["opts"];
    cfg?: OpenClawConfig;
    store?: Record<string, SessionEntry>;
  }) {
    return await listSessionsFromStore({
      cfg: params.cfg ?? baseCfg,
      storePath: "/tmp/sessions.json",
      store: params.store ?? makeStore(),
      opts: params.opts,
    });
  }

  test("returns all sessions when search is empty or missing", async () => {
    const cases = [{ opts: { search: "" } }, { opts: {} }] as const;
    for (const testCase of cases) {
      const result = await listSearchSessions({ opts: testCase.opts });
      expect(result.sessions).toHaveLength(3);
    }
  });

  test("filters sessions across display metadata and key fields", async () => {
    const cases = [
      { search: "WORK PROJECT", expectedKey: "agent:main:work-project" },
      { search: "reunion", expectedKey: "agent:main:personal-chat" },
      { search: "discord", expectedKey: "agent:main:discord:group:dev-team" },
      { search: "sess-personal", expectedKey: "agent:main:personal-chat" },
      { search: "dev-team", expectedKey: "agent:main:discord:group:dev-team" },
      { search: "alpha", expectedKey: "agent:main:work-project" },
      { search: "  personal  ", expectedKey: "agent:main:personal-chat" },
      { search: "nonexistent-term", expectedKey: undefined },
    ] as const;

    for (const testCase of cases) {
      const result = await listSearchSessions({ opts: { search: testCase.search } });
      if (!testCase.expectedKey) {
        expect(result.sessions).toHaveLength(0);
        continue;
      }
      expect(result.sessions).toHaveLength(1);
      expect(expectDefined(result.sessions[0], "result.sessions[0] test invariant").key).toBe(
        testCase.expectedKey,
      );
    }
  });

  test("filters sessions by the displayed provider and model identity", async () => {
    const now = Date.now();
    const cfg = createModelDefaultsConfig({
      primary: "anthropic/claude-sonnet-4-6",
    });
    const store: Record<string, SessionEntry> = {
      "agent:main:inherited-default": {
        sessionId: "sess-inherited-default",
        updatedAt: now,
        label: "Inherited default",
      } as SessionEntry,
      "agent:main:override": {
        sessionId: "sess-override",
        updatedAt: now - 1_000,
        label: "Override",
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
      } as SessionEntry,
      "agent:main:runtime": {
        sessionId: "sess-runtime",
        updatedAt: now - 2_000,
        label: "Runtime",
        modelProvider: "google",
        model: "gemini-3.1-pro-preview",
      } as SessionEntry,
    };
    const cases = [
      { search: "anthropic", expectedKey: "agent:main:inherited-default" },
      { search: "claude-sonnet", expectedKey: "agent:main:inherited-default" },
      { search: "anthropic/claude-sonnet", expectedKey: "agent:main:inherited-default" },
      { search: "openai/gpt-5.5", expectedKey: "agent:main:override" },
      { search: "gemini-3.1", expectedKey: "agent:main:runtime" },
      { search: "google/gemini", expectedKey: "agent:main:runtime" },
    ] as const;

    for (const testCase of cases) {
      const result = await listSessionsFromStore({
        cfg,
        storePath: "",
        store,
        opts: { search: testCase.search },
      });

      expect(result.sessions.map(({ key }) => key)).toEqual([testCase.expectedKey]);
    }
  });

  test("keeps derived model search for colon model ids", async () => {
    const now = Date.now();
    const cfg = createModelDefaultsConfig({
      primary: "ollama/qwen3:0.6b",
    });
    const result = await listSearchSessions({
      cfg,
      store: {
        "agent:main:inherited-local-model": {
          sessionId: "sess-inherited-local-model",
          updatedAt: now,
          label: "Inherited local model",
        } as SessionEntry,
      },
      opts: { search: "qwen3:0.6b" },
    });

    expect(result.sessions.map((session) => session.key)).toEqual([
      "agent:main:inherited-local-model",
    ]);
    expect(result.totalCount).toBe(1);
  });

  test("hides cron run alias session keys from sessions list", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:cron:job-1": {
        sessionId: "run-abc",
        updatedAt: now,
        label: "Cron: job-1",
      } as SessionEntry,
      "agent:main:cron:job-1:run:run-abc": {
        sessionId: "run-abc",
        updatedAt: now,
        label: "Cron: job-1",
      } as SessionEntry,
    };

    const result = await listSearchSessions({
      store,
      opts: {},
    });

    expect(result.sessions.map((session) => session.key)).toEqual(["agent:main:cron:job-1"]);
  });

  test("ranks sessions by real interaction without heartbeat or cron noise", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:main": {
        sessionId: "main",
        updatedAt: now - 10_000,
        lastInteractionAt: now - 1_000,
      } as SessionEntry,
      "agent:main:heartbeat-noise": {
        sessionId: "heartbeat-noise",
        updatedAt: now,
        lastInteractionAt: now - 5_000,
        pinnedAt: now,
      } as SessionEntry,
      "agent:main:background-only": {
        sessionId: "background-only",
        updatedAt: now + 1_000,
      } as SessionEntry,
      "agent:main:main:heartbeat": {
        sessionId: "isolated-heartbeat",
        updatedAt: now + 3_000,
        lastInteractionAt: now + 3_000,
        heartbeatIsolatedBaseSessionKey: "agent:main:main",
      } as SessionEntry,
      "agent:main:cron:job-1:run:run-abc": {
        sessionId: "run-abc",
        updatedAt: now + 2_000,
        lastInteractionAt: now + 2_000,
      } as SessionEntry,
    };

    const result = await listSearchSessions({
      store,
      opts: {
        requireLastInteraction: true,
        sortBy: "lastInteractionAt",
      },
    });

    expect(result.sessions.map((session) => session.key)).toEqual([
      "agent:main:main",
      "agent:main:heartbeat-noise",
    ]);
    expect(result.sessions[0]?.lastInteractionAt).toBe(now - 1_000);
  });

  test.each([
    {
      name: "does not guess provider for legacy runtime model without modelProvider",
      cfg: createLegacyRuntimeListConfig(),
      runtimeModel: "claude-sonnet-4-6",
      expectedProvider: undefined,
    },
    {
      name: "infers provider for legacy runtime model when allowlist match is unique",
      cfg: createLegacyRuntimeListConfig({ "anthropic/claude-sonnet-4-6": {} }),
      runtimeModel: "claude-sonnet-4-6",
      expectedProvider: "anthropic",
    },
    {
      name: "infers wrapper provider for slash-prefixed legacy runtime model when allowlist match is unique",
      cfg: createLegacyRuntimeListConfig({
        "vercel-ai-gateway/anthropic/claude-sonnet-4-6": {},
      }),
      runtimeModel: "anthropic/claude-sonnet-4-6",
      expectedProvider: "vercel-ai-gateway",
    },
  ])("$name", ({ cfg, runtimeModel, expectedProvider }) => {
    const row = buildLegacyRuntimeRow(cfg, runtimeModel);

    expect(row.modelProvider).toBe(expectedProvider);
    expect(row.model).toBe(runtimeModel);
  });

  test("exposes unknown totals when freshness is stale or missing", async () => {
    const now = Date.now();
    const store: Record<string, SessionEntry> = {
      "agent:main:fresh": {
        sessionId: "sess-fresh",
        updatedAt: now,
        totalTokens: 1200,
        totalTokensFresh: true,
      } as SessionEntry,
      "agent:main:stale": {
        sessionId: "sess-stale",
        updatedAt: now - 1000,
        totalTokens: 2200,
        totalTokensFresh: false,
      } as SessionEntry,
      "agent:main:missing": {
        sessionId: "sess-missing",
        updatedAt: now - 2000,
        inputTokens: 100,
        outputTokens: 200,
      } as SessionEntry,
    };

    const result = await listSearchSessions({
      store,
      opts: {},
    });

    const fresh = result.sessions.find((row) => row.key === "agent:main:fresh");
    const stale = result.sessions.find((row) => row.key === "agent:main:stale");
    const missing = result.sessions.find((row) => row.key === "agent:main:missing");
    expect(fresh?.totalTokens).toBe(1200);
    expect(fresh?.totalTokensFresh).toBe(true);
    expect(stale?.totalTokens).toBeUndefined();
    expect(stale?.totalTokensFresh).toBe(false);
    expect(missing?.totalTokens).toBeUndefined();
    expect(missing?.totalTokensFresh).toBe(false);
  });

  test("backfills usage for the bounded async list page", async () => {
    await withAnthropicTranscriptFixture({
      prefix: "openclaw-session-utils-list-usage-",
      run: async ({ storePath, now }) => {
        const result = await listMainSession({
          cfg: createAnthropicContext1mConfig(),
          storePath,
          entry: zeroUsageTranscriptEntry(now, {
            modelProvider: "anthropic",
            model: ANTHROPIC_MODEL,
          }),
        });

        expectAnthropicBackfill(result.sessions[0]);
      },
    });
  });

  test("chat history session metadata keeps model context and projects a catalog-pinned harness", async () => {
    await withAnthropicTranscriptFixture({
      prefix: "openclaw-session-info-context-",
      run: async ({ storePath, now }) => {
        const entry: SessionEntry = {
          sessionId: MAIN_SESSION_ID,
          updatedAt: now,
          modelProvider: "local-test",
          model: "test-model",
          agentHarnessId: "codex",
          modelSelectionLocked: true,
          pluginExtensions: {
            codex: {
              supervision: {
                sourceThreadId: "019f-codex-thread",
                modelLocked: true,
              },
            },
          },
        };
        const row = buildGatewaySessionInfo({
          cfg: {
            models: {
              providers: {
                "local-test": {
                  models: [{ id: "test-model", contextTokens: 123_456 }],
                },
              },
            },
          } as unknown as OpenClawConfig,
          storePath,
          key: MAIN_SESSION_KEY,
          entry,
          store: { [MAIN_SESSION_KEY]: entry },
        });

        expect(row.totalTokens).toBeUndefined();
        expect(row.totalTokensFresh).toBe(false);
        expect(row.estimatedCostUsd).toBeUndefined();
        expect(row.contextTokens).toBe(123_456);
        expect(row.modelSelectionLocked).toBe(true);
        expect(row.agentRuntime).toEqual({ id: "codex", source: "session" });
      },
    });
  });

  test("does not replace the current runtime model when transcript fallback is only for missing pricing", async () => {
    await withAnthropicTranscriptFixture({
      prefix: "openclaw-session-utils-pricing-",
      transcriptId: "sess-pricing",
      run: async ({ storePath, now }) => {
        const result = await listMainSession({
          cfg: {
            session: { mainKey: "main" },
            agents: {
              list: [{ id: "main", default: true }],
            },
          } as unknown as OpenClawConfig,
          storePath,
          entry: anthropicUsageEntry(now, {
            sessionId: "sess-pricing",
            modelProvider: "openai",
            model: "gpt-5.4",
            contextTokens: 200_000,
            totalTokens: TRANSCRIPT_TOTAL_TOKENS,
            totalTokensFresh: true,
          }),
        });

        expectOpenAiGpt54Backfill(result.sessions[0]);
        expect(result.sessions[0]?.contextTokens).toBe(200_000);
      },
    });
  });
});
