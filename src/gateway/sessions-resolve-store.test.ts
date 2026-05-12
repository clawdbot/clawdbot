import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStorePath, saveSessionStore } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { ErrorCodes } from "./protocol/index.js";
import { resolveSessionKeyFromResolveParams } from "./sessions-resolve.js";

describe("resolveSessionKeyFromResolveParams store canonicalization", () => {
  const freshUpdatedAt = () => Date.now();

  it("resolves legacy main-alias matches by sessionId and label for the configured default agent", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-alias-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "sessions.json");
      const cfg = {
        session: { store: storePath, mainKey: "main" },
        agents: { list: [{ id: "ops", default: true }] },
      } satisfies OpenClawConfig;
      await saveSessionStore(storePath, {
        "agent:main:main": {
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
      await saveSessionStore(workStorePath, {
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
      await saveSessionStore(resolveStorePath(cfg.session?.store, { agentId: "main" }), {
        "main-target": {
          sessionId: "sess-shared",
          label: "shared-label",
          updatedAt,
        },
      });
      await saveSessionStore(resolveStorePath(cfg.session?.store, { agentId: "work" }), {
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
    await withStateDirEnv("openclaw-sessions-resolve-stale-main-", async ({ stateDir }) => {
      const storePath = path.join(stateDir, "sessions.json");
      const cfg = {
        session: { store: storePath, mainKey: "main" },
        agents: { list: [{ id: "ops", default: true }] },
      } satisfies OpenClawConfig;
      await saveSessionStore(storePath, {
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
      await saveSessionStore(staleMainStorePath, {
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

  it("rejects an explicit listed deleted main key instead of remapping to the live default main", async () => {
    await withStateDirEnv("openclaw-sessions-resolve-key-deleted-main-", async () => {
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "ops", default: true }] },
      };
      const liveDefaultStorePath = resolveStorePath(cfg.session?.store, { agentId: "ops" });
      await saveSessionStore(liveDefaultStorePath, {
        "agent:ops:main": {
          sessionId: "sess-live-default",
          updatedAt: freshUpdatedAt(),
        },
      });
      const staleMainStorePath = resolveStorePath(cfg.session?.store, { agentId: "main" });
      await saveSessionStore(staleMainStorePath, {
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
