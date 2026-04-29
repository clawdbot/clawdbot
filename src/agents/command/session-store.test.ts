import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore } from "../../config/sessions.js";
import type { EmbeddedPiRunResult } from "../pi-embedded.js";
import { clearCliSessionInStore, updateSessionStoreAfterAgentRun } from "./session-store.js";
import { resolveSession } from "./session.js";

vi.mock("../model-selection.js", () => ({
  isCliProvider: (provider: string, cfg?: OpenClawConfig) =>
    Object.hasOwn(cfg?.agents?.defaults?.cliBackends ?? {}, provider),
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

type MockCost = {
  input?: number;
  output?: number;
};

type MockProviderModel = {
  id: string;
  cost?: MockCost;
};

type MockUsageFormatConfig = {
  models?: {
    providers?: Record<string, { models?: MockProviderModel[] }>;
  };
};

vi.mock("../../utils/usage-format.js", () => ({
  estimateUsageCost: (params: { usage?: { input?: number; output?: number }; cost?: MockCost }) => {
    if (!params.usage || !params.cost) {
      return undefined;
    }
    const input = params.usage.input ?? 0;
    const output = params.usage.output ?? 0;
    const costInput = params.cost.input ?? 0;
    const costOutput = params.cost.output ?? 0;
    const total = input * costInput + output * costOutput;
    if (!Number.isFinite(total)) {
      return undefined;
    }
    return total / 1e6;
  },
  resolveModelCostConfig: (params: { provider?: string; model?: string; config?: unknown }) => {
    const providers = (params.config as MockUsageFormatConfig | undefined)?.models?.providers;
    if (!providers) {
      return undefined;
    }
    const model = providers[params.provider ?? ""]?.models?.find(
      (entry) => entry.id === params.model,
    );
    if (!model) {
      return undefined;
    }
    return model.cost;
  },
}));

vi.mock("../../config/sessions.js", async () => {
  const fsSync = await import("node:fs");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const readStore = async (storePath: string): Promise<Record<string, SessionEntry>> => {
    try {
      return JSON.parse(await fs.readFile(storePath, "utf8")) as Record<string, SessionEntry>;
    } catch {
      return {};
    }
  };
  const writeStore = async (storePath: string, store: Record<string, SessionEntry>) => {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
  };
  return {
    mergeSessionEntry: (existing: SessionEntry | undefined, patch: Partial<SessionEntry>) => ({
      ...existing,
      ...patch,
      sessionId: patch.sessionId ?? existing?.sessionId ?? "mock-session",
      updatedAt: Math.max(existing?.updatedAt ?? 0, patch.updatedAt ?? 0, Date.now()),
    }),
    setSessionRuntimeModel: (entry: SessionEntry, runtime: { provider: string; model: string }) => {
      entry.modelProvider = runtime.provider;
      entry.model = runtime.model;
      return true;
    },
    updateSessionStore: async <T>(
      storePath: string,
      mutator: (store: Record<string, SessionEntry>) => Promise<T> | T,
    ) => {
      const store = await readStore(storePath);
      const previousAcpByKey = new Map(
        Object.entries(store)
          .filter(
            (entry): entry is [string, SessionEntry & { acp: NonNullable<SessionEntry["acp"]> }] =>
              Boolean(entry[1]?.acp),
          )
          .map(([key, entry]) => [key, entry.acp]),
      );
      const result = await mutator(store);
      for (const [key, acp] of previousAcpByKey) {
        const next = store[key];
        if (next && !next.acp) {
          next.acp = acp;
        }
      }
      await writeStore(storePath, store);
      return result;
    },
    loadSessionStore: (storePath: string) => {
      try {
        return JSON.parse(fsSync.readFileSync(storePath, "utf8")) as Record<string, SessionEntry>;
      } catch {
        return {};
      }
    },
  };
});

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
  it("persists the selected embedded harness id on the session", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-harness-pin";
      const sessionId = "test-harness-pin-session";
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
            sessionId,
            provider: "openai",
            model: "gpt-5.4",
            agentHarnessId: "codex",
          },
        },
      };

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        result,
      });

      expect(sessionStore[sessionKey]?.agentHarnessId).toBe("codex");
      expect(loadSessionStore(storePath)[sessionKey]?.agentHarnessId).toBe("codex");
    });
  });

  it("uses the runtime context budget from agent metadata instead of cold fallback", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-runtime-context";
      const sessionId = "test-runtime-context-session";
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
            sessionId,
            provider: "openai-codex",
            model: "gpt-5.5",
            contextTokens: 400_000,
          },
        },
      };

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai-codex",
        defaultModel: "gpt-5.5",
        result,
      });

      expect(sessionStore[sessionKey]?.contextTokens).toBe(400_000);
      expect(loadSessionStore(storePath)[sessionKey]?.contextTokens).toBe(400_000);
    });
  });

  it("clears the embedded harness pin after a CLI run", async () => {
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
      const sessionKey = "agent:main:explicit:test-harness-pin-cli";
      const sessionId = "test-harness-pin-cli-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          agentHarnessId: "codex",
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 1,
          executionTrace: { runner: "cli" },
          agentMeta: {
            sessionId: "cli-session-123",
            provider: "claude-cli",
            model: "claude-sonnet-4-6",
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

      expect(sessionStore[sessionKey]?.agentHarnessId).toBeUndefined();
      expect(loadSessionStore(storePath)[sessionKey]?.agentHarnessId).toBeUndefined();
    });
  });

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
        contextTokensOverride: 200_000,
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
      const sessionKey = "agent:codex:acp:test-acp-preserve";
      const sessionId = "test-acp-session";

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
      const sessionKey = "agent:codex:report:test-system-prompt-report";
      const sessionId = "test-system-prompt-report-session";

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
              "claude-cli": { command: "claude" },
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

  it("preserves previous totalTokens when provider returns no usage data (#67667)", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-no-usage";
      const sessionId = "test-session";

      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          totalTokens: 21225,
          totalTokensFresh: true,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "minimax",
            model: "MiniMax-M2.7",
          },
        },
      };

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "minimax",
        defaultModel: "MiniMax-M2.7",
        result,
      });

      expect(sessionStore[sessionKey]?.totalTokens).toBe(21225);
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(false);

      const persisted = loadSessionStore(storePath);
      expect(persisted[sessionKey]?.totalTokens).toBe(21225);
      expect(persisted[sessionKey]?.totalTokensFresh).toBe(false);
    });
  });

  it("does not treat CLI cumulative usage as a fresh context snapshot", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {
        agents: {
          defaults: {
            cliBackends: {
              "claude-cli": { command: "claude" },
            },
          },
        },
      } as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-cli-cumulative-usage";
      const sessionId = "test-cli-cumulative-usage-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          totalTokens: 95_000,
          totalTokensFresh: true,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      await updateSessionStoreAfterAgentRun({
        cfg,
        contextTokensOverride: 1_000_000,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "claude-cli",
        defaultModel: "claude-opus-4-7",
        result: {
          meta: {
            durationMs: 1,
            executionTrace: { runner: "cli" },
            agentMeta: {
              sessionId,
              provider: "claude-cli",
              model: "claude-opus-4-7",
              usage: {
                input: 3_800_000,
                output: 20_000,
                total: 3_820_000,
              },
            },
          },
        },
      });

      expect(sessionStore[sessionKey]?.inputTokens).toBe(3_800_000);
      expect(sessionStore[sessionKey]?.outputTokens).toBe(20_000);
      expect(sessionStore[sessionKey]?.totalTokens).toBeUndefined();
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(false);
    });
  });

  it("persists compaction tokensAfter when provider usage is unavailable", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-compaction-tokens-after";
      const sessionId = "test-compaction-tokens-after-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "minimax",
            model: "MiniMax-M2.7",
            compactionCount: 1,
            compactionTokensAfter: 21_225,
          },
        },
      };

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "minimax",
        defaultModel: "MiniMax-M2.7",
        result,
      });

      expect(sessionStore[sessionKey]?.totalTokens).toBe(21_225);
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(true);
      expect(sessionStore[sessionKey]?.compactionCount).toBe(1);

      const persisted = loadSessionStore(storePath);
      expect(persisted[sessionKey]?.totalTokens).toBe(21_225);
      expect(persisted[sessionKey]?.totalTokensFresh).toBe(true);
    });
  });

  it("ignores non-finite compaction tokensAfter values", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-compaction-tokens-after-invalid";
      const sessionId = "test-compaction-tokens-after-invalid-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          totalTokens: 12_000,
          totalTokensFresh: true,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "minimax",
        defaultModel: "MiniMax-M2.7",
        result: {
          meta: {
            durationMs: 500,
            agentMeta: {
              sessionId,
              provider: "minimax",
              model: "MiniMax-M2.7",
              compactionCount: 1,
              compactionTokensAfter: Number.POSITIVE_INFINITY,
            },
          },
        },
      });

      expect(sessionStore[sessionKey]?.totalTokens).toBe(12_000);
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(false);
    });
  });

  it("snapshots cost instead of accumulating (fixes #69347)", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "gpt-4",
                  cost: {
                    input: 10,
                    output: 30,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                },
              ],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-cost-snapshot";
      const sessionId = "test-cost-snapshot-session";

      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      // Simulate a run with 10k input + 5k output tokens
      // Cost = (10000 * 10 + 5000 * 30) / 1e6 = $0.25
      const result: EmbeddedPiRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "openai",
            model: "gpt-4",
            usage: {
              input: 10000,
              output: 5000,
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
        defaultProvider: "openai",
        defaultModel: "gpt-4",
        result,
      });

      // First run: cost should be $0.25
      expect(sessionStore[sessionKey]?.estimatedCostUsd).toBeCloseTo(0.25, 4);

      // Simulate a second persist with the SAME cumulative usage (e.g., from a heartbeat or
      // redundant persist). Before the fix, this would double the cost.
      // After the fix, cost should remain the same because it's snapshotted.
      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-4",
        result, // Same usage again
      });

      // After second persist with same usage, cost should STILL be $0.25 (not $0.50)
      expect(sessionStore[sessionKey]?.estimatedCostUsd).toBeCloseTo(0.25, 4);

      const persisted = loadSessionStore(storePath);
      expect(persisted[sessionKey]?.estimatedCostUsd).toBeCloseTo(0.25, 4);
    });
  });

  it("preserves lastInteractionAt for non-interactive system runs", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-system-run";
      const sessionId = "test-system-run-session";
      const lastInteractionAt = Date.now() - 60 * 60_000;
      const sessionStartedAt = Date.now() - 2 * 60 * 60_000;
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now() - 10_000,
          sessionStartedAt,
          lastInteractionAt,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        result: {
          meta: {
            durationMs: 1,
            agentMeta: {
              sessionId,
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        },
        touchInteraction: false,
      });

      expect(sessionStore[sessionKey]?.lastInteractionAt).toBe(lastInteractionAt);
      expect(sessionStore[sessionKey]?.sessionStartedAt).toBe(sessionStartedAt);
      expect(sessionStore[sessionKey]?.updatedAt).toBeGreaterThan(lastInteractionAt);
    });
  });

  it("advances lastInteractionAt for interactive runs", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-user-run";
      const sessionId = "test-user-run-session";
      const lastInteractionAt = Date.now() - 60 * 60_000;
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now() - 10_000,
          lastInteractionAt,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        result: {
          meta: {
            durationMs: 1,
            agentMeta: {
              sessionId,
              provider: "openai",
              model: "gpt-5.4",
            },
          },
        },
      });

      expect(sessionStore[sessionKey]?.lastInteractionAt).toBeGreaterThan(lastInteractionAt);
    });
  });
});

describe("clearCliSessionInStore", () => {
  it("persists cleared Claude CLI bindings through session-store merge", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:test-clear-claude-cli";
      const entry: SessionEntry = {
        sessionId: "openclaw-session-1",
        updatedAt: 1,
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "claude-session-1",
            authEpoch: "epoch-1",
          },
          "codex-cli": {
            sessionId: "codex-session-1",
          },
        },
        cliSessionIds: {
          "claude-cli": "claude-session-1",
          "codex-cli": "codex-session-1",
        },
        claudeCliSessionId: "claude-session-1",
      };
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf8");

      const cleared = await clearCliSessionInStore({
        provider: "claude-cli",
        sessionKey,
        sessionStore,
        storePath,
      });

      expect(cleared?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
      expect(cleared?.cliSessionBindings?.["codex-cli"]).toEqual({
        sessionId: "codex-session-1",
      });
      expect(cleared?.cliSessionIds?.["claude-cli"]).toBeUndefined();
      expect(cleared?.cliSessionIds?.["codex-cli"]).toBe("codex-session-1");
      expect(cleared?.claudeCliSessionId).toBeUndefined();
      expect(sessionStore[sessionKey]).toEqual(cleared);

      const persisted = loadSessionStore(storePath, { skipCache: true })[sessionKey];
      expect(persisted?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
      expect(persisted?.cliSessionBindings?.["codex-cli"]).toEqual({
        sessionId: "codex-session-1",
      });
      expect(persisted?.cliSessionIds?.["claude-cli"]).toBeUndefined();
      expect(persisted?.cliSessionIds?.["codex-cli"]).toBe("codex-session-1");
      expect(persisted?.claudeCliSessionId).toBeUndefined();
    });
  });

  it("leaves the caller snapshot intact when the session entry is missing", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const existingKey = "agent:main:explicit:existing";
      const sessionStore: Record<string, SessionEntry> = {
        [existingKey]: {
          sessionId: "openclaw-session-1",
          updatedAt: 1,
          claudeCliSessionId: "claude-session-1",
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2), "utf8");

      const cleared = await clearCliSessionInStore({
        provider: "claude-cli",
        sessionKey: "agent:main:explicit:missing",
        sessionStore,
        storePath,
      });

      expect(cleared).toBeUndefined();
      expect(sessionStore[existingKey]?.claudeCliSessionId).toBe("claude-session-1");
      expect(
        loadSessionStore(storePath, { skipCache: true })[existingKey]?.claudeCliSessionId,
      ).toBe("claude-session-1");
    });
  });
});
