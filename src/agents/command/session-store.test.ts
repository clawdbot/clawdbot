import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import { loadSessionStore } from "../../config/sessions.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import {
  clearCliSessionInStore,
  recordCliCompactionInStore,
  updateSessionStoreAfterAgentRun,
} from "./session-store.js";
import { resolveSession } from "./session.js";

const sessionStoreMocks = vi.hoisted(() => ({
  updateSessionStore: vi.fn(),
}));

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
  sessionStoreMocks.updateSessionStore.mockImplementation(
    async <T>(
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
  );
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
    updateSessionStore: sessionStoreMocks.updateSessionStore,
    loadSessionStore: (storePath: string) => {
      try {
        return JSON.parse(fsSync.readFileSync(storePath, "utf8")) as Record<string, SessionEntry>;
      } catch {
        return {};
      }
    },
    canonicalizeAbsoluteSessionFilePath: (filePath: string) => path.resolve(filePath),
    rewriteSessionFileForNewSessionId: (params: {
      sessionFile?: string;
      previousSessionId: string;
      nextSessionId: string;
    }) => params.sessionFile?.replace(params.previousSessionId, params.nextSessionId),
    resolveSessionFilePathOptions: (params: unknown) => params,
    resolveSessionFilePath: (sessionId: string, entry?: SessionEntry) =>
      entry?.sessionFile ?? path.join("/tmp", `${sessionId}.jsonl`),
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
  it("passes resolved maintenance config to the gateway turn store write", async () => {
    sessionStoreMocks.updateSessionStore.mockClear();
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {
        session: {
          maintenance: {
            mode: "enforce",
            maxEntries: 42,
          },
        },
      } as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-maintenance-config";
      const sessionId = "test-maintenance-config-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));
      const result: EmbeddedAgentRunResult = {
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId,
            provider: "openai",
            model: "gpt-5.5",
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
        defaultModel: "gpt-5.5",
        result,
      });

      const updateOptions = sessionStoreMocks.updateSessionStore.mock.calls.at(-1)?.[2];
      expect(updateOptions).toMatchObject({
        takeCacheOwnership: true,
        maintenanceConfig: {
          mode: "enforce",
          maxEntries: 42,
        },
      });
      expect(typeof updateOptions?.resolveSingleEntryPersistence).toBe("function");
      expect(
        updateOptions?.resolveSingleEntryPersistence?.({
          sessionId,
          updatedAt: 2,
        } as SessionEntry),
      ).toEqual({
        sessionKey,
        entry: {
          sessionId,
          updatedAt: 2,
        },
      });
    });
  });

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
      const result: EmbeddedAgentRunResult = {
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

  it("persists rotated compaction session identity and transcript file", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-rotated-session";
      const sessionId = "test-rotated-session-old";
      const rotatedSessionId = "test-rotated-session-new";
      const rotatedSessionFile = path.join(path.dirname(storePath), "rotated-session.jsonl");
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          sessionFile: path.join(path.dirname(storePath), "old-session.jsonl"),
          updatedAt: 1,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId: rotatedSessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        result: {
          meta: {
            durationMs: 1,
            agentMeta: {
              sessionId: rotatedSessionId,
              sessionFile: rotatedSessionFile,
              provider: "openai",
              model: "gpt-5.5",
              compactionCount: 1,
            },
          },
        },
      });

      expect(sessionStore[sessionKey]).toMatchObject({
        sessionId: rotatedSessionId,
        sessionFile: rotatedSessionFile,
        usageFamilyKey: sessionKey,
        usageFamilySessionIds: [sessionId, rotatedSessionId],
        compactionCount: 1,
      });
      expect(sessionStore[sessionKey]?.sessionStartedAt).toBeGreaterThan(1);
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

      const result: EmbeddedAgentRunResult = {
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId,
            provider: "openai",
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
        defaultProvider: "openai",
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

      const result: EmbeddedAgentRunResult = {
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

      const result: EmbeddedAgentRunResult = {
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
      expect(sessionStore[sessionKey]?.sessionId).toBe(sessionId);
      expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe("cli-session-123");
      expect(sessionStore[sessionKey]?.claudeCliSessionId).toBe("cli-session-123");

      const persisted = loadSessionStore(storePath);
      expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "cli-session-123",
      });
      expect(persisted[sessionKey]?.sessionId).toBe(sessionId);
      expect(persisted[sessionKey]?.cliSessionIds?.["claude-cli"]).toBe("cli-session-123");
      expect(persisted[sessionKey]?.claudeCliSessionId).toBe("cli-session-123");
    });
  });

  it("clears stale CLI bindings when a successful run reports an unflushed replacement", async () => {
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
      const sessionKey = "agent:main:explicit:test-clear-unflushed-cli";
      const sessionId = "test-openclaw-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          cliSessionBindings: {
            "claude-cli": {
              sessionId: "stale-cli-session",
              authEpoch: "old-epoch",
            },
            "codex-cli": {
              sessionId: "codex-session",
            },
          },
          cliSessionIds: {
            "claude-cli": "stale-cli-session",
            "codex-cli": "codex-session",
          },
          claudeCliSessionId: "stale-cli-session",
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      const result: EmbeddedAgentRunResult = {
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "",
            provider: "claude-cli",
            model: "claude-sonnet-4-6",
            clearCliSessionBinding: true,
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

      expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
      expect(sessionStore[sessionKey]?.cliSessionBindings?.["codex-cli"]).toEqual({
        sessionId: "codex-session",
      });
      expect(sessionStore[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
      expect(sessionStore[sessionKey]?.cliSessionIds?.["codex-cli"]).toBe("codex-session");
      expect(sessionStore[sessionKey]?.claudeCliSessionId).toBeUndefined();

      const persisted = loadSessionStore(storePath, { skipCache: true });
      expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
      expect(persisted[sessionKey]?.cliSessionIds?.["claude-cli"]).toBeUndefined();
      expect(persisted[sessionKey]?.claudeCliSessionId).toBeUndefined();
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
      expect(persisted?.acp?.backend).toBe("acpx");
      expect(persisted?.acp?.agent).toBe("codex");
      expect(persisted?.acp?.runtimeSessionName).toBe("runtime-1");
      expect(persisted?.acp?.mode).toBe("persistent");
      expect(persisted?.acp?.state).toBe("idle");
      expect(staleInMemory[sessionKey]?.acp).toEqual(persisted?.acp);
    });
  });

  it("preserves terminal lifecycle state when caller has a stale running snapshot", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-lifecycle-preserve";
      const sessionId = "test-lifecycle-preserve-session";
      const terminalEntry: SessionEntry = {
        sessionId,
        updatedAt: 2_000,
        status: "done",
        startedAt: 1_000,
        endedAt: 1_900,
        runtimeMs: 900,
      };
      await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: terminalEntry }, null, 2));

      const staleInMemory: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1_100,
          status: "running",
          startedAt: 1_000,
        },
      };

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore: staleInMemory,
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
      expect(persisted?.status).toBe("done");
      expect(persisted?.startedAt).toBe(1_000);
      expect(persisted?.endedAt).toBe(1_900);
      expect(persisted?.runtimeMs).toBe(900);
      expect(persisted?.modelProvider).toBe("openai");
      expect(persisted?.model).toBe("gpt-5.4");
      expect(staleInMemory[sessionKey]?.status).toBe("done");
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

  it("reuses a completed run entry while the session is still fresh", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:terminal-cli-session";
      const existingSessionId = "terminal-cli-session-old";
      const now = Date.now();
      await fs.writeFile(
        storePath,
        JSON.stringify(
          {
            [sessionKey]: {
              sessionId: existingSessionId,
              updatedAt: now,
              status: "done",
              startedAt: now - 1_000,
              endedAt: now - 100,
              runtimeMs: 900,
            },
          },
          null,
          2,
        ),
      );

      const result = resolveSession({
        cfg: {
          session: {
            store: storePath,
            mainKey: "main",
          },
        } as OpenClawConfig,
        sessionKey,
      });

      expect(result.isNewSession).toBe(false);
      expect(result.sessionId).toBe(existingSessionId);
      expect(result.sessionEntry?.sessionId).toBe(existingSessionId);
      expect(result.sessionEntry?.status).toBe("done");
      expect(result.sessionEntry?.endedAt).toBe(now - 100);
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

      const result: EmbeddedAgentRunResult = {
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

  it("persists estimated context budget status without marking stale usage fresh", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-context-budget-status";
      const sessionId = "test-context-budget-status-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          totalTokens: 21225,
          totalTokensFresh: true,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      const result: EmbeddedAgentRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "minimax",
            model: "MiniMax-M2.7",
            contextBudgetStatus: {
              schemaVersion: 1,
              source: "pre-prompt-estimate",
              updatedAt: 123,
              provider: "minimax",
              model: "MiniMax-M2.7",
              route: "fits",
              shouldCompact: false,
              estimatedPromptTokens: 18_000,
              contextTokenBudget: 32_000,
              promptBudgetBeforeReserve: 28_000,
              reserveTokens: 4_000,
              effectiveReserveTokens: 4_000,
              remainingPromptBudgetTokens: 10_000,
              overflowTokens: 0,
              toolResultReducibleChars: 0,
              messageCount: 4,
              unwindowedMessageCount: 4,
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
        defaultProvider: "minimax",
        defaultModel: "MiniMax-M2.7",
        result,
      });

      expect(sessionStore[sessionKey]?.totalTokens).toBe(21225);
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(false);
      expect(sessionStore[sessionKey]?.contextBudgetStatus).toMatchObject({
        source: "pre-prompt-estimate",
        estimatedPromptTokens: 18_000,
        contextTokenBudget: 32_000,
      });

      const persisted = loadSessionStore(storePath);
      expect(persisted[sessionKey]?.contextBudgetStatus?.estimatedPromptTokens).toBe(18_000);
    });
  });

  it("clears stale estimated context budget status when a runtime refresh has no current estimate", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-clear-context-budget-status";
      const sessionId = "test-clear-context-budget-status-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          totalTokens: 21225,
          totalTokensFresh: false,
          contextBudgetStatus: {
            schemaVersion: 1,
            source: "pre-prompt-estimate",
            updatedAt: 123,
            provider: "anthropic",
            model: "claude-sonnet-4.6",
            route: "fits",
            shouldCompact: false,
            estimatedPromptTokens: 18_000,
            contextTokenBudget: 32_000,
            promptBudgetBeforeReserve: 28_000,
            reserveTokens: 4_000,
            effectiveReserveTokens: 4_000,
            remainingPromptBudgetTokens: 10_000,
            overflowTokens: 0,
            toolResultReducibleChars: 0,
            messageCount: 4,
            unwindowedMessageCount: 4,
          },
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      const result: EmbeddedAgentRunResult = {
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

      expect(sessionStore[sessionKey]?.modelProvider).toBe("minimax");
      expect(sessionStore[sessionKey]?.model).toBe("MiniMax-M2.7");
      expect(sessionStore[sessionKey]?.contextBudgetStatus).toBeUndefined();

      const persisted = loadSessionStore(storePath);
      expect(persisted[sessionKey]?.contextBudgetStatus).toBeUndefined();
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

  it("persists CLI lastCallUsage as the context snapshot (totalTokens)", async () => {
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
      const sessionKey = "agent:main:explicit:test-cli-last-call-usage";
      const sessionId = "test-cli-last-call-usage-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
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
                input: 6,
                output: 25,
                cacheRead: 50_000,
                cacheWrite: 0,
              },
              lastCallUsage: {
                input: 6,
                output: 25,
                cacheRead: 50_000,
                cacheWrite: 0,
              },
            },
          },
        },
      });

      expect(sessionStore[sessionKey]?.totalTokens).toBe(50_006);
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(true);
      expect(loadSessionStore(storePath)[sessionKey]?.totalTokens).toBe(50_006);
      expect(loadSessionStore(storePath)[sessionKey]?.totalTokensFresh).toBe(true);
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

      const result: EmbeddedAgentRunResult = {
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

  it("prefers fresh CLI usage over zero compaction tokensAfter", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-zero-compaction-with-usage";
      const sessionId = "test-zero-compaction-with-usage-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          totalTokens: 1_794_391,
          totalTokensFresh: true,
          inputTokens: 20,
          outputTokens: 10_855,
          cacheRead: 1_761_324,
          cacheWrite: 33_047,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "claude-cli",
        defaultModel: "claude-opus-4-7",
        result: {
          meta: {
            durationMs: 500,
            agentMeta: {
              sessionId,
              provider: "claude-cli",
              model: "claude-opus-4-7",
              usage: {
                input: 20,
                output: 10_855,
                cacheRead: 1_761_324,
                cacheWrite: 33_047,
              },
              lastCallUsage: {
                input: 20,
                output: 10_855,
                cacheRead: 1_761_324,
                cacheWrite: 33_047,
              },
              compactionCount: 1,
              compactionTokensAfter: 0,
            },
          },
        } as EmbeddedAgentRunResult,
      });

      expect(sessionStore[sessionKey]?.totalTokens).toBe(1_794_391);
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(true);
      expect(sessionStore[sessionKey]?.inputTokens).toBe(20);
      expect(sessionStore[sessionKey]?.outputTokens).toBe(10_855);
      expect(sessionStore[sessionKey]?.cacheRead).toBe(1_761_324);
      expect(sessionStore[sessionKey]?.cacheWrite).toBe(33_047);
    });
  });

  it("prefers fresh usage over positive compaction tokensAfter", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-positive-compaction-with-usage";
      const sessionId = "test-positive-compaction-with-usage-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          totalTokens: 180_000,
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
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        result: {
          meta: {
            durationMs: 500,
            agentMeta: {
              sessionId,
              provider: "openai",
              model: "gpt-5.5",
              usage: {
                input: 100_000,
                output: 3_000,
                cacheRead: 20_000,
              },
              lastCallUsage: {
                input: 91_000,
                output: 1_000,
                cacheRead: 4_000,
              },
              compactionCount: 1,
              compactionTokensAfter: 80_000,
            },
          },
        } as EmbeddedAgentRunResult,
      });

      expect(sessionStore[sessionKey]?.totalTokens).toBe(120_000);
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(true);
      expect(sessionStore[sessionKey]?.inputTokens).toBe(100_000);
      expect(sessionStore[sessionKey]?.outputTokens).toBe(3_000);
      expect(sessionStore[sessionKey]?.cacheRead).toBe(20_000);
    });
  });

  it("accepts zero compaction tokensAfter when provider usage is unavailable", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-zero-compaction-tokens-after";
      const sessionId = "test-zero-compaction-tokens-after-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          totalTokens: 12_000,
          totalTokensFresh: true,
          inputTokens: 20,
          outputTokens: 10_855,
          cacheRead: 1_761_324,
          cacheWrite: 33_047,
          contextBudgetStatus: {
            schemaVersion: 1,
            source: "pre-prompt-estimate",
            updatedAt: 1,
            provider: "claude-cli",
            model: "claude-opus-4-7",
            route: "compact_only",
            shouldCompact: true,
            estimatedPromptTokens: 1_794_391,
            contextTokenBudget: 1_048_576,
            promptBudgetBeforeReserve: 1_044_480,
            reserveTokens: 4_096,
            effectiveReserveTokens: 4_096,
            remainingPromptBudgetTokens: 0,
            overflowTokens: 749_911,
            toolResultReducibleChars: 0,
            messageCount: 0,
            unwindowedMessageCount: 0,
          },
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
              compactionTokensAfter: 0,
            },
          },
        } as EmbeddedAgentRunResult,
      });

      expect(sessionStore[sessionKey]?.totalTokens).toBe(0);
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(true);
      expect(sessionStore[sessionKey]?.compactionCount).toBe(1);
      expect(sessionStore[sessionKey]?.inputTokens).toBeUndefined();
      expect(sessionStore[sessionKey]?.outputTokens).toBeUndefined();
      expect(sessionStore[sessionKey]?.cacheRead).toBeUndefined();
      expect(sessionStore[sessionKey]?.cacheWrite).toBeUndefined();
      expect(sessionStore[sessionKey]?.contextBudgetStatus).toBeUndefined();
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
      const result: EmbeddedAgentRunResult = {
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

  it("preserves runtime model and contextTokens when preserveRuntimeModel is true (heartbeat bleed fix)", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-heartbeat-bleed";
      const sessionId = "test-heartbeat-bleed-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
          contextTokens: 1_000_000,
          contextBudgetStatus: {
            schemaVersion: 1,
            source: "pre-prompt-estimate",
            updatedAt: 100,
            provider: "anthropic",
            model: "claude-opus-4-6",
            route: "fits",
            shouldCompact: false,
            estimatedPromptTokens: 640_000,
            contextTokenBudget: 1_000_000,
            promptBudgetBeforeReserve: 900_000,
            reserveTokens: 100_000,
            effectiveReserveTokens: 100_000,
            remainingPromptBudgetTokens: 260_000,
            overflowTokens: 0,
            toolResultReducibleChars: 0,
            messageCount: 12,
            unwindowedMessageCount: 12,
          },
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      // Heartbeat turn uses a different model
      const result: EmbeddedAgentRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "ollama",
            model: "llama3.2:1b",
            contextTokens: 128_000,
            contextBudgetStatus: {
              schemaVersion: 1,
              source: "pre-prompt-estimate",
              updatedAt: 200,
              provider: "ollama",
              model: "llama3.2:1b",
              route: "fits",
              shouldCompact: false,
              estimatedPromptTokens: 40_000,
              contextTokenBudget: 128_000,
              promptBudgetBeforeReserve: 112_000,
              reserveTokens: 16_000,
              effectiveReserveTokens: 16_000,
              remainingPromptBudgetTokens: 72_000,
              overflowTokens: 0,
              toolResultReducibleChars: 0,
              messageCount: 3,
              unwindowedMessageCount: 3,
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
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
        result,
        preserveRuntimeModel: true,
      });

      // Runtime model and contextTokens should be preserved from the original entry
      expect(sessionStore[sessionKey]?.model).toBe("claude-opus-4-6");
      expect(sessionStore[sessionKey]?.modelProvider).toBe("anthropic");
      expect(sessionStore[sessionKey]?.contextTokens).toBe(1_000_000);
      expect(sessionStore[sessionKey]?.contextBudgetStatus?.provider).toBe("anthropic");
      expect(sessionStore[sessionKey]?.contextBudgetStatus?.estimatedPromptTokens).toBe(640_000);

      const persisted = loadSessionStore(storePath);
      expect(persisted[sessionKey]?.model).toBe("claude-opus-4-6");
      expect(persisted[sessionKey]?.modelProvider).toBe("anthropic");
      expect(persisted[sessionKey]?.contextTokens).toBe(1_000_000);
      expect(persisted[sessionKey]?.contextBudgetStatus?.provider).toBe("anthropic");
      expect(persisted[sessionKey]?.contextBudgetStatus?.estimatedPromptTokens).toBe(640_000);
    });
  });

  it("preserves user-facing run accounting while allowing session touch metadata", async () => {
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
      const sessionKey = "agent:main:explicit:test-preserve-user-facing-run-state";
      const sessionId = "test-preserve-user-facing-run-state-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          lastInteractionAt: 10,
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
          contextTokens: 1_000_000,
          inputTokens: 11,
          outputTokens: 22,
          totalTokens: 333,
          totalTokensFresh: true,
          cacheRead: 4,
          cacheWrite: 5,
          estimatedCostUsd: 0.25,
          abortedLastRun: false,
          cliSessionBindings: {
            "claude-cli": { sessionId: "visible-cli-session" },
          },
          compactionCount: 7,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));
      const freshVisibleEntry: SessionEntry = {
        sessionId: "fresh-visible-session-id",
        updatedAt: 2,
        sessionStartedAt: 777,
        lastInteractionAt: 20,
        modelProvider: "openai",
        model: "gpt-5.5",
        contextTokens: 400_000,
        inputTokens: 44,
        outputTokens: 55,
        totalTokens: 666,
        totalTokensFresh: true,
        cacheRead: 7,
        cacheWrite: 8,
        estimatedCostUsd: 0.5,
        abortedLastRun: false,
        cliSessionBindings: {
          "claude-cli": { sessionId: "new-visible-cli-session" },
        },
        compactionCount: 9,
      };
      await fs.writeFile(storePath, JSON.stringify({ [sessionKey]: freshVisibleEntry }, null, 2));

      const result: EmbeddedAgentRunResult = {
        meta: {
          durationMs: 500,
          aborted: true,
          agentMeta: {
            sessionId,
            provider: "claude-cli",
            model: "claude-sonnet-4-6",
            contextTokens: 200_000,
            usage: {
              input: 100,
              output: 50,
              cacheRead: 10,
              cacheWrite: 20,
            },
            compactionCount: 3,
            cliSessionBinding: {
              sessionId: "handoff-cli-session",
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
        preserveUserFacingSessionModelState: true,
      });

      const next = sessionStore[sessionKey];
      expect(next?.sessionId).toBe("fresh-visible-session-id");
      expect(next?.sessionStartedAt).toBe(777);
      expect(next?.modelProvider).toBe("openai");
      expect(next?.model).toBe("gpt-5.5");
      expect(next?.contextTokens).toBe(400_000);
      expect(next?.inputTokens).toBe(44);
      expect(next?.outputTokens).toBe(55);
      expect(next?.totalTokens).toBe(666);
      expect(next?.totalTokensFresh).toBe(true);
      expect(next?.cacheRead).toBe(7);
      expect(next?.cacheWrite).toBe(8);
      expect(next?.estimatedCostUsd).toBe(0.5);
      expect(next?.abortedLastRun).toBe(false);
      expect(next?.cliSessionBindings?.["claude-cli"]?.sessionId).toBe("new-visible-cli-session");
      expect(next?.compactionCount).toBe(9);
      expect(next?.lastInteractionAt).toBeGreaterThan(20);
    });
  });

  it("leaves contextTokens unset when entry has prior model but no contextTokens (heartbeat bleed guard)", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-heartbeat-no-context-tokens";
      const sessionId = "test-heartbeat-no-context-tokens-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
          // contextTokens intentionally missing — older session without cached context
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      // Heartbeat turn uses a different, smaller model
      const result: EmbeddedAgentRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "ollama",
            model: "llama3.2:1b",
            contextTokens: 128_000,
          },
        },
      };

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
        result,
        preserveRuntimeModel: true,
      });

      // Runtime model should be preserved
      expect(sessionStore[sessionKey]?.model).toBe("claude-opus-4-6");
      expect(sessionStore[sessionKey]?.modelProvider).toBe("anthropic");
      // contextTokens should NOT bleed from the heartbeat run's smaller window
      expect(sessionStore[sessionKey]?.contextTokens).toBeUndefined();
    });
  });

  it("does not set runtime model when preserveRuntimeModel is true and entry has no prior runtime model", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-heartbeat-new-session";
      const sessionId = "test-heartbeat-new-session-id";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      const result: EmbeddedAgentRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "ollama",
            model: "llama3.2:1b",
            contextTokens: 128_000,
          },
        },
      };

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "ollama",
        defaultModel: "llama3.2:1b",
        result,
        preserveRuntimeModel: true,
      });

      // Heartbeat should NOT establish initial model state on an empty session
      expect(sessionStore[sessionKey]?.model).toBeUndefined();
      expect(sessionStore[sessionKey]?.modelProvider).toBeUndefined();
      expect(sessionStore[sessionKey]?.contextTokens).toBeUndefined();
    });
  });

  it("preserves model without borrowing heartbeat provider when entry has model but no modelProvider", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-heartbeat-model-no-provider";
      const sessionId = "test-heartbeat-model-no-provider-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          model: "claude-opus-4-6",
          // modelProvider intentionally missing
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      // Heartbeat turn uses a different provider
      const result: EmbeddedAgentRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "ollama",
            model: "llama3.2:1b",
            contextTokens: 128_000,
          },
        },
      };

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
        result,
        preserveRuntimeModel: true,
      });

      // Model preserved, provider NOT borrowed from heartbeat
      expect(sessionStore[sessionKey]?.model).toBe("claude-opus-4-6");
      expect(sessionStore[sessionKey]?.modelProvider).toBeUndefined();

      const persisted = loadSessionStore(storePath);
      expect(persisted[sessionKey]?.model).toBe("claude-opus-4-6");
      expect(persisted[sessionKey]?.modelProvider).toBeUndefined();
    });
  });

  it("overwrites runtime model when preserveRuntimeModel is false (default behavior)", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-normal-overwrite";
      const sessionId = "test-normal-overwrite-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
          contextTokens: 1_000_000,
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      const result: EmbeddedAgentRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "openai",
            model: "gpt-5.4",
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
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
        result,
      });

      // Normal turn: runtime model is updated
      expect(sessionStore[sessionKey]?.model).toBe("gpt-5.4");
      expect(sessionStore[sessionKey]?.modelProvider).toBe("openai");
      expect(sessionStore[sessionKey]?.contextTokens).toBe(400_000);
    });
  });
});

describe("recordCliCompactionInStore", () => {
  it("persists native compaction token counts and clears stale CLI usage breakdown", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:test-record-cli-compaction";
      const sessionId = "test-record-cli-compaction-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          totalTokens: 12_000,
          totalTokensFresh: true,
          inputTokens: 9_000,
          outputTokens: 100,
          cacheRead: 2_900,
          cacheWrite: 0,
          contextBudgetStatus: {
            schemaVersion: 1,
            source: "pre-prompt-estimate",
            updatedAt: 123,
            provider: "codex",
            model: "gpt-5.5",
            route: "fits",
            shouldCompact: false,
            estimatedPromptTokens: 18_000,
            contextTokenBudget: 32_000,
            promptBudgetBeforeReserve: 28_000,
            reserveTokens: 4_000,
            effectiveReserveTokens: 4_000,
            remainingPromptBudgetTokens: 10_000,
            overflowTokens: 0,
            toolResultReducibleChars: 0,
            messageCount: 4,
            unwindowedMessageCount: 4,
          },
          cliSessionBindings: {
            codex: {
              sessionId: "stale-cli-session",
            },
          },
          cliSessionIds: {
            codex: "stale-cli-session",
          },
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      await recordCliCompactionInStore({
        provider: "codex",
        sessionKey,
        sessionStore,
        storePath,
        tokensAfter: 0,
      });

      const persisted = loadSessionStore(storePath);
      expect(sessionStore[sessionKey]?.compactionCount).toBe(1);
      expect(sessionStore[sessionKey]?.totalTokens).toBe(0);
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(true);
      expect(sessionStore[sessionKey]?.inputTokens).toBeUndefined();
      expect(sessionStore[sessionKey]?.outputTokens).toBeUndefined();
      expect(sessionStore[sessionKey]?.cacheRead).toBeUndefined();
      expect(sessionStore[sessionKey]?.cacheWrite).toBeUndefined();
      expect(sessionStore[sessionKey]?.contextBudgetStatus).toBeUndefined();
      expect(sessionStore[sessionKey]?.cliSessionBindings?.codex).toBeUndefined();
      expect(sessionStore[sessionKey]?.cliSessionIds?.codex).toBeUndefined();
      expect(persisted[sessionKey]?.totalTokens).toBe(0);
      expect(persisted[sessionKey]?.totalTokensFresh).toBe(true);
      expect(persisted[sessionKey]?.contextBudgetStatus).toBeUndefined();
    });
  });

  it("marks CLI token counts stale when native compaction returns no token count", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:test-record-cli-compaction-unknown";
      const sessionId = "test-record-cli-compaction-unknown-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          totalTokens: 37_000,
          totalTokensFresh: true,
          inputTokens: 30_000,
          outputTokens: 100,
          cacheRead: 6_900,
          cacheWrite: 0,
          contextBudgetStatus: {
            schemaVersion: 1,
            source: "pre-prompt-estimate",
            updatedAt: 123,
            provider: "codex",
            model: "gpt-5.5",
            route: "compact_only",
            shouldCompact: true,
            estimatedPromptTokens: 48_000,
            contextTokenBudget: 32_000,
            promptBudgetBeforeReserve: 28_000,
            reserveTokens: 4_000,
            effectiveReserveTokens: 4_000,
            remainingPromptBudgetTokens: 0,
            overflowTokens: 20_000,
            toolResultReducibleChars: 0,
            messageCount: 40,
            unwindowedMessageCount: 40,
          },
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      await recordCliCompactionInStore({
        provider: "codex",
        sessionKey,
        sessionStore,
        storePath,
      });

      const persisted = loadSessionStore(storePath);
      expect(sessionStore[sessionKey]?.compactionCount).toBe(1);
      expect(sessionStore[sessionKey]?.totalTokens).toBe(37_000);
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(false);
      expect(sessionStore[sessionKey]?.inputTokens).toBeUndefined();
      expect(sessionStore[sessionKey]?.outputTokens).toBeUndefined();
      expect(sessionStore[sessionKey]?.cacheRead).toBeUndefined();
      expect(sessionStore[sessionKey]?.cacheWrite).toBeUndefined();
      expect(sessionStore[sessionKey]?.contextBudgetStatus).toBeUndefined();
      expect(persisted[sessionKey]?.totalTokens).toBe(37_000);
      expect(persisted[sessionKey]?.totalTokensFresh).toBe(false);
      expect(persisted[sessionKey]?.contextBudgetStatus).toBeUndefined();
    });
  });

  it("persists successor session handles from native CLI compaction", async () => {
    await withTempSessionStore(async ({ dir, storePath }) => {
      const sessionKey = "agent:main:explicit:test-record-cli-compaction-rotate";
      const sessionId = "test-record-cli-compaction-rotate-session";
      const nextSessionId = "test-record-cli-compaction-rotate-next";
      const nextSessionFile = path.join(dir, `${nextSessionId}.jsonl`);
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          sessionFile: path.join(dir, `${sessionId}.jsonl`),
        },
      };
      await fs.writeFile(storePath, JSON.stringify(sessionStore, null, 2));

      await recordCliCompactionInStore({
        provider: "codex",
        sessionKey,
        sessionStore,
        storePath,
        newSessionId: nextSessionId,
        newSessionFile: nextSessionFile,
      });

      expect(sessionStore[sessionKey]?.sessionId).toBe(nextSessionId);
      expect(sessionStore[sessionKey]?.sessionFile).toBe(nextSessionFile);
      expect(sessionStore[sessionKey]?.usageFamilyKey).toBe(sessionKey);
      expect(sessionStore[sessionKey]?.usageFamilySessionIds).toEqual([sessionId, nextSessionId]);

      const persisted = loadSessionStore(storePath);
      expect(persisted[sessionKey]?.sessionId).toBe(nextSessionId);
      expect(persisted[sessionKey]?.sessionFile).toBe(nextSessionFile);
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
