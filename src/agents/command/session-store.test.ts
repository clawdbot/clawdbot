import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore } from "../../config/sessions.js";
import type { EmbeddedPiRunResult } from "../pi-embedded.js";
import { updateSessionStoreAfterAgentRun } from "./session-store.js";
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
});
