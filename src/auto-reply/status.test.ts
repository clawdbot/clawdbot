import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildStatusMessage } from "./status.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildStatusMessage", () => {
  it("summarizes agent readiness and context usage", () => {
    const text = buildStatusMessage({
      agent: {
        model: "anthropic/pi:opus",
        contextTokens: 32_000,
      },
      sessionEntry: {
        sessionId: "abc",
        updatedAt: 0,
        totalTokens: 16_000,
        contextTokens: 32_000,
        thinkingLevel: "low",
        verboseLevel: "on",
        compactionCount: 2,
      },
      sessionKey: "main",
      sessionScope: "per-sender",
      storePath: "/tmp/sessions.json",
      resolvedThink: "medium",
      resolvedVerbose: "off",
      now: 10 * 60_000, // 10 minutes later
      webLinked: true,
      webAuthAgeMs: 5 * 60_000,
      heartbeatSeconds: 45,
    });

    expect(text).toContain("⚙️ Status");
    expect(text).toContain("Agent: embedded pi");
    expect(text).toContain("Runtime: direct");
    expect(text).toContain("Context: 16k/32k (50%)");
    expect(text).toContain("Session: main");
    expect(text).toContain("compactions 2");
    expect(text).toContain("Web: linked");
    expect(text).toContain("heartbeat 45s");
    expect(text).toContain("thinking=medium");
    expect(text).toContain("verbose=off");
    expect(text).not.toContain("Shortcuts:");
    expect(text).not.toContain("set with");
  });

  it("handles missing agent config gracefully", () => {
    const text = buildStatusMessage({
      agent: {},
      sessionScope: "per-sender",
      webLinked: false,
    });

    expect(text).toContain("Agent: embedded pi");
    expect(text).toContain("Context:");
    expect(text).toContain("Web: not linked");
  });

  it("includes group activation for group sessions", () => {
    const text = buildStatusMessage({
      agent: {},
      sessionEntry: {
        sessionId: "g1",
        updatedAt: 0,
        groupActivation: "always",
        chatType: "group",
      },
      sessionKey: "whatsapp:group:123@g.us",
      sessionScope: "per-sender",
      webLinked: true,
    });

    expect(text).toContain("Group activation: always");
  });

  it("prefers cached prompt tokens from the session log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-status-"));
    const previousHome = process.env.HOME;
    process.env.HOME = dir;
    try {
      vi.resetModules();
      const { buildStatusMessage: buildStatusMessageDynamic } = await import(
        "./status.js"
      );

      const storePath = path.join(
        dir,
        ".clawdbot",
        "sessions",
        "sessions.json",
      );
      const sessionId = "sess-1";
      const logPath = path.join(
        dir,
        ".clawdbot",
        "sessions",
        `${sessionId}.jsonl`,
      );
      fs.mkdirSync(path.dirname(logPath), { recursive: true });

      fs.writeFileSync(
        logPath,
        [
          JSON.stringify({
            type: "message",
            message: {
              role: "assistant",
              model: "claude-opus-4-5",
              usage: {
                input: 1,
                output: 2,
                cacheRead: 1000,
                cacheWrite: 0,
                totalTokens: 1003,
              },
            },
          }),
        ].join("\n"),
        "utf-8",
      );

      const text = buildStatusMessageDynamic({
        agent: {
          model: "anthropic/claude-opus-4-5",
          contextTokens: 32_000,
        },
        sessionEntry: {
          sessionId,
          updatedAt: 0,
          totalTokens: 3, // would be wrong if cached prompt tokens exist
          contextTokens: 32_000,
        },
        sessionKey: "main",
        sessionScope: "per-sender",
        storePath,
        webLinked: true,
      });

      expect(text).toContain("Context: 1.0k/32k");
    } finally {
      process.env.HOME = previousHome;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
