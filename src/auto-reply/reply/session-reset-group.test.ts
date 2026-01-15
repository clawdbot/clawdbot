import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import { initSessionState } from "./session.js";

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

  function makeCfg(params: { storePath: string; allowFrom: string[] }): ClawdbotConfig {
    return {
      session: { store: params.storePath, idleMinutes: 999 },
      channels: {
        whatsapp: {
          allowFrom: params.allowFrom,
          groupPolicy: "open",
        },
      },
    } as ClawdbotConfig;
  }

  it("Reset trigger /new works for authorized sender in WhatsApp group", async () => {
    const storePath = await createStorePath("clawdbot-group-reset-");
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

    // Group message context matching what WhatsApp handler creates
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

    // The reset should be detected
    expect(result.triggerBodyNormalized).toBe("/new");
    expect(result.isNewSession).toBe(true);
    expect(result.sessionId).not.toBe(existingSessionId);
    expect(result.bodyStripped).toBe("");
  });

  it("Reset trigger /new blocked for unauthorized sender in existing session", async () => {
    const storePath = await createStorePath("clawdbot-group-reset-unauth-");
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

    // Group message from different sender (not in allowFrom)
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
      SenderE164: "+1555123456", // Different sender (not authorized)
      SenderId: "1555123456:0@s.whatsapp.net",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    // Reset should NOT be triggered for unauthorized sender - session ID should stay the same
    expect(result.triggerBodyNormalized).toBe("/new");
    expect(result.sessionId).toBe(existingSessionId); // Session should NOT change
    expect(result.isNewSession).toBe(false);
  });

  it("Reset trigger works when RawBody is clean but Body has wrapped context", async () => {
    const storePath = await createStorePath("clawdbot-group-rawbody-");
    const sessionKey = "agent:main:whatsapp:group:G1";
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
      // Body is wrapped with context prefixes
      Body: `[WhatsApp 120363406150318674@g.us 2026-01-13T07:45Z] Jake: /new\n[from: Jake (+1222)]`,
      // RawBody is clean
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
    const storePath = await createStorePath("clawdbot-group-reset-lid-");
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
    const storePath = await createStorePath("clawdbot-group-reset-lid-unauth-");
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
