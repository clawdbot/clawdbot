import { describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { filterAndSortSessionEntries } from "./session-utils-list.js";

// Candidate search must never render full rows or read transcripts.
vi.mock("../acp/runtime/session-meta.js", () => ({
  readAcpSessionMetaBatch: () => new Map(),
}));
vi.mock("./session-transcript-title-reader.js", () => ({
  readSessionTitleFieldsFromTranscriptBatch: () => [],
}));
vi.mock("./session-utils-row.js", () => ({
  buildGatewaySessionRow: () => {
    throw new Error("search selection must not render session rows");
  },
}));
vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

const baseCfg = {
  session: { mainKey: "main" },
  agents: { list: [{ id: "main", default: true }] },
} as OpenClawConfig;

function createModelDefaultsConfig(primary: string): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary } } },
  } as OpenClawConfig;
}

function makeStore(now = Date.now()): Record<string, SessionEntry> {
  return {
    "agent:main:work-project": {
      sessionId: "sess-work-1",
      updatedAt: now,
      displayName: "Work Project Alpha",
      label: "work",
    } as SessionEntry,
    "agent:main:personal-chat": {
      sessionId: "sess-personal-1",
      updatedAt: now - 1_000,
      displayName: "Personal Chat",
      subject: "Family Reunion Planning",
    } as SessionEntry,
    "agent:main:discord:group:dev-team": {
      sessionId: "sess-discord-1",
      updatedAt: now - 2_000,
      label: "discord",
      subject: "Dev Team Discussion",
    } as SessionEntry,
  };
}

function selectSessionKeys(params: {
  opts: Parameters<typeof filterAndSortSessionEntries>[0]["opts"];
  cfg?: OpenClawConfig;
  store?: Record<string, SessionEntry>;
  now?: number;
}): string[] {
  const now = params.now ?? Date.now();
  return filterAndSortSessionEntries({
    cfg: params.cfg ?? baseCfg,
    store: params.store ?? makeStore(now),
    opts: params.opts,
    now,
  }).map(([key]) => key);
}

describe("filterAndSortSessionEntries search", () => {
  test("returns all sessions when search is empty or missing", () => {
    for (const opts of [{ search: "" }, {}]) {
      expect(selectSessionKeys({ opts })).toHaveLength(3);
    }
  });

  test("filters across display metadata and key fields", () => {
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
      const keys = selectSessionKeys({ opts: { search: testCase.search } });
      expect(keys).toEqual(testCase.expectedKey ? [testCase.expectedKey] : []);
    }
  });

  test("filters by selected and stored provider and model identity", () => {
    const now = Date.now();
    const cfg = createModelDefaultsConfig("anthropic/claude-sonnet-4-6");
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
      {
        search: "anthropic",
        expectedKeys: ["agent:main:inherited-default", "agent:main:runtime"],
      },
      {
        search: "claude-sonnet",
        expectedKeys: ["agent:main:inherited-default", "agent:main:runtime"],
      },
      {
        search: "anthropic/claude-sonnet",
        expectedKeys: ["agent:main:inherited-default", "agent:main:runtime"],
      },
      { search: "openai/gpt-5.5", expectedKeys: ["agent:main:override"] },
      { search: "gemini-3.1", expectedKeys: ["agent:main:runtime"] },
      { search: "google/gemini", expectedKeys: ["agent:main:runtime"] },
    ] as const;

    for (const testCase of cases) {
      expect(
        selectSessionKeys({
          cfg,
          store,
          opts: { search: testCase.search },
          now,
        }),
      ).toEqual(testCase.expectedKeys);
    }
  });

  test("keeps derived model search for colon model ids", () => {
    const now = Date.now();
    expect(
      selectSessionKeys({
        cfg: createModelDefaultsConfig("ollama/qwen3:0.6b"),
        store: {
          "agent:main:inherited-local-model": {
            sessionId: "sess-inherited-local-model",
            updatedAt: now,
            label: "Inherited local model",
          } as SessionEntry,
        },
        opts: { search: "qwen3:0.6b" },
        now,
      }),
    ).toEqual(["agent:main:inherited-local-model"]);
  });

  test("matches canonical group titles and kinds before offset selection", () => {
    const store: Record<string, SessionEntry> = Object.fromEntries(
      Array.from({ length: 55 }, (_, index) => [
        `agent:main:filler-${index}`,
        { sessionId: `filler-${index}`, updatedAt: 100 + index },
      ]),
    );
    store["agent:main:slack:channel:target"] = {
      sessionId: "target",
      updatedAt: 1,
      groupChannel: "astronomy",
      space: "observatory",
      displayName: "compact-room-id",
      chatType: "channel",
    };
    expect(
      selectSessionKeys({ store, opts: { search: "observatory #astronomy", limit: 50 } }),
    ).toEqual(["agent:main:slack:channel:target"]);
    expect(selectSessionKeys({ store, opts: { search: "group", limit: 50 } })).toEqual([
      "agent:main:slack:channel:target",
    ]);
    expect(
      selectSessionKeys({ store, opts: { search: "direct", limit: 50, offset: 50 } }),
    ).toHaveLength(5);
  });

  test("hides cron run alias session keys", () => {
    const now = Date.now();
    expect(
      selectSessionKeys({
        store: {
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
        },
        opts: {},
        now,
      }),
    ).toEqual(["agent:main:cron:job-1"]);
  });

  test("ranks by real interaction without heartbeat or cron noise", () => {
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

    expect(
      selectSessionKeys({
        store,
        opts: { requireLastInteraction: true, sortBy: "lastInteractionAt" },
        now,
      }),
    ).toEqual(["agent:main:main", "agent:main:heartbeat-noise"]);
  });
});
