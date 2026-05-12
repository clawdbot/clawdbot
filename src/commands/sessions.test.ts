import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeRuntime,
  mockSessionsConfig,
  resetMockSessionsConfig,
  runSessionsJson,
  setMockSessionsConfig,
  writeStore,
} from "./sessions.test-helpers.js";

// Disable colors for deterministic snapshots.
process.env.FORCE_COLOR = "0";

mockSessionsConfig();

import { sessionsCommand, __testing } from "./sessions.js";

describe("sessionsCommand", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-06T00:00:00Z"));
  });

  afterEach(() => {
    resetMockSessionsConfig();
    vi.useRealTimers();
  });

  it("renders a tabular view with token percentages", async () => {
    const store = writeStore({
      "+15555550123": {
        sessionId: "abc123",
        updatedAt: Date.now() - 45 * 60_000,
        inputTokens: 1200,
        outputTokens: 800,
        totalTokens: 2000,
        totalTokensFresh: true,
        model: "pi:opus",
      },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store }, runtime);

    fs.rmSync(store);

    expect(logs.some((line) => line.includes("Tokens (ctx %"))).toBe(true);

    const row = logs.find((line) => line.includes("+15555550123")) ?? "";
    expect(row).toBe(
      "direct +15555550123               45m ago   pi:opus        OpenAI Codex       2.0k/32k (6%)        id:abc123",
    );
  });

  it("renders the agent runtime in the tabular view", async () => {
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
      "sessions-runtime-table",
    );

    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store }, runtime);

    fs.rmSync(store);

    expect(logs.some((line) => line.includes("Runtime"))).toBe(true);

    const row = logs.find((line) => line.includes("agent:main:main")) ?? "";
    expect(row).toBe(
      "direct agent:main:main            1m ago    claude-opus-4-7 Claude CLI         unknown/200k (?%)    id:main-session",
    );
  });

  it("renders configured CLI runtime when the session stores a canonical provider", async () => {
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
          modelProvider: "anthropic",
          model: "claude-opus-4-7",
        },
      },
      "sessions-runtime-canonical-provider",
    );

    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store }, runtime);

    fs.rmSync(store);

    const row = logs.find((line) => line.includes("agent:main:main")) ?? "";
    expect(row).toBe(
      "direct agent:main:main            1m ago    claude-opus-4-7 Claude CLI         unknown/200k (?%)    id:main-session",
    );
  });

  it("shows placeholder rows when tokens are missing", async () => {
    const store = writeStore({
      "quietchat:group:demo": {
        sessionId: "xyz",
        updatedAt: Date.now() - 5 * 60_000,
        thinkingLevel: "high",
      },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store }, runtime);

    fs.rmSync(store);

    const row = logs.find((line) => line.includes("quietchat:group:demo")) ?? "";
    expect(row).toBe(
      "group  quietchat:group:demo       5m ago    pi:opus        OpenAI Codex       unknown/32k (?%)     think:high id:xyz",
    );
  });

  it("exports freshness metadata in JSON output", async () => {
    const store = writeStore({
      main: {
        sessionId: "abc123",
        updatedAt: Date.now() - 10 * 60_000,
        inputTokens: 1200,
        outputTokens: 800,
        totalTokens: 2000,
        totalTokensFresh: true,
        model: "pi:opus",
      },
      "quietchat:group:demo": {
        sessionId: "xyz",
        updatedAt: Date.now() - 5 * 60_000,
        inputTokens: 20,
        outputTokens: 10,
        model: "pi:opus",
      },
    });

    const payload = await runSessionsJson<{
      sessions?: Array<{
        key: string;
        totalTokens: number | null;
        totalTokensFresh: boolean;
      }>;
    }>(sessionsCommand, store);
    const main = payload.sessions?.find((row) => row.key === "main");
    const group = payload.sessions?.find((row) => row.key === "quietchat:group:demo");
    expect(main?.totalTokens).toBe(2000);
    expect(main?.totalTokensFresh).toBe(true);
    expect(group?.totalTokens).toBeNull();
    expect(group?.totalTokensFresh).toBe(false);
  });

  it("shows preserved stale totals in JSON output", async () => {
    const store = writeStore({
      main: {
        sessionId: "abc123",
        updatedAt: Date.now() - 10 * 60_000,
        totalTokens: 2000,
        totalTokensFresh: false,
        model: "pi:opus",
      },
    });

    const payload = await runSessionsJson<{
      sessions?: Array<{
        key: string;
        totalTokens: number | null;
        totalTokensFresh: boolean;
      }>;
    }>(sessionsCommand, store);
    const main = payload.sessions?.find((row) => row.key === "main");
    expect(main?.totalTokens).toBe(2000);
    expect(main?.totalTokensFresh).toBe(false);
  });

  it("applies --active filtering in JSON output", async () => {
    const store = writeStore(
      {
        recent: {
          sessionId: "recent",
          updatedAt: Date.now() - 5 * 60_000,
          model: "pi:opus",
        },
        stale: {
          sessionId: "stale",
          updatedAt: Date.now() - 45 * 60_000,
          model: "pi:opus",
        },
      },
      "sessions-active",
    );

    const payload = await runSessionsJson<{
      sessions?: Array<{
        key: string;
      }>;
    }>(sessionsCommand, store, { active: "10" });
    expect(payload.sessions?.map((row) => row.key)).toEqual(["recent"]);
  });

  it("uses a default JSON output limit of 100 sessions", () => {
    expect(__testing.parseSessionsLimit(undefined)).toBe(100);
  });

  it("honors explicit JSON output limits", async () => {
    const store = writeStore(
      {
        newest: { sessionId: "newest", updatedAt: Date.now(), model: "pi:opus" },
        middle: { sessionId: "middle", updatedAt: Date.now() - 60_000, model: "pi:opus" },
        oldest: { sessionId: "oldest", updatedAt: Date.now() - 120_000, model: "pi:opus" },
      },
      "sessions-explicit-limit",
    );

    const payload = await runSessionsJson<{
      count?: number;
      totalCount?: number;
      limitApplied?: number | null;
      hasMore?: boolean;
      sessions?: Array<{ key: string }>;
    }>(sessionsCommand, store, { limit: "2" });

    expect(payload.count).toBe(2);
    expect(payload.totalCount).toBe(3);
    expect(payload.limitApplied).toBe(2);
    expect(payload.hasMore).toBe(true);
    expect(payload.sessions?.map((row) => row.key)).toEqual(["newest", "middle"]);
  });

  it("allows full JSON output with --limit all", async () => {
    const store = writeStore(
      {
        newest: { sessionId: "newest", updatedAt: Date.now(), model: "pi:opus" },
        oldest: { sessionId: "oldest", updatedAt: Date.now() - 120_000, model: "pi:opus" },
      },
      "sessions-limit-all",
    );

    const payload = await runSessionsJson<{
      count?: number;
      totalCount?: number;
      limitApplied?: number | null;
      hasMore?: boolean;
      sessions?: Array<{ key: string }>;
    }>(sessionsCommand, store, { limit: "all" });

    expect(payload.count).toBe(2);
    expect(payload.totalCount).toBe(2);
    expect(payload.limitApplied).toBeNull();
    expect(payload.hasMore).toBe(false);
    expect(payload.sessions?.map((row) => row.key)).toEqual(["newest", "oldest"]);
  });

  it("sorts and slices large explicit limits instead of using top-N insertion", async () => {
    const store = writeStore(
      {
        newest: { sessionId: "newest", updatedAt: Date.now(), model: "pi:opus" },
        oldest: { sessionId: "oldest", updatedAt: Date.now() - 120_000, model: "pi:opus" },
      },
      "sessions-large-limit",
    );

    const payload = await runSessionsJson<{
      count?: number;
      totalCount?: number;
      limitApplied?: number | null;
      hasMore?: boolean;
      sessions?: Array<{ key: string }>;
    }>(sessionsCommand, store, { limit: "100000" });

    expect(payload.count).toBe(2);
    expect(payload.totalCount).toBe(2);
    expect(payload.limitApplied).toBe(100000);
    expect(payload.hasMore).toBe(false);
    expect(payload.sessions?.map((row) => row.key)).toEqual(["newest", "oldest"]);
  });

  it("rejects invalid --active values", async () => {
    const store = writeStore(
      {
        demo: {
          sessionId: "demo",
          updatedAt: Date.now() - 5 * 60_000,
        },
      },
      "sessions-active-invalid",
    );
    const { runtime, errors } = makeRuntime();

    await expect(sessionsCommand({ store, active: "0" }, runtime)).rejects.toThrow("exit 1");
    expect(errors).toStrictEqual([
      "--active must be a positive number of minutes, for example --active 30.",
    ]);

    fs.rmSync(store);
  });

  it("rejects invalid --limit values", async () => {
    const store = writeStore(
      {
        demo: {
          sessionId: "demo",
          updatedAt: Date.now() - 5 * 60_000,
        },
      },
      "sessions-limit-invalid",
    );
    const { runtime, errors } = makeRuntime();

    await expect(sessionsCommand({ store, limit: "0" }, runtime)).rejects.toThrow("exit 1");
    expect(errors).toStrictEqual([
      '--limit must be a positive integer or "all", for example --limit 25.',
    ]);

    fs.rmSync(store);
  });
});
