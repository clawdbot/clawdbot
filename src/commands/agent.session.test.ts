// Agent session command tests cover session resolution, agent scoping, and temp-home session stores.
import path from "node:path";
import { withTempHome as withTempHomeBase } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentDir, resolveSessionAgentId } from "../agents/agent-scope.js";
import { updateSessionStoreAfterAgentRun } from "../agents/command/session-store.js";
import { resolveSession } from "../agents/command/session.js";
import {
  appendTranscriptEvent,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import { resolveSessionTranscriptFile } from "../config/sessions/transcript.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, {
    prefix: "openclaw-agent-session-",
    skipSessionCleanup: true,
  });
}

function mockConfig(
  home: string,
  storePath: string,
  agentsList?: Array<{ id: string; default?: boolean }>,
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
        workspace: path.join(home, "openclaw"),
      },
      list: agentsList,
    },
    session: { store: storePath, mainKey: "main" },
  } as OpenClawConfig;
}

async function writeSessionStoreSeed(
  storePath: string,
  sessions: Record<string, SessionEntry>,
): Promise<void> {
  await Promise.all(
    Object.entries(sessions).map(([sessionKey, entry]) =>
      replaceSessionEntry({ sessionKey, storePath }, entry),
    ),
  );
}

async function withCrossAgentResumeFixture(
  run: (params: { sessionId: string; sessionKey: string; cfg: OpenClawConfig }) => Promise<void>,
): Promise<void> {
  await withTempHome(async (home) => {
    const storePattern = path.join(home, "agents", "{agentId}", "sessions", "sessions.json");
    const execStore = path.join(home, "agents", "exec", "sessions", "sessions.json");
    const sessionId = "session-exec-hook";
    const sessionKey = "agent:exec:hook:gmail:thread-1";
    await writeSessionStoreSeed(execStore, {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        systemSent: true,
      },
    });
    const cfg = mockConfig(home, storePattern, [{ id: "dev" }, { id: "exec", default: true }]);
    await run({ sessionId, sessionKey, cfg });
  });
}

beforeEach(() => {
  clearSessionStoreCacheForTest();
  // Freshness fixtures seed times relative to Date.now(); near the 04:00
  // local daily-reset boundary the seeded window straddles it and reuse
  // scenarios flip to new sessions. Pin local noon so no timezone can hit it.
  vi.useFakeTimers({ toFake: ["Date"] });
  const localNoon = new Date();
  localNoon.setHours(12, 0, 0, 0);
  vi.setSystemTime(localNoon);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("agent session resolution", () => {
  it("creates a stable session key for explicit session-id-only runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const cfg = mockConfig(home, store);

      const resolution = resolveSession({ cfg, sessionId: "explicit-session-123" });

      expect(resolution.sessionKey).toBe("agent:main:explicit:explicit-session-123");
      expect(resolution.sessionId).toBe("explicit-session-123");
    });
  });

  it("uses the resumed session agent scope when sessionId resolves to another agent store", async () => {
    await withCrossAgentResumeFixture(async ({ sessionId, sessionKey, cfg }) => {
      const resolution = resolveSession({ cfg, sessionId });
      expect(resolution.sessionKey).toBe(sessionKey);
      const agentId = resolveSessionAgentId({ sessionKey: resolution.sessionKey, config: cfg });
      expect(agentId).toBe("exec");
      expect(resolveAgentDir(cfg, agentId)).toContain(
        `${path.sep}agents${path.sep}exec${path.sep}agent`,
      );
    });
  });

  it("resolves duplicate cross-agent sessionIds deterministically", async () => {
    await withTempHome(async (home) => {
      const storePattern = path.join(home, "agents", "{agentId}", "sessions", "sessions.json");
      const otherStore = path.join(home, "agents", "other", "sessions", "sessions.json");
      const retiredStore = path.join(home, "agents", "retired", "sessions", "sessions.json");
      await writeSessionStoreSeed(otherStore, {
        "agent:other:main": {
          sessionId: "run-dup",
          updatedAt: Date.now() + 1_000,
        },
      });
      await writeSessionStoreSeed(retiredStore, {
        "agent:retired:acp:run-dup": {
          sessionId: "run-dup",
          updatedAt: Date.now(),
        },
      });
      const cfg = mockConfig(home, storePattern, [
        { id: "other" },
        { id: "retired", default: true },
      ]);

      const resolution = resolveSession({ cfg, sessionId: "run-dup" });

      expect(resolution.sessionKey).toBe("agent:retired:acp:run-dup");
      expect(resolution.storePath).toBe(retiredStore);
    });
  });

  it("uses origin.provider for channel-specific session reset overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      await writeSessionStoreSeed(store, {
        main: {
          sessionId: "origin-provider-reset",
          updatedAt: Date.now() - 30 * 60_000,
          origin: { provider: "quietchat" },
        },
      });
      const cfg = mockConfig(home, store);
      cfg.session = {
        ...cfg.session,
        reset: { mode: "idle", idleMinutes: 10 },
        resetByChannel: {
          quietchat: { mode: "idle", idleMinutes: 120 },
        },
      };

      const resolution = resolveSession({ cfg, sessionKey: "main" });

      expect(resolution.sessionId).toBe("origin-provider-reset");
      expect(resolution.isNewSession).toBe(false);
    });
  });

  it("handles terminal main sessions whose transcript is newer than the registry", async () => {
    const scenarios = [
      {
        label: "canonical done main",
        mainKey: "main",
        sessionKey: "agent:main:main",
        status: "done" as const,
        expectNewSession: false,
      },
      {
        label: "raw done main alias",
        mainKey: "main",
        sessionKey: "main",
        status: "done" as const,
        expectNewSession: false,
      },
      {
        label: "custom done main alias",
        mainKey: "work",
        sessionKey: "agent:main:main",
        status: "done" as const,
        expectNewSession: false,
      },
      {
        label: "killed main",
        mainKey: "main",
        sessionKey: "agent:main:main",
        status: "killed" as const,
        expectNewSession: true,
      },
      {
        label: "endedAt-only main",
        mainKey: "main",
        sessionKey: "agent:main:main",
        status: undefined,
        expectNewSession: true,
      },
    ] as const;
    for (const scenario of scenarios) {
      await withTempHome(async (home) => {
        const store = path.join(home, "sessions.json");
        const sessionFile = path.join(home, `session-${scenario.label.replaceAll(" ", "-")}.jsonl`);
        const sessionId = `stale-terminal-${scenario.label.replaceAll(" ", "-")}`;
        const registryUpdatedAt = Date.now() - 10_000;
        await writeSessionStoreSeed(store, {
          [scenario.sessionKey]: {
            sessionId,
            sessionFile,
            updatedAt: registryUpdatedAt,
            ...(scenario.status ? { status: scenario.status } : {}),
            sessionStartedAt: registryUpdatedAt - 60_000,
            lastInteractionAt: registryUpdatedAt - 30_000,
            startedAt: registryUpdatedAt - 1_000,
            endedAt: registryUpdatedAt - 100,
            cliSessionBindings: {
              "claude-cli": { sessionId: "old-claude-cli-session" },
              "codex-cli": { sessionId: "old-codex-cli-session" },
            },
            cliSessionIds: {
              "claude-cli": "old-claude-cli-session",
              "codex-cli": "old-codex-cli-session",
            },
            claudeCliSessionId: "old-claude-cli-session",
          },
        });
        await appendTranscriptEvent(
          {
            agentId: "main",
            sessionId,
            sessionKey: scenario.sessionKey,
            storePath: store,
          },
          { type: "custom", timestamp: "1970-01-01T00:00:00.001Z" },
        );
        const cfg = mockConfig(home, store);
        cfg.session = { ...cfg.session, mainKey: scenario.mainKey };

        const resolution = resolveSession({ cfg, sessionKey: scenario.sessionKey });

        expect(resolution.isNewSession).toBe(scenario.expectNewSession);
        if (!scenario.expectNewSession) {
          expect(resolution.sessionId).toBe(sessionId);
          return;
        }
        expect(resolution.sessionId).not.toBe(sessionId);
        expect(resolution.sessionEntry?.sessionFile).toBeUndefined();
        expect(resolution.sessionEntry?.status).toBeUndefined();
        expect(resolution.sessionEntry?.startedAt).toBeUndefined();
        expect(resolution.sessionEntry?.endedAt).toBeUndefined();
        expect(resolution.sessionEntry?.runtimeMs).toBeUndefined();
        expect(resolution.sessionEntry?.sessionStartedAt).toBeUndefined();
        expect(resolution.sessionEntry?.lastInteractionAt).toBeUndefined();
        expect(resolution.sessionEntry?.cliSessionBindings).toBeUndefined();
        expect(resolution.sessionEntry?.cliSessionIds).toBeUndefined();
        expect(resolution.sessionEntry?.claudeCliSessionId).toBeUndefined();

        const sessionStore = {
          [scenario.sessionKey]: resolution.sessionEntry!,
        };
        await resolveSessionTranscriptFile({
          sessionId: resolution.sessionId,
          sessionKey: scenario.sessionKey,
          sessionEntry: resolution.sessionEntry,
          sessionStore,
          storePath: resolution.storePath,
          agentId: "main",
        });
        await updateSessionStoreAfterAgentRun({
          cfg,
          sessionId: resolution.sessionId,
          sessionKey: scenario.sessionKey,
          storePath: resolution.storePath,
          sessionStore,
          defaultProvider: "openai",
          defaultModel: "gpt-5.5",
          result: {
            payloads: [],
            meta: {
              aborted: false,
              agentMeta: {
                provider: "openai",
                model: "gpt-5.5",
              },
            },
          } as never,
        });
        const persisted = loadSessionEntry({
          sessionKey: scenario.sessionKey,
          storePath: resolution.storePath,
        });
        expect(persisted?.sessionId).toBe(resolution.sessionId);
        expect(persisted?.sessionFile).not.toBe(sessionFile);
        expect(persisted?.status).toBeUndefined();
        expect(persisted?.startedAt).toBeUndefined();
        expect(persisted?.endedAt).toBeUndefined();
        expect(persisted?.runtimeMs).toBeUndefined();
        expect(persisted?.cliSessionBindings).toBeUndefined();
        expect(persisted?.cliSessionIds).toBeUndefined();
        expect(persisted?.claudeCliSessionId).toBeUndefined();
        expect(persisted?.sessionStartedAt).toBeGreaterThan(registryUpdatedAt);
        expect(persisted?.lastInteractionAt).toBeGreaterThan(registryUpdatedAt);
      });
    }
  });

  it("preserves explicit session-id resumes for stale terminal main rows", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionFile = path.join(home, "explicit-terminal-main.jsonl");
      const sessionId = "explicit-terminal-main";
      const registryUpdatedAt = Date.now() - 10_000;
      await writeSessionStoreSeed(store, {
        "agent:main:main": {
          sessionId,
          sessionFile,
          updatedAt: registryUpdatedAt,
          status: "done",
          startedAt: registryUpdatedAt - 1_000,
          endedAt: registryUpdatedAt - 100,
          runtimeMs: 900,
        },
      });
      await appendTranscriptEvent(
        {
          agentId: "main",
          sessionId,
          sessionKey: "agent:main:main",
          storePath: store,
        },
        { type: "custom", timestamp: "1970-01-01T00:00:00.001Z" },
      );
      const cfg = mockConfig(home, store);

      const resolution = resolveSession({ cfg, sessionId });

      expect(resolution.sessionKey).toBe("agent:main:main");
      expect(resolution.sessionId).toBe(sessionId);
      expect(resolution.isNewSession).toBe(false);
      expect(resolution.sessionEntry?.sessionFile).toBe(sessionFile);
      expect(resolution.sessionEntry?.status).toBe("done");
      expect(resolution.sessionEntry?.startedAt).toBe(registryUpdatedAt - 1_000);
      expect(resolution.sessionEntry?.endedAt).toBe(registryUpdatedAt - 100);
      expect(resolution.sessionEntry?.runtimeMs).toBe(900);

      if (!resolution.sessionKey || !resolution.sessionStore) {
        throw new Error("expected resolved explicit session store");
      }
      const resolvedTranscript = await resolveSessionTranscriptFile({
        sessionId: resolution.sessionId,
        sessionKey: resolution.sessionKey,
        sessionEntry: resolution.sessionEntry,
        sessionStore: resolution.sessionStore,
        storePath: resolution.storePath,
        agentId: "main",
      });
      expect(resolvedTranscript.sessionFile).toBe(
        `sqlite:main:${sessionId}:${resolution.storePath}`,
      );

      const persisted = loadSessionEntry({
        sessionKey: resolution.sessionKey,
        storePath: resolution.storePath,
      });
      expect(persisted?.sessionId).toBe(sessionId);
      expect(persisted?.sessionFile).toBe(resolvedTranscript.sessionFile);
      expect(persisted?.status).toBe("done");
      expect(persisted?.startedAt).toBe(registryUpdatedAt - 1_000);
      expect(persisted?.endedAt).toBe(registryUpdatedAt - 100);
      expect(persisted?.runtimeMs).toBe(900);
    });
  });

  it("forwards resolved outbound session context when resuming by sessionId", async () => {
    await withCrossAgentResumeFixture(async ({ sessionId, sessionKey, cfg }) => {
      const resolution = resolveSession({ cfg, sessionId });
      expect(resolution.sessionKey).toBe(sessionKey);
      const agentId = resolveSessionAgentId({ sessionKey: resolution.sessionKey, config: cfg });
      const outboundContext = buildOutboundSessionContext({
        cfg,
        sessionKey: resolution.sessionKey,
        agentId,
      });
      if (!outboundContext) {
        throw new Error("expected outbound session context");
      }
      expect(outboundContext.key).toBe(sessionKey);
      expect(outboundContext.agentId).toBe("exec");
    });
  });
});
