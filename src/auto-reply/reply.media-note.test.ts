import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { getReplyFromConfig } from "./reply.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) =>
    `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

function makeResult(text: string) {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  };
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-media-note-"));
  const previousHome = process.env.HOME;
  process.env.HOME = base;
  try {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    return await fn(base);
  } finally {
    process.env.HOME = previousHome;
    try {
      await fs.rm(base, { recursive: true, force: true });
    } catch {
      // ignore cleanup failures in tests
    }
  }
}

function makeCfg(home: string) {
  return {
    agent: {
      model: "anthropic/claude-opus-4-5",
      workspace: path.join(home, "clawd"),
    },
    whatsapp: { allowFrom: ["*"] },
    session: { store: path.join(home, "sessions.json") },
  };
}

describe("getReplyFromConfig media note plumbing", () => {
  it("includes all MediaPaths in the agent prompt", async () => {
    await withTempHome(async (home) => {
      let seenPrompt: string | undefined;
      vi.mocked(runEmbeddedPiAgent).mockImplementation(async (params) => {
        seenPrompt = params.prompt;
        return makeResult("ok");
      });

      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1001",
          To: "+2000",
          MediaPaths: ["/tmp/a.png", "/tmp/b.png"],
          MediaUrls: ["/tmp/a.png", "/tmp/b.png"],
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(seenPrompt).toBeTruthy();
      expect(seenPrompt).toContain("[media attached: 2 files]");
      const idxA = seenPrompt?.indexOf("[media attached 1/2: /tmp/a.png");
      const idxB = seenPrompt?.indexOf("[media attached 2/2: /tmp/b.png");
      expect(typeof idxA).toBe("number");
      expect(typeof idxB).toBe("number");
      expect((idxA ?? -1) >= 0).toBe(true);
      expect((idxB ?? -1) >= 0).toBe(true);
      expect((idxA ?? 0) < (idxB ?? 0)).toBe(true);
    });
  });
});
