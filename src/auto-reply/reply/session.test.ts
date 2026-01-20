import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "../../config/config.js";
import { saveSessionStore } from "../../config/sessions.js";
import { initSessionState } from "./session.js";

describe("initSessionState thread forking", () => {
  it("forks a new session from the parent session file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-thread-session-"));
    const sessionsDir = path.join(root, "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    const parentSessionId = "parent-session";
    const parentSessionFile = path.join(sessionsDir, "parent.jsonl");
    const header = {
      type: "session",
      version: 3,
      id: parentSessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    const message = {
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "Parent prompt" },
    };
    await fs.writeFile(
      parentSessionFile,
      `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`,
      "utf-8",
    );

    const storePath = path.join(root, "sessions.json");
    const parentSessionKey = "agent:main:slack:channel:C1";
    await saveSessionStore(storePath, {
      [parentSessionKey]: {
        sessionId: parentSessionId,
        sessionFile: parentSessionFile,
        updatedAt: Date.now(),
      },
    });

    const cfg = {
      session: { store: storePath },
    } as ClawdbotConfig;

    const threadSessionKey = "agent:main:slack:channel:C1:thread:123";
    const threadLabel = "Slack thread #general: starter";
    const result = await initSessionState({
      ctx: {
        Body: "Thread reply",
        SessionKey: threadSessionKey,
        ParentSessionKey: parentSessionKey,
        ThreadLabel: threadLabel,
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionKey).toBe(threadSessionKey);
    expect(result.sessionEntry.sessionId).not.toBe(parentSessionId);
    expect(result.sessionEntry.sessionFile).toBeTruthy();
    expect(result.sessionEntry.displayName).toBe(threadLabel);

    const newSessionFile = result.sessionEntry.sessionFile;
    if (!newSessionFile) {
      throw new Error("Missing session file for forked thread");
    }
    const [headerLine] = (await fs.readFile(newSessionFile, "utf-8"))
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0);
    const parsedHeader = JSON.parse(headerLine) as {
      parentSession?: string;
    };
    expect(parsedHeader.parentSession).toBe(parentSessionFile);
  });

  it("records topic-specific session files when MessageThreadId is present", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-topic-session-"));
    const storePath = path.join(root, "sessions.json");

    const cfg = {
      session: { store: storePath },
    } as ClawdbotConfig;

    const result = await initSessionState({
      ctx: {
        Body: "Hello topic",
        SessionKey: "agent:main:telegram:group:123:topic:456",
        MessageThreadId: 456,
      },
      cfg,
      commandAuthorized: true,
    });

    const sessionFile = result.sessionEntry.sessionFile;
    expect(sessionFile).toBeTruthy();
    expect(path.basename(sessionFile ?? "")).toBe(
      `${result.sessionEntry.sessionId}-topic-456.jsonl`,
    );
  });
});

describe("initSessionState RawBody", () => {
  it("triggerBodyNormalized correctly extracts commands when Body contains context but RawBody is clean", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-rawbody-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as ClawdbotConfig;

    const groupMessageCtx = {
      Body: `[Chat messages since your last reply - for context]\n[WhatsApp ...] Someone: hello\n\n[Current message - respond to this]\n[WhatsApp ...] Jake: /status\n[from: Jake McInteer (+6421807830)]`,
      RawBody: "/status",
      ChatType: "group",
      SessionKey: "agent:main:whatsapp:group:G1",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.triggerBodyNormalized).toBe("/status");
  });

  it("Reset triggers (/new, /reset) work with RawBody", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-rawbody-reset-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as ClawdbotConfig;

    const groupMessageCtx = {
      Body: `[Context]\nJake: /new\n[from: Jake]`,
      RawBody: "/new",
      ChatType: "group",
      SessionKey: "agent:main:whatsapp:group:G1",
    };

    const result = await initSessionState({
      ctx: groupMessageCtx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.bodyStripped).toBe("");
  });

  it("preserves argument casing while still matching reset triggers case-insensitively", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-rawbody-reset-case-"));
    const storePath = path.join(root, "sessions.json");

    const cfg = {
      session: {
        store: storePath,
        resetTriggers: ["/new"],
      },
    } as ClawdbotConfig;

    const ctx = {
      RawBody: "/NEW KeepThisCase",
      ChatType: "direct",
      SessionKey: "agent:main:whatsapp:dm:S1",
    };

    const result = await initSessionState({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.isNewSession).toBe(true);
    expect(result.bodyStripped).toBe("KeepThisCase");
    expect(result.triggerBodyNormalized).toBe("/NEW KeepThisCase");
  });

  it("falls back to Body when RawBody is undefined", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-rawbody-fallback-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as ClawdbotConfig;

    const ctx = {
      Body: "/status",
      SessionKey: "agent:main:whatsapp:dm:S1",
    };

    const result = await initSessionState({
      ctx,
      cfg,
      commandAuthorized: true,
    });

    expect(result.triggerBodyNormalized).toBe("/status");
  });
});

describe("initSessionState reset policy", () => {
  it("defaults to daily reset at 4am local time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-reset-daily-"));
      const storePath = path.join(root, "sessions.json");
      const sessionKey = "agent:main:whatsapp:dm:S1";
      const existingSessionId = "daily-session-id";

      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        },
      });

      const cfg = { session: { store: storePath } } as ClawdbotConfig;
      const result = await initSessionState({
        ctx: { Body: "hello", SessionKey: sessionKey },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionId).not.toBe(existingSessionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats sessions as stale before the daily reset when updated before yesterday's boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 18, 3, 0, 0));
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-reset-daily-edge-"));
      const storePath = path.join(root, "sessions.json");
      const sessionKey = "agent:main:whatsapp:dm:S-edge";
      const existingSessionId = "daily-edge-session";

      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: new Date(2026, 0, 17, 3, 30, 0).getTime(),
        },
      });

      const cfg = { session: { store: storePath } } as ClawdbotConfig;
      const result = await initSessionState({
        ctx: { Body: "hello", SessionKey: sessionKey },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionId).not.toBe(existingSessionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires sessions when idle timeout wins over daily reset", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 18, 5, 30, 0));
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-reset-idle-"));
      const storePath = path.join(root, "sessions.json");
      const sessionKey = "agent:main:whatsapp:dm:S2";
      const existingSessionId = "idle-session-id";

      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: new Date(2026, 0, 18, 4, 45, 0).getTime(),
        },
      });

      const cfg = {
        session: {
          store: storePath,
          reset: { mode: "daily", atHour: 4, idleMinutes: 30 },
        },
      } as ClawdbotConfig;
      const result = await initSessionState({
        ctx: { Body: "hello", SessionKey: sessionKey },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionId).not.toBe(existingSessionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses per-type overrides for thread sessions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-reset-thread-"));
      const storePath = path.join(root, "sessions.json");
      const sessionKey = "agent:main:slack:channel:C1:thread:123";
      const existingSessionId = "thread-session-id";

      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        },
      });

      const cfg = {
        session: {
          store: storePath,
          reset: { mode: "daily", atHour: 4 },
          resetByType: { thread: { mode: "idle", idleMinutes: 180 } },
        },
      } as ClawdbotConfig;
      const result = await initSessionState({
        ctx: { Body: "reply", SessionKey: sessionKey, ThreadLabel: "Slack thread" },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession).toBe(false);
      expect(result.sessionId).toBe(existingSessionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("detects thread sessions without thread key suffix", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-reset-thread-nosuffix-"));
      const storePath = path.join(root, "sessions.json");
      const sessionKey = "agent:main:discord:channel:C1";
      const existingSessionId = "thread-nosuffix";

      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        },
      });

      const cfg = {
        session: {
          store: storePath,
          resetByType: { thread: { mode: "idle", idleMinutes: 180 } },
        },
      } as ClawdbotConfig;
      const result = await initSessionState({
        ctx: { Body: "reply", SessionKey: sessionKey, ThreadLabel: "Discord thread" },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession).toBe(false);
      expect(result.sessionId).toBe(existingSessionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defaults to daily resets when only resetByType is configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-reset-type-default-"));
      const storePath = path.join(root, "sessions.json");
      const sessionKey = "agent:main:whatsapp:dm:S4";
      const existingSessionId = "type-default-session";

      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: new Date(2026, 0, 18, 3, 0, 0).getTime(),
        },
      });

      const cfg = {
        session: {
          store: storePath,
          resetByType: { thread: { mode: "idle", idleMinutes: 60 } },
        },
      } as ClawdbotConfig;
      const result = await initSessionState({
        ctx: { Body: "hello", SessionKey: sessionKey },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession).toBe(true);
      expect(result.sessionId).not.toBe(existingSessionId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps legacy idleMinutes behavior without reset config", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    try {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-reset-legacy-"));
      const storePath = path.join(root, "sessions.json");
      const sessionKey = "agent:main:whatsapp:dm:S3";
      const existingSessionId = "legacy-session-id";

      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: new Date(2026, 0, 18, 3, 30, 0).getTime(),
        },
      });

      const cfg = {
        session: {
          store: storePath,
          idleMinutes: 240,
        },
      } as ClawdbotConfig;
      const result = await initSessionState({
        ctx: { Body: "hello", SessionKey: sessionKey },
        cfg,
        commandAuthorized: true,
      });

      expect(result.isNewSession).toBe(false);
      expect(result.sessionId).toBe(existingSessionId);
    } finally {
      vi.useRealTimers();
    }
  });
});
