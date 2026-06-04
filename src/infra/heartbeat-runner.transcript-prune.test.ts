// Covers heartbeat transcript pruning behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempTelegramHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
});

describe("heartbeat transcript append-only (#39609)", () => {
  async function createTranscriptWithContent(transcriptPath: string, sessionId: string) {
    const header = {
      type: "session",
      version: 3,
      id: sessionId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    };
    const existingContent = `${JSON.stringify(header)}\n{"role":"user","content":"Hello"}\n{"role":"assistant","content":"Hi there"}\n`;
    await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
    await fs.writeFile(transcriptPath, existingContent);
    return existingContent;
  }

  async function runTranscriptScenario(params: {
    sessionId: string;
    reply: {
      text: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
      };
    };
  }) {
    await withTempTelegramHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        const sessionKey = resolveMainSessionKey(undefined);
        const transcriptPath = path.join(tmpDir, `${params.sessionId}.jsonl`);
        await createTranscriptWithContent(transcriptPath, params.sessionId);
        const originalSize = (await fs.stat(transcriptPath)).size;

        await seedSessionStore(storePath, sessionKey, {
          sessionId: params.sessionId,
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "user123",
        });

        replySpy.mockResolvedValueOnce(params.reply);

        const cfg = {
          version: 1,
          model: "test-model",
          agent: { workspace: tmpDir },
          sessionStore: storePath,
          channels: { telegram: {} },
        } as unknown as OpenClawConfig;

        await runHeartbeatOnce({
          agentId: undefined,
          reason: "test",
          cfg,
          deps: {
            sendTelegram: vi.fn(),
            getReplyFromConfig: replySpy,
          },
        });

        const finalSize = (await fs.stat(transcriptPath)).size;
        // Transcript must never be truncated — entries are append-only now.
        // HEARTBEAT_OK entries stay in the file and are filtered at context
        // build time instead of being removed via fs.truncate (#39609).
        expect(finalSize).toBeGreaterThanOrEqual(originalSize);
      },
      { prefix: "openclaw-hb-prune-" },
    );
  }

  it("does not truncate transcript when heartbeat returns HEARTBEAT_OK", async () => {
    await runTranscriptScenario({
      sessionId: "test-session-no-prune",
      reply: {
        text: "HEARTBEAT_OK",
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    });
  });

  it("does not truncate transcript when heartbeat returns meaningful content", async () => {
    await runTranscriptScenario({
      sessionId: "test-session-content",
      reply: {
        text: "Alert: Something needs your attention!",
        usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    });
  });
});
