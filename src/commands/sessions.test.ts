// Sessions command tests cover listing, details, filtering, and transcript display behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExpectedCliError } from "../cli/failure-output.js";
import {
  assignSessionOwner,
  recordSessionParticipant,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import {
  cleanupStore,
  makeRuntime,
  mockSessionsConfig,
  resetMockSessionsConfig,
  runSessionsJson,
  setMockSessionsConfig,
  writeStore,
} from "./sessions.test-helpers.js";

mockSessionsConfig();

import { sessionsCommand } from "./sessions.js";

describe("sessionsCommand", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-12-06T00:00:00Z"));
  });

  afterEach(() => {
    resetMockSessionsConfig();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders a tabular view with token percentages", async () => {
    const store = await writeStore({
      "agent:main:+15555550123": {
        sessionId: "abc123",
        updatedAt: Date.now() - 45 * 60_000,
        inputTokens: 1200,
        outputTokens: 800,
        totalTokens: 2000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        model: "test:opus",
      },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store }, runtime);

    cleanupStore(store);

    expect(logs.join("\n")).toContain("Tokens (ctx %");

    const row = logs.find((line) => line.includes("agent:main:+15555550123")) ?? "";
    expect(row).toBe(
      "direct      agent:main:+15555550123    45m ago   test:opus      OpenAI Codex       2.0k/200k (1%)       visibility:shared id:abc123",
    );
  });

  it("shows recorded totals without a percentage when freshness provenance is missing", async () => {
    // Regression: sessions rendered `unknown/... (?%)` for totals `status`
    // still displayed, because the table dropped non-fresh recorded totals.
    const store = await writeStore({
      "agent:main:+15555550123": {
        sessionId: "abc123",
        updatedAt: Date.now() - 45 * 60_000,
        totalTokens: 2000,
        totalTokensFresh: true,
        model: "test:opus",
      },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store }, runtime);

    cleanupStore(store);

    const row = logs.find((line) => line.includes("agent:main:+15555550123")) ?? "";
    expect(row).toContain("2.0k/200k (?%)");
  });

  it("renders the agent runtime in the tabular view", async () => {
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
    const store = await writeStore(
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

    cleanupStore(store);

    expect(logs.join("\n")).toContain("Runtime");

    const row = logs.find((line) => line.includes("agent:main:main")) ?? "";
    expect(row).toBe(
      "direct      agent:main:main            1m ago    claude-opus-4-7 Claude CLI         unknown/200k (?%)    visibility:shared id:main-session",
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
        },
      },
    }));
    const store = await writeStore(
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

    cleanupStore(store);

    const row = logs.find((line) => line.includes("agent:main:main")) ?? "";
    expect(row).toBe(
      "direct      agent:main:main            1m ago    claude-opus-4-7 Claude CLI         unknown/200k (?%)    visibility:shared id:main-session",
    );
  });

  it("renders recorded runtime with current context after a same-model runtime change", async () => {
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
    const store = await writeStore(
      {
        "agent:main:main": {
          sessionId: "stale-openclaw-window",
          updatedAt: Date.now() - 60_000,
          modelProvider: "openai",
          model: "gpt-5.6-sol",
          agentHarnessId: "openclaw",
          contextTokens: 272_000,
          contextTokensSource: "runtime",
          totalTokens: 11,
          totalTokensFresh: true,
          totalTokensVersion: 1,
        },
      },
      "sessions-current-runtime-table",
    );

    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store }, runtime);
    cleanupStore(store);

    const row = logs.find((line) => line.includes("agent:main:main")) ?? "";
    expect(row).toContain("OpenClaw Default");
    expect(row).toContain("0.0k/1000k (0%)");
  });

  it("shows placeholder rows when tokens are missing", async () => {
    const store = await writeStore({
      "agent:main:quietchat:group:demo": {
        sessionId: "xyz",
        updatedAt: Date.now() - 5 * 60_000,
        thinkingLevel: "high",
      },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store }, runtime);

    cleanupStore(store);

    const row = logs.find((line) => line.includes("id:xyz")) ?? "";
    expect(row).toContain("group");
    expect(row).toContain("unknown/200k (?%)");
    expect(row).toContain("think:high");
  });

  it("sanitizes persisted identifiers only for terminal output", async () => {
    const key = "agent:main:\u001B[31mpeer\nrow";
    const sessionId = "session-\u001B[31mid\r\nforged-id";
    const model = "model-\u001B]0;session-model\u0007🦞\tvariant";
    const store = await writeStore({
      [key]: {
        sessionId,
        updatedAt: Date.now() - 60_000,
        model,
      },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store }, runtime);

    const textOutput = logs.join("\n");
    expect(textOutput).not.toContain("\u001B");
    expect(textOutput).not.toContain("\nrow");
    expect(textOutput).toContain("peer\\nrow");
    expect(textOutput).toContain("\\r\\nforged-id");
    expect(textOutput).toContain("🦞\\tvariant");

    const payload = await runSessionsJson<{
      sessions?: Array<{ key: string; sessionId?: string; model?: string }>;
    }>(sessionsCommand, store);
    cleanupStore(store);

    expect(payload.sessions?.[0]).toMatchObject({ key, sessionId, model });
  });

  it("exports freshness metadata in JSON output", async () => {
    const store = await writeStore({
      "agent:main:main": {
        sessionId: "abc123",
        updatedAt: Date.now() - 10 * 60_000,
        inputTokens: 1200,
        outputTokens: 800,
        totalTokens: 2000,
        totalTokensFresh: true,
        totalTokensVersion: 1,
        model: "test:opus",
      },
      "agent:main:quietchat:group:demo": {
        sessionId: "xyz",
        updatedAt: Date.now() - 5 * 60_000,
        inputTokens: 20,
        outputTokens: 10,
        model: "test:opus",
      },
    });

    const payload = await runSessionsJson<{
      sessions?: Array<{
        key: string;
        totalTokens: number | null;
        totalTokensFresh: boolean;
      }>;
    }>(sessionsCommand, store);
    const main = payload.sessions?.find((row) => row.key === "agent:main:main");
    const group = payload.sessions?.find((row) => row.key === "agent:main:quietchat:group:demo");
    expect(main?.totalTokens).toBe(2000);
    expect(main?.totalTokensFresh).toBe(true);
    expect(group?.totalTokens).toBeNull();
    expect(group?.totalTokensFresh).toBe(false);
  });

  it("defaults missing collaboration visibility to shared in JSON output", async () => {
    const sessionKey = "agent:main:legacy-shared";
    const store = await writeStore(
      {
        [sessionKey]: {
          sessionId: "legacy-shared-session",
          updatedAt: Date.now() - 60_000,
          model: "test:opus",
        },
      },
      "sessions-default-visibility",
    );

    const payload = await runSessionsJson<{
      sessions?: Array<{ key: string; visibility?: SessionEntry["visibility"] }>;
    }>(sessionsCommand, store);
    expect(payload.sessions?.find((entry) => entry.key === sessionKey)).toMatchObject({
      visibility: "shared",
    });
  });

  it("preserves collaboration metadata in JSON and human output", async () => {
    const sessionKey = "agent:main:shared";
    const store = await writeStore(
      {
        [sessionKey]: {
          sessionId: "shared-session",
          updatedAt: Date.now() - 60_000,
          model: "test:opus",
          visibility: "suggest",
          createdActor: { type: "human", id: "profile-creator", label: "Creator" },
        },
      },
      "sessions-collaboration",
    );
    const scope = { agentId: "main", sessionKey, storePath: store };
    assignSessionOwner(scope, {
      owner: { type: "human", id: "profile-owner", label: "Grace" },
      assignedBy: { type: "human", id: "profile-admin", label: "Admin" },
      assignedAt: Date.now() - 30_000,
    });
    for (const [id, label] of [
      ["profile-ada", "Ada"],
      ["profile-ben", "Ben"],
      ["profile-cam", "Cam"],
      ["profile-dee", "Dee"],
      ["profile-eli", "Eli"],
    ] as const) {
      recordSessionParticipant(scope, {
        actor: { type: "human", id, label },
        source: "profile",
      });
    }

    const { runtime, logs } = makeRuntime();
    await sessionsCommand({ store }, runtime);
    const row = logs.find((line) => line.includes(sessionKey)) ?? "";
    expect(row).toContain(
      "visibility:suggest owner:profile-owner participants:profile-ada,profile-ben,profile-cam,profile-dee,+1",
    );

    const payload = await runSessionsJson<{
      sessions?: Array<
        Pick<
          SessionEntry,
          "visibility" | "createdActor" | "owner" | "participants" | "participantCount"
        > & {
          key: string;
          sharingRole?: unknown;
        }
      >;
    }>(sessionsCommand, store);
    const shared = payload.sessions?.find((entry) => entry.key === sessionKey);
    expect(shared).toMatchObject({
      visibility: "suggest",
      createdActor: { type: "human", id: "profile-creator" },
      owner: {
        actor: { type: "human", id: "profile-owner" },
        assignedBy: { type: "human", id: "profile-admin" },
        assignedAt: Date.now() - 30_000,
      },
      participantCount: 5,
      participants: [
        { type: "human", id: "profile-ada", source: "profile" },
        { type: "human", id: "profile-ben", source: "profile" },
        { type: "human", id: "profile-cam", source: "profile" },
        { type: "human", id: "profile-dee", source: "profile" },
        { type: "human", id: "profile-eli", source: "profile" },
      ],
    });
    expect(shared).not.toHaveProperty("sharingRole");
  });

  it("reports the SQLite database and omits the retired sessionFile field", async () => {
    const store = await writeStore({
      "agent:main:main": {
        sessionId: "abc123",
        updatedAt: Date.now() - 10 * 60_000,
        model: "test:opus",
      },
    });

    const payload = await runSessionsJson<{
      path?: string;
      sessions?: Array<{ key: string }>;
    }>(sessionsCommand, store);

    expect(payload.path).toMatch(/openclaw-agent\.sqlite$/u);
    expect(payload.path).not.toContain("sessions.json");
    expect(payload.sessions?.find((row) => row.key === "agent:main:main")).not.toHaveProperty(
      "sessionFile",
    );
  });

  it("reports an existing empty SQLite store as an empty successful list", async () => {
    const store = await writeStore({}, "sessions-empty");
    const { runtime, logs, errors } = makeRuntime();

    await sessionsCommand({ store }, runtime);
    cleanupStore(store);

    expect(errors).toEqual([]);
    expect(logs).toEqual([
      expect.stringContaining(`Session store: ${store}`),
      expect.stringContaining("Sessions listed: 0"),
      "No sessions found.",
    ]);
  });

  it("exports subagent lineage metadata in JSON output", async () => {
    const store = await writeStore({
      "agent:main:child": {
        sessionId: "child-session",
        updatedAt: Date.now() - 10 * 60_000,
        spawnedBy: "agent:main:main",
        spawnedWorkspaceDir: "/workspace/project",
        spawnedCwd: "/workspace/project/tasks",
        parentSessionKey: "agent:main:main",
        forkedFromParent: true,
        spawnDepth: 1,
        subagentRole: "leaf",
        subagentControlScope: "none",
        sessionStartedAt: Date.now() - 20 * 60_000,
        lastInteractionAt: Date.now() - 5 * 60_000,
        label: "research helper",
        status: "done",
        model: "test:opus",
      },
    });

    const payload = await runSessionsJson<{
      sessions?: Array<{
        key: string;
        spawnedBy?: string;
        spawnedWorkspaceDir?: string;
        spawnedCwd?: string;
        parentSessionKey?: string;
        forkedFromParent?: boolean;
        spawnDepth?: number;
        subagentRole?: string;
        subagentControlScope?: string;
        sessionStartedAt?: number;
        lastInteractionAt?: number;
        label?: string;
        status?: string;
      }>;
    }>(sessionsCommand, store);

    const child = payload.sessions?.find((row) => row.key === "agent:main:child");
    expect(child).toMatchObject({
      spawnedBy: "agent:main:main",
      spawnedWorkspaceDir: "/workspace/project",
      spawnedCwd: "/workspace/project/tasks",
      parentSessionKey: "agent:main:main",
      forkedFromParent: true,
      spawnDepth: 1,
      subagentRole: "leaf",
      subagentControlScope: "none",
      sessionStartedAt: Date.now() - 20 * 60_000,
      lastInteractionAt: Date.now() - 5 * 60_000,
      label: "research helper",
      status: "done",
    });
    expect(child).not.toHaveProperty("sessionFile");
  });

  it("shows preserved stale totals in JSON output", async () => {
    const store = await writeStore({
      "agent:main:main": {
        sessionId: "abc123",
        updatedAt: Date.now() - 10 * 60_000,
        totalTokens: 2000,
        totalTokensFresh: false,
        model: "test:opus",
      },
    });

    const payload = await runSessionsJson<{
      sessions?: Array<{
        key: string;
        totalTokens: number | null;
        totalTokensFresh: boolean;
      }>;
    }>(sessionsCommand, store);
    const main = payload.sessions?.find((row) => row.key === "agent:main:main");
    expect(main?.totalTokens).toBe(2000);
    expect(main?.totalTokensFresh).toBe(false);
  });

  it("applies --active filtering in JSON output", async () => {
    const store = await writeStore(
      {
        "agent:main:recent": {
          sessionId: "recent",
          updatedAt: Date.now() - 5 * 60_000,
          model: "test:opus",
        },
        "agent:main:stale": {
          sessionId: "stale",
          updatedAt: Date.now() - 45 * 60_000,
          model: "test:opus",
        },
      },
      "sessions-active",
    );

    const payload = await runSessionsJson<{
      sessions?: Array<{
        key: string;
      }>;
    }>(sessionsCommand, store, { active: "10" });
    expect(payload.sessions?.map((row) => row.key)).toEqual(["agent:main:recent"]);
  });

  it("exports runtime policy aliases for collapsed external direct sessions", async () => {
    const store = await writeStore(
      {
        "agent:main:main": {
          sessionId: "telegram-main",
          updatedAt: Date.now() - 60_000,
          delivery: normalizeSessionDeliveryState({
            origin: {
              provider: "telegram",
              chatType: "direct",
              to: "telegram:42",
              accountId: "default",
            },
          }),
        },
      },
      "sessions-runtime-policy-alias",
    );

    const payload = await runSessionsJson<{
      sessions?: Array<{
        key: string;
        runtimePolicySessionKey?: string;
      }>;
    }>(sessionsCommand, store, { active: "10" });

    const main = payload.sessions?.find((row) => row.key === "agent:main:main");
    expect(main?.runtimePolicySessionKey).toBe("agent:main:telegram:default:direct:42");
  });

  it("projects a bare row with its resolved fixed-store owner", async () => {
    const store = await writeStore(
      {
        global: {
          sessionId: "telegram-global",
          updatedAt: Date.now() - 60_000,
          modelProvider: "claude-cli",
          model: "opus",
          delivery: normalizeSessionDeliveryState({
            origin: {
              provider: "telegram",
              chatType: "direct",
              to: "telegram:42",
              accountId: "default",
            },
          }),
        },
      },
      "sessions-runtime-policy-owner",
      { agentId: "ops" },
    );
    setMockSessionsConfig(() => ({
      session: { scope: "global", store },
      agents: {
        ownership: "explicit",
        defaults: {
          model: { primary: "anthropic/opus" },
          models: { "anthropic/opus": {} },
          sessionStore: { agentId: "ops" },
        },
        entries: {
          ops: { models: { "custom/opus": {} } },
          research: {},
        },
      },
    }));

    const payload = await runSessionsJson<{
      sessions?: Array<{
        agentId?: string;
        key: string;
        modelProvider?: string;
        runtimePolicySessionKey?: string;
      }>;
    }>(sessionsCommand, store, { active: "10" });

    expect(payload.sessions?.find((row) => row.key === "global")).toMatchObject({
      agentId: "ops",
      modelProvider: "custom",
      runtimePolicySessionKey: "agent:ops:telegram:default:direct:42",
    });
  });

  it("uses a default JSON output limit of 100 sessions", async () => {
    const entries = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [
        `agent:main:session-${index}`,
        {
          sessionId: `session-${index}`,
          updatedAt: Date.now() - index,
          model: "test:opus",
        },
      ]),
    );
    const store = await writeStore(entries, "sessions-default-limit");

    const payload = await runSessionsJson<{
      count?: number;
      totalCount?: number;
      limitApplied?: number | null;
      hasMore?: boolean;
      sessions?: Array<{ key: string }>;
    }>(sessionsCommand, store);

    expect(payload.count).toBe(100);
    expect(payload.totalCount).toBe(101);
    expect(payload.limitApplied).toBe(100);
    expect(payload.hasMore).toBe(true);
    expect(payload.sessions).toHaveLength(100);
  });

  it("honors explicit JSON output limits", async () => {
    const store = await writeStore(
      {
        "agent:main:newest": { sessionId: "newest", updatedAt: Date.now(), model: "test:opus" },
        "agent:main:middle": {
          sessionId: "middle",
          updatedAt: Date.now() - 60_000,
          model: "test:opus",
        },
        "agent:main:oldest": {
          sessionId: "oldest",
          updatedAt: Date.now() - 120_000,
          model: "test:opus",
        },
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
    expect(payload.sessions?.map((row) => row.key)).toEqual([
      "agent:main:newest",
      "agent:main:middle",
    ]);
  });

  it("allows full JSON output with --limit all", async () => {
    const store = await writeStore(
      {
        "agent:main:newest": { sessionId: "newest", updatedAt: Date.now(), model: "test:opus" },
        "agent:main:oldest": {
          sessionId: "oldest",
          updatedAt: Date.now() - 120_000,
          model: "test:opus",
        },
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
    expect(payload.sessions?.map((row) => row.key)).toEqual([
      "agent:main:newest",
      "agent:main:oldest",
    ]);
  });

  it("sorts and slices large explicit limits instead of using top-N insertion", async () => {
    const store = await writeStore(
      {
        "agent:main:newest": { sessionId: "newest", updatedAt: Date.now(), model: "test:opus" },
        "agent:main:oldest": {
          sessionId: "oldest",
          updatedAt: Date.now() - 120_000,
          model: "test:opus",
        },
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
    expect(payload.sessions?.map((row) => row.key)).toEqual([
      "agent:main:newest",
      "agent:main:oldest",
    ]);
  });

  it.each([
    {
      name: "invalid active minutes",
      options: { active: "0" },
      message: "--active must be a positive number of minutes, for example --active 30.",
    },
    {
      name: "partially numeric active minutes",
      options: { active: "10m" },
      message: "--active must be a positive number of minutes, for example --active 30.",
    },
    {
      name: "an invalid limit",
      options: { limit: "0" },
      message: '--limit must be a positive integer or "all", for example --limit 25.',
    },
    {
      name: "active minutes before an invalid limit",
      options: { active: "0", limit: "0" },
      message: "--active must be a positive number of minutes, for example --active 30.",
    },
  ])("rejects $name before reading session stores", async ({ options, message }) => {
    const listSessionEntries = vi.spyOn(
      await import("../config/sessions/session-accessor.js"),
      "listSessionEntriesReadOnly",
    );
    const { runtime, logs, errors } = makeRuntime();
    const runtimeExit = vi.spyOn(runtime, "exit");
    const execution = sessionsCommand(options, runtime);

    await expect(execution).rejects.toBeInstanceOf(ExpectedCliError);
    await expect(execution).rejects.toMatchObject({
      message,
      humanOutput: message,
      machineOutput: message,
    });
    expect(logs).toEqual([]);
    expect(errors).toEqual([]);
    expect(runtimeExit).not.toHaveBeenCalled();
    expect(listSessionEntries).not.toHaveBeenCalled();
  });
});
