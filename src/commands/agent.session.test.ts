import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { resolveAgentDir, resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolveSession } from "../agents/command/session.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
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
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(sessions));
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

  it("forwards resolved outbound session context when resuming by sessionId", async () => {
    await withCrossAgentResumeFixture(async ({ sessionId, sessionKey, cfg }) => {
      const resolution = resolveSession({ cfg, sessionId });
      expect(resolution.sessionKey).toBe(sessionKey);
      const agentId = resolveSessionAgentId({ sessionKey: resolution.sessionKey, config: cfg });
      expect(
        buildOutboundSessionContext({
          cfg,
          sessionKey: resolution.sessionKey,
          agentId,
        }),
      ).toEqual(
        expect.objectContaining({
          key: sessionKey,
          agentId: "exec",
        }),
      );
    });
  });
});
