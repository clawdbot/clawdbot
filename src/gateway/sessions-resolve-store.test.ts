/**
 * Session resolve store tests.
 */
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ErrorCodes } from "../../packages/gateway-protocol/src/index.js";
import { writeAcpSessionMetaForMigration } from "../acp/runtime/session-meta.js";
import { resolveStorePath, type SessionEntry } from "../config/sessions.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withStateDirEnv as withRawStateDirEnv } from "../test-helpers/state-dir-env.js";
import { resolveSessionKeyFromResolveParams } from "./sessions-resolve.js";

describe("resolveSessionKeyFromResolveParams store canonicalization", () => {
  const freshUpdatedAt = () => Date.now();

  function closeSessionSqliteDatabasesForTest(): void {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  }

  async function withStateDirEnv<T>(
    prefix: string,
    fn: (ctx: { tempRoot: string; stateDir: string }) => Promise<T>,
  ): Promise<T> {
    return withRawStateDirEnv(prefix, async (ctx) => {
      try {
        return await fn(ctx);
      } finally {
        closeSessionSqliteDatabasesForTest();
      }
    });
  }

  async function seedSessionStore(
    storePath: string,
    store: Record<string, SessionEntry>,
  ): Promise<void> {
    for (const [sessionKey, entry] of Object.entries(store)) {
      await replaceSessionEntry({ storePath, sessionKey }, entry);
    }
  }

  afterEach(() => {
    closeSessionSqliteDatabasesForTest();
  });

  it("resolves configured default-agent main sessions by sessionId and label", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-alias-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "sessions.json");
      const cfg = {
        session: { store: storePath, mainKey: "main" },
        agents: { list: [{ id: "ops", default: true }] },
      } satisfies OpenClawConfig;
      await seedSessionStore(storePath, {
        "agent:ops:main": {
          sessionId: "sess-default-alias",
          label: "default-alias",
          updatedAt: freshUpdatedAt(),
        },
      });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { sessionId: "sess-default-alias" },
        }),
      ).resolves.toEqual({ ok: true, key: "agent:ops:main" });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { label: "default-alias" },
        }),
      ).resolves.toEqual({ ok: true, key: "agent:ops:main" });
    });
  });

  it("does not resolve another agent store when agentId is scoped", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-agent-scope-", async () => {
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      };
      const workStorePath = resolveStorePath(cfg.session?.store, { agentId: "work" });
      await seedSessionStore(workStorePath, {
        "agent:work:target": {
          sessionId: "sess-shared",
          label: "shared-label",
          updatedAt: freshUpdatedAt(),
        },
      });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { sessionId: "sess-shared", agentId: "main" },
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: "No session found: sess-shared",
        },
      });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { label: "shared-label", agentId: "main" },
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: "No session found with label: shared-label",
        },
      });
    });
  });

  it("preserves cross-agent ambiguity when agentId is absent", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-cross-agent-", async () => {
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }, { id: "work" }] },
      };
      const updatedAt = freshUpdatedAt();
      await seedSessionStore(resolveStorePath(cfg.session?.store, { agentId: "main" }), {
        "main-target": {
          sessionId: "sess-shared",
          label: "shared-label",
          updatedAt,
        },
      });
      await seedSessionStore(resolveStorePath(cfg.session?.store, { agentId: "work" }), {
        "work-target": {
          sessionId: "sess-shared",
          label: "shared-label",
          updatedAt,
        },
      });

      const sessionIdResult = await resolveSessionKeyFromResolveParams({
        cfg,
        p: { sessionId: "sess-shared" },
      });
      expect(sessionIdResult.ok).toBe(false);
      if (sessionIdResult.ok) {
        throw new Error("expected ambiguous sessionId result");
      }
      expect(sessionIdResult.error.code).toBe(ErrorCodes.INVALID_REQUEST);
      expect(sessionIdResult.error.message).toContain(
        "Multiple sessions found for sessionId: sess-shared",
      );
      expect(sessionIdResult.error.message).toContain("agent:main:main-target");
      expect(sessionIdResult.error.message).toContain("agent:work:work-target");

      const labelResult = await resolveSessionKeyFromResolveParams({
        cfg,
        p: { label: "shared-label" },
      });
      expect(labelResult.ok).toBe(false);
      if (labelResult.ok) {
        throw new Error("expected ambiguous label result");
      }
      expect(labelResult.error.code).toBe(ErrorCodes.INVALID_REQUEST);
      expect(labelResult.error.message).toContain(
        "Multiple sessions found with label: shared-label",
      );
      expect(labelResult.error.message).toContain("agent:main:main-target");
      expect(labelResult.error.message).toContain("agent:work:work-target");
    });
  });

  it("still rejects non-alias agent:main matches when main is no longer configured", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-stale-main-", async () => {
      const cfg = {
        session: { mainKey: "main", store: undefined },
        agents: { list: [{ id: "ops", default: true }] },
      } satisfies OpenClawConfig;
      await seedSessionStore(resolveStorePath(cfg.session?.store, { agentId: "main" }), {
        "agent:main:guildchat:direct:u1": {
          sessionId: "sess-stale-main",
          label: "stale-main",
          updatedAt: freshUpdatedAt(),
        },
      });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { sessionId: "sess-stale-main" },
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: 'Agent "main" no longer exists in configuration',
        },
      });
    });
  });

  it("does not adopt legacy main aliases from discovered deleted-agent stores", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-discovered-main-", async () => {
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "ops", default: true }] },
      };
      const staleMainStorePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
      await seedSessionStore(staleMainStorePath, {
        "agent:main:main": {
          sessionId: "sess-discovered-main",
          label: "discovered-main",
          updatedAt: freshUpdatedAt(),
        },
      });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { sessionId: "sess-discovered-main" },
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: 'Agent "main" no longer exists in configuration',
        },
      });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { label: "discovered-main" },
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: 'Agent "main" no longer exists in configuration',
        },
      });
    });
  });

  it("resolves ACP harness session keys from real stores when harness id is not in agents.list", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-acp-harness-", async () => {
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }] },
      };
      const acpKey = "agent:claude:acp:11111111-1111-4111-8111-111111111111";
      const claudeStorePath = resolveStorePath(cfg.session?.store, { agentId: "claude" });
      await seedSessionStore(claudeStorePath, {
        [acpKey]: {
          sessionId: "sess-acp-harness",
          label: "claude-delegate",
          updatedAt: freshUpdatedAt(),
        },
      });
      writeAcpSessionMetaForMigration({
        sessionKey: acpKey,
        lifecycleRevision: undefined,
        meta: {
          backend: "acpx",
          agent: "claude",
          runtimeSessionName: acpKey,
          mode: "oneshot",
          state: "idle",
          lastActivityAt: freshUpdatedAt(),
        },
      });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { key: acpKey },
        }),
      ).resolves.toEqual({ ok: true, key: acpKey });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { sessionId: "sess-acp-harness" },
        }),
      ).resolves.toEqual({ ok: true, key: acpKey });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { label: "claude-delegate" },
        }),
      ).resolves.toEqual({ ok: true, key: acpKey });
    });
  });

  it("repairs ACP metadata when the session store key was already canonicalized", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-acp-harness-partial-", async () => {
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }] },
      };
      const acpKey = "agent:claude:acp:44444444-4444-4444-8444-444444444444";
      const legacyAcpKey = "agent:CLAUDE:acp:44444444-4444-4444-8444-444444444444";
      const claudeStorePath = resolveStorePath(cfg.session?.store, { agentId: "claude" });
      await seedSessionStore(claudeStorePath, {
        [acpKey]: {
          sessionId: "sess-acp-harness-partial",
          label: "claude-delegate-partial",
          updatedAt: freshUpdatedAt(),
        },
      });
      writeAcpSessionMetaForMigration({
        sessionKey: legacyAcpKey,
        lifecycleRevision: undefined,
        meta: {
          backend: "acpx",
          agent: "claude",
          runtimeSessionName: legacyAcpKey,
          mode: "oneshot",
          state: "idle",
          lastActivityAt: freshUpdatedAt(),
        },
      });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { key: acpKey },
        }),
      ).resolves.toEqual({ ok: true, key: acpKey });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { key: acpKey },
        }),
      ).resolves.toEqual({ ok: true, key: acpKey });
    });
  });

  it("rejects ACP-shaped bridge sessions without ACP runtime metadata under deleted agents", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-acp-bridge-deleted-", async () => {
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }] },
      };
      const acpBridgeKey = "agent:deleted-agent:acp:bridge-session-without-runtime-meta";
      const deletedStorePath = resolveStorePath(cfg.session?.store, { agentId: "deleted-agent" });
      await seedSessionStore(deletedStorePath, {
        [acpBridgeKey]: {
          sessionId: "sess-acp-bridge-deleted",
          label: "deleted-bridge",
          updatedAt: freshUpdatedAt(),
        },
      });
      const expected = {
        ok: false,
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: 'Agent "deleted-agent" no longer exists in configuration',
        },
      };

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { key: acpBridgeKey },
        }),
      ).resolves.toEqual(expected);

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { sessionId: "sess-acp-bridge-deleted" },
        }),
      ).resolves.toEqual(expected);

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { label: "deleted-bridge" },
        }),
      ).resolves.toEqual(expected);
    });
  });

  it("rejects configured ACP binding sessions when their owning agent is deleted", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-acp-binding-deleted-", async () => {
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }] },
      };
      const acpBindingKey = "agent:deleted-agent:acp:binding:discord:default:feedface";
      const deletedStorePath = resolveStorePath(cfg.session?.store, { agentId: "deleted-agent" });
      await seedSessionStore(deletedStorePath, {
        [acpBindingKey]: {
          sessionId: "sess-acp-binding-deleted",
          label: "deleted-binding",
          updatedAt: freshUpdatedAt(),
        },
      });
      const expected = {
        ok: false,
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: 'Agent "deleted-agent" no longer exists in configuration',
        },
      };

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { key: acpBindingKey },
        }),
      ).resolves.toEqual(expected);

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { sessionId: "sess-acp-binding-deleted" },
        }),
      ).resolves.toEqual(expected);

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { label: "deleted-binding" },
        }),
      ).resolves.toEqual(expected);
    });
  });

  it("rejects an explicit listed deleted main key instead of remapping to the live default main", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-key-deleted-main-", async () => {
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "ops", default: true }] },
      };
      const liveDefaultStorePath = resolveStorePath(cfg.session?.store, { agentId: "ops" });
      await seedSessionStore(liveDefaultStorePath, {
        "agent:ops:main": {
          sessionId: "sess-live-default",
          updatedAt: freshUpdatedAt(),
        },
      });
      const staleMainStorePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
      await seedSessionStore(staleMainStorePath, {
        "agent:main:main": {
          sessionId: "sess-deleted-main",
          updatedAt: freshUpdatedAt(),
        },
      });

      await expect(
        resolveSessionKeyFromResolveParams({
          cfg,
          p: { key: "agent:main:main" },
        }),
      ).resolves.toEqual({
        ok: false,
        error: {
          code: ErrorCodes.INVALID_REQUEST,
          message: 'Agent "main" no longer exists in configuration',
        },
      });
    });
  });
});
