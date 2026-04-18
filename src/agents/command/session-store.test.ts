import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore } from "../../config/sessions.js";
import type { EmbeddedPiRunResult } from "../pi-embedded.js";
import { updateSessionStoreAfterAgentRun } from "./session-store.js";
import { resolveSession } from "./session.js";

function acpMeta() {
  return {
    backend: "acpx",
    agent: "codex",
    runtimeSessionName: "runtime-1",
    mode: "persistent" as const,
    state: "idle" as const,
    lastActivityAt: Date.now(),
  };
}

async function withTempSessionStore<T>(
  run: (params: { dir: string; storePath: string }) => Promise<T>,
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-store-"));
  try {
    return await run({ dir, storePath: path.join(dir, "sessions.json") });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("updateSessionStoreAfterAgentRun", () => {
  it("persists claude-cli session bindings when the backend is configured", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": {
                command: "claude",
              },
            },
          },
        },
      } as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-claude-cli";
      const sessionId = "test-openclaw-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "cli-session-123",
            provider: "claude-cli",
            model: "claude-sonnet-4-6",
            cliSessionBinding: {
              sessionId: "cli-session-123",
            },
          },
        },
      };

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "claude-cli",
        defaultModel: "claude-sonnet-4-6",
        result,
      });

      expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "cli-session-123",
      });
      expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe("cli-session-123");
      expect(sessionStore[sessionKey]?.claudeCliSessionId).toBe("cli-session-123");

      const persisted = loadSessionStore(storePath);
      expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "cli-session-123",
      });
      expect(persisted[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe("cli-session-123");
      expect(persisted[sessionKey]?.claudeCliSessionId).toBe("cli-session-123");
    });
  });

  it("preserves ACP metadata when caller has a stale session snapshot", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = `agent:codex:acp:${randomUUID()}`;
      const sessionId = randomUUID();

      const existing: SessionEntry = {
        sessionId,
        updatedAt: Date.now(),
        acp: acpMeta(),
      };
      await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: existing }, null, 2), "utf8");

      const staleInMemory: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now(),
        },
      };

      await updateSessionStoreAfterAgentRun({
        cfg: {} as never,
        sessionId,
        sessionKey,
        storePath,
        sessionStore: staleInMemory,
        contextTokensOverride: 200_000,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        result: {
          payloads: [],
          meta: {
            aborted: false,
            agentMeta: {
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        } as never,
      });

      const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(persisted?.acp).toBeDefined();
      expect(staleInMemory[sessionKey]?.acp).toBeDefined();
    });
  });

  it("persists latest systemPromptReport for downstream warning dedupe", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = `agent:codex:report:${randomUUID()}`;
      const sessionId = randomUUID();

      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now(),
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf8");

      const report = {
        source: "run" as const,
        generatedAt: Date.now(),
        bootstrapTruncation: {
          warningMode: "once" as const,
          warningSignaturesSeen: ["sig-a", "sig-b"],
        },
        systemPrompt: {
          chars: 1,
          projectContextChars: 1,
          nonProjectContextChars: 0,
        },
        injectedWorkspaceFiles: [],
        skills: { promptChars: 0, entries: [] },
        tools: { listChars: 0, schemaChars: 0, entries: [] },
      };

      await updateSessionStoreAfterAgentRun({
        cfg: {} as never,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        contextTokensOverride: 200_000,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        result: {
          payloads: [],
          meta: {
            agentMeta: {
              provider: "openai",
              model: "gpt-5.4",
            },
            systemPromptReport: report,
          },
        } as never,
      });

      const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(persisted?.systemPromptReport?.bootstrapTruncation?.warningSignaturesSeen).toEqual([
        "sig-a",
        "sig-b",
      ]);
      expect(sessionStore[sessionKey]?.systemPromptReport?.bootstrapTruncation?.warningMode).toBe(
        "once",
      );
    });
  });

  it("stores and reloads the runtime model for explicit session-id-only runs", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {
        session: {
          store: storePath,
          mainKey: "main",
        },
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": {},
            },
          },
        },
      } as never;

      const first = resolveSession({
        cfg,
        sessionId: "explicit-session-123",
      });

      expect(first.sessionKey).toBe("agent:main:explicit:explicit-session-123");

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId: first.sessionId,
        sessionKey: first.sessionKey!,
        storePath: first.storePath,
        sessionStore: first.sessionStore!,
        contextTokensOverride: 200_000,
        defaultProvider: "claude-cli",
        defaultModel: "claude-sonnet-4-6",
        result: {
          payloads: [],
          meta: {
            agentMeta: {
              provider: "claude-cli",
              model: "claude-sonnet-4-6",
              sessionId: "claude-cli-session-1",
              cliSessionBinding: {
                sessionId: "claude-cli-session-1",
                authEpoch: "auth-epoch-1",
              },
            },
          },
        } as never,
      });

      const second = resolveSession({
        cfg,
        sessionId: "explicit-session-123",
      });

      expect(second.sessionKey).toBe(first.sessionKey);
      expect(second.sessionEntry?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "claude-cli-session-1",
        authEpoch: "auth-epoch-1",
      });

      const persisted = loadSessionStore(storePath, { skipCache: true })[first.sessionKey!];
      expect(persisted?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "claude-cli-session-1",
        authEpoch: "auth-epoch-1",
      });
    });
  });
});
