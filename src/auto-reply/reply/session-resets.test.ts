import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { buildModelAliasIndex } from "../../agents/model-selection.js";
import type { MoltbotConfig } from "../../config/config.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "../../infra/system-events.js";
import { initSessionState } from "./session.js";
import { applyResetModelOverride } from "./session-reset-model.js";
import { prependSystemEvents } from "./session-updates.js";

vi.mock("../../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(async () => [
    { provider: "minimax", id: "m2.1", name: "M2.1" },
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  ]),
}));

describe("initSessionState reset triggers in WhatsApp groups", () => {
  async function createStorePath(prefix: string): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    return path.join(root, "sessions.json");
  }

  async function seedSessionStore(params: {
    storePath: string;
    sessionKey: string;
    sessionId: string;
  }): Promise<void> {
    const { saveSessionStore } = await import("../../config/sessions.js");
    await saveSessionStore(params.storePath, {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    });
  }

  function makeCfg(params: { storePath: string; allowFrom: string[] }): MoltbotConfig {
    return {
      session: { store: params.storePath, idleMinutes: 999 },
      channels: {
        whatsapp: {
          allowFrom: params.allowFrom,
          groupPolicy: "open",
        },
      },
    } as MoltbotConfig;
  }

  it("Reset trigger /new works for authorized sender in WhatsApp group", async () => {
    const storePath = await createStorePath("moltbot-group-reset-");
    const sessionKey = "agent:main:whatsapp:group:120363406150318674@g.us";
    const existingSessionId = "existing-session-123";
    await seedSessionStore({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
    });

    const cfg = makeCfg({
      storePath,
      allowFrom: ["+41796666864"],
    });

    const groupMessageCtx = {
      Body: `[Chat messages since your last reply - for context]\\n[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Someone: hello\\n\\n[Current message - respond to this]\\n[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Peschiño: /new\\n[from: Peschiño (+41796666864)]`,
      RawBody: "/new",
      CommandBody: "/new",
      From: "120363406150318674@g.us",
      To: "+41779241027",
      ChatType: "group",
      SessionKey: sessionKey,
      Provider: "whatsapp",
      Surface: "whatsapp",
      SenderName: "Peschiño",
      SenderE164: "+41796666864",
      SenderId: "41796666864:0@s.whatsapp.net",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.triggerBodyNormalized).toBe("/new");
    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.bodyStripped).toBe("");
  });

  it("Reset trigger /new blocked for unauthorized sender in existing session", async () => {
    const storePath = await createStorePath("moltbot-group-reset-unauth-");
    const sessionKey = "agent:main:whatsapp:group:120363406150318674@g.us";
    const existingSessionId = "existing-session-123";

    await seedSessionStore({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
    });

    const cfg = makeCfg({
      storePath,
      allowFrom: ["+41796666864"],
    });

    const groupMessageCtx = {
      Body: `[Context]\\n[WhatsApp ...] OtherPerson: /new\\n[from: OtherPerson (+1555123456)]`,
      RawBody: "/new",
      CommandBody: "/new",
      From: "120363406150318674@g.us",
      To: "+41779241027",
      ChatType: "group",
      SessionKey: sessionKey,
      Provider: "whatsapp",
      Surface: "whatsapp",
      SenderName: "OtherPerson",
      SenderE164: "+1555123456",
      SenderId: "1555123456:0@s.whatsapp.net",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.triggerBodyNormalized).toBe("/new");
    expect(result.sessionId).toBe(existingSessionId);
    expect(result.isNewSession).toBe(false);
  });

  it("Reset trigger works when RawBody is clean but Body has wrapped context", async () => {
    const storePath = await createStorePath("moltbot-group-rawbody-");
    const sessionKey = "agent:main:whatsapp:group:g1";
    const existingSessionId = "existing-session-123";
    await seedSessionStore({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
    });

    const cfg = makeCfg({
      storePath,
      allowFrom: ["*"],
    });

    const groupMessageCtx = {
      Body: `[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Jake: /new\n[from: Jake (+1222)]`,
      RawBody: "/new",
      CommandBody: "/new",
      From: "120363406150318674@g.us",
      To: "+1111",
      ChatType: "group",
      SessionKey: sessionKey,
      Provider: "whatsapp",
      SenderE164: "+1222",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.triggerBodyNormalized).toBe("/new");
    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.bodyStripped).toBe("");
  });

  it("Reset trigger /new works when SenderId is LID but SenderE164 is authorized", async () => {
    const storePath = await createStorePath("moltbot-group-reset-lid-");
    const sessionKey = "agent:main:whatsapp:group:120363406150318674@g.us";
    const existingSessionId = "existing-session-123";
    await seedSessionStore({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
    });

    const cfg = makeCfg({
      storePath,
      allowFrom: ["+41796666864"],
    });

    const groupMessageCtx = {
      Body: `[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Owner: /new\n[from: Owner (+41796666864)]`,
      RawBody: "/new",
      CommandBody: "/new",
      From: "120363406150318674@g.us",
      To: "+41779241027",
      ChatType: "group",
      SessionKey: sessionKey,
      Provider: "whatsapp",
      Surface: "whatsapp",
      SenderName: "Owner",
      SenderE164: "+41796666864",
      SenderId: "123@lid",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.triggerBodyNormalized).toBe("/new");
    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.bodyStripped).toBe("");
  });

  it("Reset trigger /new blocked when SenderId is LID but SenderE164 is unauthorized", async () => {
    const storePath = await createStorePath("moltbot-group-reset-lid-unauth-");
    const sessionKey = "agent:main:whatsapp:group:120363406150318674@g.us";
    const existingSessionId = "existing-session-123";
    await seedSessionStore({
      storePath,
      sessionKey,
      sessionId: existingSessionId,
    });

    const cfg = makeCfg({
      storePath,
      allowFrom: ["+41796666864"],
    });

    const groupMessageCtx = {
      Body: `[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Other: /new\n[from: Other (+1555123456)]`,
      RawBody: "/new",
      CommandBody: "/new",
      From: "120363406150318674@g.us",
      To: "+41779241027",
      ChatType: "group",
      SessionKey: sessionKey,
      Provider: "whatsapp",
      Surface: "whatsapp",
      SenderName: "Other",
      SenderE164: "+1555123456",
      SenderId: "123@lid",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.triggerBodyNormalized).toBe("/new");
    expect(result.sessionId).toBe(existingSessionId);
    expect(result.isNewSession).toBe(false);
  });
});

describe("applyResetModelOverride", () => {
  it("selects a model hint and strips it from the body", async () => {
    const cfg = {} as MoltbotConfig;
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "openai" });
    const sessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    };
    const sessionStore = { "agent:main:dm:1": sessionEntry };
    const sessionCtx = { BodyStripped: "minimax summarize" };
    const ctx = { ChatType: "direct" };

    await applyResetModelOverride({
      cfg,
      resetTriggered: true,
      bodyStripped: "minimax summarize",
      sessionCtx,
      ctx,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex,
    });

    expect(sessionEntry.providerOverride).toBe("minimax");
    expect(sessionEntry.modelOverride).toBe("m2.1");
    expect(sessionCtx.BodyStripped).toBe("summarize");
  });

  it("clears auth profile overrides when reset applies a model", async () => {
    const cfg = {} as MoltbotConfig;
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "openai" });
    const sessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
      authProfileOverride: "anthropic:default",
      authProfileOverrideSource: "user",
      authProfileOverrideCompactionCount: 2,
    };
    const sessionStore = { "agent:main:dm:1": sessionEntry };
    const sessionCtx = { BodyStripped: "minimax summarize" };
    const ctx = { ChatType: "direct" };

    await applyResetModelOverride({
      cfg,
      resetTriggered: true,
      bodyStripped: "minimax summarize",
      sessionCtx,
      ctx,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex,
    });

    expect(sessionEntry.authProfileOverride).toBeUndefined();
    expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    expect(sessionEntry.authProfileOverrideCompactionCount).toBeUndefined();
  });

  it("skips when resetTriggered is false", async () => {
    const cfg = {} as MoltbotConfig;
    const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: "openai" });
    const sessionEntry = {
      sessionId: "s1",
      updatedAt: Date.now(),
    };
    const sessionStore = { "agent:main:dm:1": sessionEntry };
    const sessionCtx = { BodyStripped: "minimax summarize" };
    const ctx = { ChatType: "direct" };

    await applyResetModelOverride({
      cfg,
      resetTriggered: false,
      bodyStripped: "minimax summarize",
      sessionCtx,
      ctx,
      sessionEntry,
      sessionStore,
      sessionKey: "agent:main:dm:1",
      defaultProvider: "openai",
      defaultModel: "gpt-4o-mini",
      aliasIndex,
    });

    expect(sessionEntry.providerOverride).toBeUndefined();
    expect(sessionEntry.modelOverride).toBeUndefined();
    expect(sessionCtx.BodyStripped).toBe("minimax summarize");
  });
});

describe("prependSystemEvents", () => {
  it("adds a local timestamp to queued system events by default", async () => {
    vi.useFakeTimers();
    const originalTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    const timestamp = new Date("2026-01-12T20:19:17Z");
    vi.setSystemTime(timestamp);

    enqueueSystemEvent("Model switched.", { sessionKey: "agent:main:main" });

    const result = await prependSystemEvents({
      cfg: {} as MoltbotConfig,
      sessionKey: "agent:main:main",
      isMainSession: false,
      isNewSession: false,
      prefixedBodyBase: "User: hi",
    });

    expect(result).toMatch(/System: \[2026-01-12 12:19:17 [^\]]+\] Model switched\./);

    resetSystemEventsForTest();
    process.env.TZ = originalTz;
    vi.useRealTimers();
  });
});
