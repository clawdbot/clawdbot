import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildStatusMessage } from "./status.js";

const HOME_ENV_KEYS = ["HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH"] as const;
type HomeEnvSnapshot = Record<
  (typeof HOME_ENV_KEYS)[number],
  string | undefined
>;

const snapshotHomeEnv = (): HomeEnvSnapshot => ({
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  HOMEDRIVE: process.env.HOMEDRIVE,
  HOMEPATH: process.env.HOMEPATH,
});

const restoreHomeEnv = (snapshot: HomeEnvSnapshot) => {
  for (const key of HOME_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
};

const setTempHome = (tempHome: string) => {
  process.env.HOME = tempHome;
  if (process.platform === "win32") {
    process.env.USERPROFILE = tempHome;
    const root = path.parse(tempHome).root;
    process.env.HOMEDRIVE = root.replace(/\\$/, "");
    process.env.HOMEPATH = tempHome.slice(root.length - 1);
  }
};

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
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      resolvedThink: "medium",
      resolvedVerbose: "off",
      queue: { mode: "collect", depth: 0 },
      now: 10 * 60_000, // 10 minutes later
    });

    expect(text).toContain("🦞 ClawdBot");
    expect(text).toContain("🧠 Model:");
    expect(text).toContain("Runtime: direct");
    expect(text).toContain("Context: 16k/32k (50%)");
    expect(text).toContain("🧹 Compactions: 2");
    expect(text).toContain("Session: agent:main:main");
    expect(text).toContain("updated 10m ago");
    expect(text).toContain("Think: medium");
    expect(text).toContain("Verbose: off");
    expect(text).toContain("Elevated: on");
    expect(text).toContain("Queue: collect");
  });

  it("prefers model overrides over last-run model", () => {
    const text = buildStatusMessage({
      agent: {
        model: "anthropic/claude-opus-4-5",
        contextTokens: 32_000,
      },
      sessionEntry: {
        sessionId: "override-1",
        updatedAt: 0,
        providerOverride: "openai",
        modelOverride: "gpt-4.1-mini",
        modelProvider: "anthropic",
        model: "claude-haiku-4-5",
        contextTokens: 32_000,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
    });

    expect(text).toContain("🧠 Model: openai/gpt-4.1-mini");
  });

  it("handles missing agent config gracefully", () => {
    const text = buildStatusMessage({
      agent: {},
      sessionScope: "per-sender",
      webLinked: false,
    });

    expect(text).toContain("🧠 Model:");
    expect(text).toContain("Context:");
    expect(text).toContain("Queue:");
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
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
    });

    expect(text).toContain("Activation: always");
  });

  it("shows queue details when overridden", () => {
    const text = buildStatusMessage({
      agent: {},
      sessionEntry: { sessionId: "q1", updatedAt: 0 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: {
        mode: "collect",
        depth: 3,
        debounceMs: 2000,
        cap: 5,
        dropPolicy: "old",
        showDetails: true,
      },
    });

    expect(text).toContain(
      "Queue: collect (depth 3 · debounce 2s · cap 5 · drop old)",
    );
  });

  it("inserts usage summary beneath context line", () => {
    const text = buildStatusMessage({
      agent: { model: "anthropic/claude-opus-4-5", contextTokens: 32_000 },
      sessionEntry: { sessionId: "u1", updatedAt: 0, totalTokens: 1000 },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      usageLine: "📊 Usage: Claude 80% left (5h)",
    });

    const lines = text.split("\n");
    const contextIndex = lines.findIndex((line) => line.startsWith("📚 "));
    expect(contextIndex).toBeGreaterThan(-1);
    expect(lines[contextIndex + 1]).toBe("📊 Usage: Claude 80% left (5h)");
  });

  it("prefers cached prompt tokens from the session log", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-status-"));
    const previousHome = snapshotHomeEnv();
    setTempHome(dir);
    try {
      vi.resetModules();
      const { buildStatusMessage: buildStatusMessageDynamic } = await import(
        "./status.js"
      );

      const sessionId = "sess-1";
      const logPath = path.join(
        dir,
        ".clawdbot",
        "agents",
        "main",
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
        sessionKey: "agent:main:main",
        sessionScope: "per-sender",
        queue: { mode: "collect", depth: 0 },
        includeTranscriptUsage: true,
      });

      expect(text).toContain("Context: 1.0k/32k");
    } finally {
      restoreHomeEnv(previousHome);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
