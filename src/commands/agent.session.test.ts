// Agent session command tests cover session resolution, agent scoping, and temp-home session stores.
import fs from "node:fs";
import path from "node:path";
import { withTempHome as withTempHomeBase } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it } from "vitest";
import { resolveAgentDir, resolveSessionAgentId } from "../agents/agent-scope.js";
import { updateSessionStoreAfterAgentRun } from "../agents/command/session-store.js";
import { resolveSession } from "../agents/command/session.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import { writeSessionStoreForTest } from "../config/sessions/test-helpers.js";
import { resolveSessionTranscriptFile } from "../config/sessions/transcript.js";
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

function writeSessionStoreSeed(
  storePath: string,
  sessions: Record<string, Record<string, unknown>>,
) {
  writeSessionStoreForTest(storePath, sessions);
}

async function withCrossAgentResumeFixture(
  run: (params: { sessionId: string; sessionKey: string; cfg: OpenClawConfig }) => Promise<void>,
): Promise<void> {
  await withTempHome(async (home) => {
    const storePattern = path.join(home, "sessions", "{agentId}", "sessions.json");
    const execStore = path.join(home, "sessions", "exec", "sessions.json");
    const sessionId = "session-exec-hook";
    const sessionKey = "agent:exec:hook:gmail:thread-1";
    writeSessionStoreSeed(execStore, {
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
      const storePattern = path.join(home, "sessions", "{agentId}", "sessions.json");
      const otherStore = path.join(home, "sessions", "other", "sessions.json");
      const retiredStore = path.join(home, "sessions", "retired", "sessions.json");
      writeSessionStoreSeed(otherStore, {
        "agent:other:main": {
          sessionId: "run-dup",
          updatedAt: Date.now() + 1_000,
        },
      });
      writeSessionStoreSeed(retiredStore, {
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
      writeSessionStoreSeed(store, {
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

  it("rotates stale terminal main sessions whose transcript is newer than the registry", async () => {
    const scenarios = [
      {
        label: "canonical main",
        mainKey: "main",
        sessionKey: "agent:main:main",
        status: "done" as const,
      },
      { label: "raw main alias", mainKey: "main", sessionKey: "main", status: "done" as const },
      {
        label: "custom main alias",
        mainKey: "work",
        sessionKey: "agent:main:main",
        status: "done" as const,
      },
      { label: "endedAt-only main", mainKey: "main", sessionKey: "agent:main:main" },
    ];
    for (const scenario of scenarios) {
      await withTempHome(async (home) => {
        const store = path.join(home, "sessions.json");
        const sessionFile = path.join(home, `session-${scenario.label.replaceAll(" ", "-")}.jsonl`);
        const sessionId = `stale-terminal-${scenario.label.replaceAll(" ", "-")}`;
        const registryUpdatedAt = Date.now() - 10_000;
        fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
        fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId }) + "\n");
        fs.utimesSync(
          sessionFile,
          (registryUpdatedAt + 5_000) / 1000,
          (registryUpdatedAt + 5_000) / 1000,
        );
        writeSessionStoreSeed(store, {
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
        const cfg = mockConfig(home, store);
        cfg.session = { ...cfg.session, mainKey: scenario.mainKey };

        const resolution = resolveSession({ cfg, sessionKey: scenario.sessionKey });

        expect(resolution.isNewSession).toBe(true);
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
        const persisted = loadSessionStore(resolution.storePath, { skipCache: true })[
          scenario.sessionKey
        ];
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
      fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId }) + "\n");
      fs.utimesSync(
        sessionFile,
        (registryUpdatedAt + 5_000) / 1000,
        (registryUpdatedAt + 5_000) / 1000,
      );
      writeSessionStoreSeed(store, {
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
      expect(fs.realpathSync.native(resolvedTranscript.sessionFile)).toBe(
        fs.realpathSync.native(sessionFile),
      );

      const persisted = loadSessionStore(resolution.storePath, { skipCache: true })[
        resolution.sessionKey
      ];
      expect(persisted?.sessionId).toBe(sessionId);
      expect(fs.realpathSync.native(persisted?.sessionFile ?? "")).toBe(
        fs.realpathSync.native(sessionFile),
      );
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
