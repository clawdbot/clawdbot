// Sessions default-agent store tests cover default session-store selection and runtime config loading.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";

const loadConfigMock = vi.hoisted(() => vi.fn());

const resolveStorePathMock = vi.hoisted(() =>
  vi.fn((_store: string | undefined, opts?: { agentId?: string }) => {
    return `/tmp/sessions-${opts?.agentId ?? "missing"}.json`;
  }),
);
const listSessionEntriesMock = vi.hoisted(() =>
  vi.fn<() => Array<{ sessionKey: string; entry: Record<string, unknown> }>>(() => []),
);

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: loadConfigMock,
    loadConfig: loadConfigMock,
  };
});

vi.mock("../config/sessions.js", async () => {
  const actual =
    await vi.importActual<typeof import("../config/sessions.js")>("../config/sessions.js");
  return {
    ...actual,
    resolveStorePath: resolveStorePathMock,
  };
});

vi.mock("../infra/state-migrations.js", async () => ({
  ...(await vi.importActual<typeof import("../infra/state-migrations.js")>(
    "../infra/state-migrations.js",
  )),
  autoMigrateLegacyState: vi.fn(async () => ({
    migrated: false,
    skipped: true,
    changes: [],
    warnings: [],
  })),
}));

vi.mock("../config/sessions/session-accessor.js", () => ({
  listSessionEntries: listSessionEntriesMock,
}));

import { sessionsCommand } from "./sessions.js";

function toSessionEntrySummaries(store: Record<string, Record<string, unknown>>) {
  return Object.entries(store).map(([sessionKey, entry]) => ({ sessionKey, entry }));
}

function createSessionsConfig(store = "/tmp/sessions-{agentId}.json") {
  return {
    agents: {
      defaults: {
        model: { primary: "test:opus" },
        models: { "test:opus": {} },
        contextTokens: 32000,
      },
      list: [
        { id: "main", default: false },
        { id: "voice", default: true },
      ],
    },
    session: { store },
  };
}

function createRuntime(): { runtime: RuntimeEnv; logs: string[] } {
  const logs: string[] = [];
  return {
    runtime: {
      log: (msg: unknown) => logs.push(String(msg)),
      error: vi.fn(),
      exit: vi.fn(),
    },
    logs,
  };
}

describe("sessionsCommand default store agent selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockImplementation(() => createSessionsConfig());
    resolveStorePathMock.mockImplementation(
      (_store: string | undefined, opts?: { agentId?: string }) => {
        return `/tmp/sessions-${opts?.agentId ?? "missing"}.json`;
      },
    );
    listSessionEntriesMock.mockImplementation(() => []);
  });

  it("includes agentId on sessions rows for --all-agents JSON output", async () => {
    resolveStorePathMock.mockClear();
    listSessionEntriesMock.mockReset();
    listSessionEntriesMock
      .mockReturnValueOnce(
        toSessionEntrySummaries({
          main_row: { sessionId: "s1", updatedAt: Date.now() - 60_000, model: "test:opus" },
        }),
      )
      .mockReturnValueOnce(
        toSessionEntrySummaries({
          voice_row: { sessionId: "s2", updatedAt: Date.now() - 120_000, model: "test:opus" },
        }),
      );
    const { runtime, logs } = createRuntime();

    await sessionsCommand({ allAgents: true, json: true }, runtime);

    const payload = JSON.parse(logs[0] ?? "{}") as {
      allAgents?: boolean;
      sessions?: Array<{ key: string; agentId?: string }>;
    };
    expect(payload.allAgents).toBe(true);
    expect(payload.sessions?.map((session) => session.agentId)).toContain("main");
    expect(payload.sessions?.map((session) => session.agentId)).toContain("voice");
  });

  it("lists each SQLite owner when --all-agents resolves to a shared store path", async () => {
    loadConfigMock.mockImplementation(() => createSessionsConfig("/tmp/shared-sessions.json"));
    listSessionEntriesMock.mockReset();
    listSessionEntriesMock
      .mockReturnValueOnce(
        toSessionEntrySummaries({
          "agent:main:room": {
            sessionId: "s1",
            updatedAt: Date.now() - 60_000,
            model: "test:opus",
          },
        }),
      )
      .mockReturnValueOnce(
        toSessionEntrySummaries({
          "agent:voice:room": {
            sessionId: "s2",
            updatedAt: Date.now() - 30_000,
            model: "test:opus",
          },
        }),
      );
    const { runtime, logs } = createRuntime();

    await sessionsCommand({ allAgents: true, json: true }, runtime);

    const payload = JSON.parse(logs[0] ?? "{}") as {
      count?: number;
      stores?: Array<{ agentId: string; path: string }>;
      allAgents?: boolean;
      sessions?: Array<{ key: string; agentId?: string }>;
    };
    expect(payload.count).toBe(2);
    expect(payload.allAgents).toBe(true);
    expect(payload.stores).toEqual([
      { agentId: "main", path: "/tmp/shared-sessions.sqlite" },
      { agentId: "voice", path: "/tmp/shared-sessions.voice.sqlite" },
    ]);
    expect(payload.sessions?.map((session) => session.agentId).toSorted()).toEqual([
      "main",
      "voice",
    ]);
    expect(listSessionEntriesMock).toHaveBeenCalledTimes(2);
  });

  it("uses configured default agent id when resolving implicit session store path", async () => {
    listSessionEntriesMock.mockReset();
    listSessionEntriesMock.mockReturnValue([]);
    const { runtime, logs } = createRuntime();

    await sessionsCommand({}, runtime);

    expect(listSessionEntriesMock).toHaveBeenCalledWith({
      agentId: "voice",
      storePath: "/tmp/sessions-voice.json",
    });
    expect(logs[0]).toContain("Session store: /tmp/sessions-voice.voice.sqlite");
  });

  it("uses all configured agent stores with --all-agents", async () => {
    listSessionEntriesMock.mockReset();
    listSessionEntriesMock
      .mockReturnValueOnce(
        toSessionEntrySummaries({
          main_row: { sessionId: "s1", updatedAt: Date.now() - 60_000, model: "test:opus" },
        }),
      )
      .mockReturnValueOnce([]);
    const { runtime, logs } = createRuntime();

    await sessionsCommand({ allAgents: true }, runtime);

    expect(listSessionEntriesMock).toHaveBeenNthCalledWith(1, {
      agentId: "main",
      storePath: "/tmp/sessions-main.json",
    });
    expect(listSessionEntriesMock).toHaveBeenNthCalledWith(2, {
      agentId: "voice",
      storePath: "/tmp/sessions-voice.json",
    });
    expect(logs[0]).toContain("Session stores: 2 (main, voice)");
    expect(logs[2]).toContain("Agent");
  });
});
