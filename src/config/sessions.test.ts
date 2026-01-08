import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildGroupDisplayName,
  deriveSessionKey,
  loadSessionStore,
  resolveSessionKey,
  resolveSessionTranscriptPath,
  resolveSessionTranscriptsDir,
  updateLastRoute,
} from "./sessions.js";

describe("sessions", () => {
  it("returns normalized per-sender key", () => {
    expect(deriveSessionKey("per-sender", { From: "whatsapp:+1555" })).toBe(
      "+1555",
    );
  });

  it("falls back to unknown when sender missing", () => {
    expect(deriveSessionKey("per-sender", {})).toBe("unknown");
  });

  it("global scope returns global", () => {
    expect(deriveSessionKey("global", { From: "+1" })).toBe("global");
  });

  it("keeps group chats distinct", () => {
    expect(deriveSessionKey("per-sender", { From: "12345-678@g.us" })).toBe(
      "group:12345-678@g.us",
    );
  });

  it("prefixes group keys with provider when available", () => {
    expect(
      deriveSessionKey("per-sender", {
        From: "12345-678@g.us",
        ChatType: "group",
        Provider: "whatsapp",
      }),
    ).toBe("whatsapp:group:12345-678@g.us");
  });

  it("keeps explicit provider when provided in group key", () => {
    expect(
      resolveSessionKey(
        "per-sender",
        { From: "group:discord:12345", ChatType: "group" },
        "main",
      ),
    ).toBe("agent:main:discord:group:12345");
  });

  it("builds discord display name with guild+channel slugs", () => {
    expect(
      buildGroupDisplayName({
        provider: "discord",
        room: "#general",
        space: "friends-of-clawd",
        id: "123",
        key: "discord:group:123",
      }),
    ).toBe("discord:friends-of-clawd#general");
  });

  it("collapses direct chats to main by default", () => {
    expect(resolveSessionKey("per-sender", { From: "+1555" })).toBe(
      "agent:main:main",
    );
  });

  it("collapses direct chats to main even when sender missing", () => {
    expect(resolveSessionKey("per-sender", {})).toBe("agent:main:main");
  });

  it("maps direct chats to main key when provided", () => {
    expect(
      resolveSessionKey("per-sender", { From: "whatsapp:+1555" }, "main"),
    ).toBe("agent:main:main");
  });

  it("uses custom main key when provided", () => {
    expect(resolveSessionKey("per-sender", { From: "+1555" }, "primary")).toBe(
      "agent:main:primary",
    );
  });

  it("keeps global scope untouched", () => {
    expect(resolveSessionKey("global", { From: "+1555" })).toBe("global");
  });

  it("leaves groups untouched even with main key", () => {
    expect(
      resolveSessionKey("per-sender", { From: "12345-678@g.us" }, "main"),
    ).toBe("agent:main:group:12345-678@g.us");
  });

  it("updateLastRoute persists provider and target", async () => {
    const mainSessionKey = "agent:main:main";
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-sessions-"));
    const storePath = path.join(dir, "sessions.json");
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [mainSessionKey]: {
            sessionId: "sess-1",
            updatedAt: 123,
            systemSent: true,
            thinkingLevel: "low",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await updateLastRoute({
      storePath,
      sessionKey: mainSessionKey,
      provider: "telegram",
      to: "  12345  ",
    });

    const store = loadSessionStore(storePath);
    expect(store[mainSessionKey]?.sessionId).toBe("sess-1");
    expect(store[mainSessionKey]?.updatedAt).toBeGreaterThanOrEqual(123);
    expect(store[mainSessionKey]?.lastProvider).toBe("telegram");
    expect(store[mainSessionKey]?.lastTo).toBe("12345");
  });

  it("derives session transcripts dir from CLAWDBOT_STATE_DIR", () => {
    const dir = resolveSessionTranscriptsDir(
      { CLAWDBOT_STATE_DIR: "/custom/state" } as NodeJS.ProcessEnv,
      () => "/home/ignored",
    );
    expect(dir).toBe(
      path.join(path.resolve("/custom/state"), "agents", "main", "sessions"),
    );
  });

  it("falls back to CLAWDIS_STATE_DIR for session transcripts dir", () => {
    const dir = resolveSessionTranscriptsDir(
      { CLAWDIS_STATE_DIR: "/legacy/state" } as NodeJS.ProcessEnv,
      () => "/home/ignored",
    );
    expect(dir).toBe(
      path.join(path.resolve("/legacy/state"), "agents", "main", "sessions"),
    );
  });

  it("includes topic ids in session transcript filenames", () => {
    const prev = process.env.CLAWDBOT_STATE_DIR;
    process.env.CLAWDBOT_STATE_DIR = "/custom/state";
    try {
      const sessionFile = resolveSessionTranscriptPath("sess-1", "main", 123);
      expect(sessionFile).toBe(
        path.join(
          path.resolve("/custom/state"),
          "agents",
          "main",
          "sessions",
          "sess-1-topic-123.jsonl",
        ),
      );
    } finally {
      if (prev === undefined) {
        delete process.env.CLAWDBOT_STATE_DIR;
      } else {
        process.env.CLAWDBOT_STATE_DIR = prev;
      }
    }
  });
});
