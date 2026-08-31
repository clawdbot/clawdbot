// Covers command-session store updates after agent runs, CLI compaction, and
// runtime metadata persistence.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveFreshSessionTotalTokens,
  type InternalSessionEntry as SessionEntry,
} from "../../config/sessions.js";
import * as sessionAccessor from "../../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent.js";
import {
  clearCliSessionInStore,
  consumeCliSessionForkInStore,
  persistCliSessionForkSuccessorInStore,
  restoreCliSessionForkInStore,
  recordCliCompactionInStore,
  updateSessionStoreAfterAgentRun as updateSessionStoreAfterAgentRunBase,
} from "./session-store.js";
import { resolveSession } from "./session.js";

const { listSessionEntriesCore, loadSessionEntry, replaceSessionEntry } = sessionAccessor;

vi.mock("../model-selection.js", () => ({
  isCliProvider: (provider: string, _cfg?: OpenClawConfig) =>
    ["claude-cli", "codex-cli", "google-gemini-cli"].includes(provider.trim().toLowerCase()),
  normalizeProviderId: (provider: string) => provider.trim().toLowerCase(),
}));

type MockProviderModel = {
  id: string;
  cost?: import("../../utils/usage-format.js").ModelCostConfig;
};

type MockUsageFormatConfig = {
  models?: {
    providers?: Record<string, { models?: MockProviderModel[] }>;
  };
};

vi.mock("../../utils/usage-format.js", async (importOriginal) => {
  const { estimateAggregateUsageCost } =
    await importOriginal<typeof import("../../utils/usage-format.js")>();
  return {
    estimateAggregateUsageCost,
    resolveModelCostConfig: (params: {
      provider?: string;
      model?: string;
      config?: unknown;
      agentDir?: string;
    }) => {
      const agents = (params.config as OpenClawConfig | undefined)?.agents?.list ?? [];
      if (agents.length > 1 && !params.agentDir) {
        throw new Error("multi-agent cost resolution requires an explicit agent directory");
      }
      const providers = (params.config as MockUsageFormatConfig | undefined)?.models?.providers;
      return providers?.[params.provider ?? ""]?.models?.find((entry) => entry.id === params.model)
        ?.cost;
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
    closeOpenClawAgentDatabasesForTest();
    // SQLite teardown can race fixture removal on loaded CI hosts. Keep the
    // retries bounded so persistent cleanup failures still surface.
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 25 });
  }
}

async function seedSessionStore(
  storePath: string,
  entries: Record<string, SessionEntry>,
): Promise<void> {
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ storePath, sessionKey }, entry);
  }
}

function loadPersistedSessionStore(storePath: string): Record<string, SessionEntry> {
  return Object.fromEntries(
    listSessionEntriesCore({ storePath }).map(({ sessionKey, entry }) => [sessionKey, entry]),
  );
}

function loadPersistedSessionEntry(
  storePath: string,
  sessionKey: string,
): SessionEntry | undefined {
  return loadSessionEntry({ storePath, sessionKey }) ?? undefined;
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

type SessionStoreUpdateParams = Parameters<typeof updateSessionStoreAfterAgentRunBase>[0];

async function updateSessionStoreAfterAgentRun(
  params: Omit<SessionStoreUpdateParams, "agentDir"> & { agentDir?: string },
) {
  await updateSessionStoreAfterAgentRunBase({
    ...params,
    agentDir: params.agentDir ?? "/tmp/openclaw-session-store-test-agent",
  });
}

describe("updateSessionStoreAfterAgentRun", () => {
  it.each(["finalizer", "cli-compaction"] as const)(
    "publishes %s cache at commit without overwriting a subsequent writer",
    async (operation) => {
      await withTempSessionStore(async ({ storePath }) => {
        const sessionKey = `agent:main:commit-publication:${operation}`;
        const owner: SessionEntry = {
          sessionId: "committed-session",
          lifecycleRevision: "lifecycle",
          activeWriterRunId: "current-writer",
          updatedAt: 1,
          compactionCount: 2,
          totalTokens: 900,
          totalTokensFresh: true,
        };
        await seedSessionStore(storePath, { [sessionKey]: owner });
        const sessionStore = { [sessionKey]: owner };
        const replacement: SessionEntry = {
          ...owner,
          activeWriterRunId: "replacement-writer",
          updatedAt: 2,
          compactionCount: 9,
          totalTokens: 777,
        };
        const observed: Array<{ cached: SessionEntry; persisted?: SessionEntry }> = [];
        let replacementSnapshot: SessionEntry | undefined;
        const originalPatch = sessionAccessor.patchSessionEntryCore;
        const patch = vi
          .spyOn(sessionAccessor, "patchSessionEntryCore")
          .mockImplementation((scope, update, options) =>
            originalPatch(scope, update, {
              ...options,
              onCommitted: (committed) => {
                options?.onCommitted?.(committed);
                if (scope.sessionKey !== sessionKey || scope.storePath !== storePath) {
                  return;
                }
                observed.push({
                  cached: sessionStore[sessionKey]!,
                  persisted: loadSessionEntry({ ...scope, readConsistency: "latest" }),
                });
                sessionAccessor.replaceSessionEntrySync(scope, replacement);
                const canonicalReplacement = loadSessionEntry({
                  ...scope,
                  readConsistency: "latest",
                });
                if (!canonicalReplacement) {
                  throw new Error("expected the committed replacement writer");
                }
                replacementSnapshot = structuredClone(canonicalReplacement);
                sessionStore[sessionKey] = canonicalReplacement;
              },
            }),
          );
        try {
          let recorded: SessionEntry | undefined;
          if (operation === "cli-compaction") {
            recorded = await recordCliCompactionInStore({
              compactionKind: "native-harness",
              sessionKey,
              sessionStore,
              storePath,
              expectedSession: owner,
              tokensAfter: 42,
            });
          } else {
            await updateSessionStoreAfterAgentRun({
              cfg: {},
              sessionId: owner.sessionId,
              sessionKey,
              sessionStore,
              storePath,
              defaultProvider: "openai",
              defaultModel: "gpt-5.6-luna",
              compactionAccounting: {
                kind: "durable",
                count: 0,
                currentContextSnapshot: { tokens: 42 },
                target: {
                  agentId: "main",
                  sessionId: owner.sessionId,
                  sessionKey,
                  storePath,
                  lifecycleRevision: owner.lifecycleRevision,
                  activeWriterRunId: owner.activeWriterRunId,
                },
              },
              result: { meta: { durationMs: 1 } },
            });
          }

          expect(observed).toHaveLength(1);
          expect(observed[0]?.persisted).toMatchObject({
            activeWriterRunId: "current-writer",
            totalTokens: 42,
            compactionCount: operation === "cli-compaction" ? 3 : 2,
          });
          expect(observed[0]?.cached).toEqual(observed[0]?.persisted);
          expect(replacementSnapshot).toBeDefined();
          expect(sessionStore[sessionKey]).toEqual(replacementSnapshot);
          expect(loadPersistedSessionEntry(storePath, sessionKey)).toEqual(replacementSnapshot);
          if (operation === "cli-compaction") {
            expect(recorded).toEqual(observed[0]?.persisted);
          }
        } finally {
          patch.mockRestore();
        }
      });
    },
  );

  it("uses the prepared agent directory for multi-agent cost accounting", async () => {
    await withTempSessionStore(async ({ dir, storePath }) => {
      const sessionKey = "agent:marie:dashboard:cost-accounting";
      const sessionId = "cost-accounting-session";
      const sessionStore: Record<string, SessionEntry> = {};

      await updateSessionStoreAfterAgentRun({
        cfg: {
          agents: { list: [{ id: "main" }, { id: "marie" }] },
          models: {
            providers: {
              openai: {
                baseUrl: "https://api.openai.com/v1",
                models: [
                  {
                    id: "gpt-5.5",
                    name: "GPT-5.5",
                    reasoning: true,
                    input: ["text"],
                    cost: { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 128_000,
                    maxTokens: 8_192,
                  },
                ],
              },
            },
          },
        } satisfies OpenClawConfig,
        agentDir: path.join(dir, "agents", "marie", "agent"),
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        result: {
          meta: {
            durationMs: 1,
            agentMeta: {
              sessionId,
              provider: "openai",
              model: "gpt-5.5",
              usage: { input: 1_000_000, output: 1_000_000 },
            },
          },
        },
      });

      expect(sessionStore[sessionKey]?.estimatedCostUsd).toBe(6);
    });
  });

  it("clears the durable replay-safe recovery guard after the recovery run terminates", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:restart-recovery";
      const sessionId = "restart-recovery-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          restartRecoveryForceSafeTools: true,
        },
      };
      await seedSessionStore(storePath, sessionStore);

      await updateSessionStoreAfterAgentRun({
        cfg: {} as OpenClawConfig,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        clearRestartRecoveryForceSafeTools: true,
        result: {
          meta: {
            durationMs: 1,
            agentMeta: { sessionId, provider: "openai", model: "gpt-5.5" },
          },
        },
      });

      expect(sessionStore[sessionKey]?.restartRecoveryForceSafeTools).toBeUndefined();
      expect(
        loadPersistedSessionEntry(storePath, sessionKey)?.restartRecoveryForceSafeTools,
      ).toBeUndefined();
    });
  });

  it("keeps the durable replay-safe recovery guard when the recovery run is aborted", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:aborted-restart-recovery";
      const sessionId = "aborted-restart-recovery-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          restartRecoveryForceSafeTools: true,
        },
      };
      await seedSessionStore(storePath, sessionStore);

      await updateSessionStoreAfterAgentRun({
        cfg: {} as OpenClawConfig,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        clearRestartRecoveryForceSafeTools: true,
        result: {
          meta: {
            durationMs: 1,
            aborted: true,
            agentMeta: { sessionId, provider: "openai", model: "gpt-5.5" },
          },
        },
      });

      expect(sessionStore[sessionKey]?.restartRecoveryForceSafeTools).toBe(true);
      expect(loadPersistedSessionEntry(storePath, sessionKey)?.restartRecoveryForceSafeTools).toBe(
        true,
      );
    });
  });

  it("preserves a concurrent rename and unpin during final accounting", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:test-management-race";
      const sessionId = "test-management-race-session";
      const staleEntry: SessionEntry = {
        sessionId,
        updatedAt: 1,
        label: "Old label",
        pinnedAt: 100,
        chatType: "direct",
        elevatedLevel: "full",
        inheritedToolAllow: ["exec"],
        sendPolicy: "allow",
      };
      const sessionStore = { [sessionKey]: staleEntry };
      const concurrentEntry: SessionEntry = {
        ...staleEntry,
        chatType: "group",
        label: "Renamed while running",
        sendPolicy: "deny",
        updatedAt: 2,
      };
      delete concurrentEntry.elevatedLevel;
      delete concurrentEntry.inheritedToolAllow;
      delete concurrentEntry.pinnedAt;
      await seedSessionStore(storePath, { [sessionKey]: concurrentEntry });

      await updateSessionStoreAfterAgentRun({
        cfg: {} as OpenClawConfig,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        result: {
          meta: {
            durationMs: 1,
            agentMeta: { sessionId, provider: "openai", model: "gpt-5.5" },
          },
        },
      });

      expect(sessionStore[sessionKey]).toMatchObject({
        chatType: "group",
        label: "Renamed while running",
        model: "gpt-5.5",
        sendPolicy: "deny",
      });
      expect(sessionStore[sessionKey]?.elevatedLevel).toBeUndefined();
      expect(sessionStore[sessionKey]?.inheritedToolAllow).toBeUndefined();
      expect(sessionStore[sessionKey]?.pinnedAt).toBeUndefined();
      expect(loadPersistedSessionEntry(storePath, sessionKey)).toEqual(sessionStore[sessionKey]);
    });
  });

  it("passes resolved maintenance config to the gateway turn store write", async () => {
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
      const now = Date.now();
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: now,
        },
        ...Object.fromEntries(
          Array.from({ length: 45 }, (_, index) => [
            `agent:main:stale:${index}`,
            {
              sessionId: `stale-${index}`,
              updatedAt: now - index - 1,
            } satisfies SessionEntry,
          ]),
        ),
      };
      await seedSessionStore(storePath, sessionStore);
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

      const persisted = loadPersistedSessionStore(storePath);
      expect(Object.keys(persisted)).toHaveLength(42);
      expect(persisted[sessionKey]?.sessionId).toBe(sessionId);
      expect(persisted["agent:main:stale:44"]).toBeUndefined();
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
          sessionFile: path.join(path.dirname(storePath), "legacy-predecessor.jsonl"),
          updatedAt: 1,
        },
      };
      await seedSessionStore(storePath, sessionStore);
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
      expect(loadPersistedSessionEntry(storePath, sessionKey)?.agentHarnessId).toBe("codex");
    });
  });

  it("rejects a finalizer attempting to rebind from public compaction metadata", async () => {
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
      await seedSessionStore(storePath, sessionStore);

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

      expect(sessionStore[sessionKey]?.sessionId).toBe(sessionId);
      expect(loadPersistedSessionEntry(storePath, sessionKey)?.sessionId).toBe(sessionId);
      expect(loadPersistedSessionEntry(storePath, sessionKey)?.compactionCount).toBeUndefined();
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
          agentHarnessId: "openclaw",
        },
      };
      await seedSessionStore(storePath, sessionStore);

      const result: EmbeddedAgentRunResult = {
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId,
            provider: "openai",
            model: "gpt-5.5",
            contextTokens: 400_000,
            contextTokensSource: "runtime",
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
      expect(sessionStore[sessionKey]?.contextTokensSource).toBe("runtime");
      expect(sessionStore[sessionKey]?.agentHarnessId).toBeUndefined();
      expect(loadPersistedSessionEntry(storePath, sessionKey)?.contextTokens).toBe(400_000);
      expect(loadPersistedSessionEntry(storePath, sessionKey)?.contextTokensSource).toBe("runtime");
      expect(loadPersistedSessionEntry(storePath, sessionKey)?.agentHarnessId).toBeUndefined();
    });
  });

  it("caps configured context override by the resolved runtime model window", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {
        models: {
          providers: {
            openai: {
              models: [{ id: "gpt-5.5", contextWindow: 272_000 }],
            },
          },
        },
      } as unknown as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-capped-context-override";
      const sessionId = "test-capped-context-override-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
        },
      };
      await seedSessionStore(storePath, sessionStore);

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

      expect(sessionStore[sessionKey]?.contextTokens).toBe(272_000);
      expect(sessionStore[sessionKey]?.contextTokensSource).toBe("resolved");
      expect(loadPersistedSessionEntry(storePath, sessionKey)?.contextTokens).toBe(272_000);
      expect(loadPersistedSessionEntry(storePath, sessionKey)?.contextTokensSource).toBe(
        "resolved",
      );
    });
  });

  it("persists the prepared claude-cli context budget", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {
        agents: {
          defaults: {},
        },
      } as unknown as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-claude-cli-configured-context";
      const sessionId = "test-claude-cli-configured-context-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          contextTokens: 1_048_576,
        },
      };
      await seedSessionStore(storePath, sessionStore);

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
            durationMs: 1,
            executionTrace: { runner: "cli" },
            agentMeta: {
              sessionId,
              provider: "claude-cli",
              model: "claude-opus-4-7",
              contextTokens: 100_000,
            },
          },
        } as EmbeddedAgentRunResult,
      });

      expect(sessionStore[sessionKey]?.contextTokens).toBe(100_000);
      expect(loadPersistedSessionEntry(storePath, sessionKey)?.contextTokens).toBe(100_000);
    });
  });

  it("clears the embedded harness pin after a CLI run", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {
        agents: {
          defaults: {},
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
      await seedSessionStore(storePath, sessionStore);

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
      expect(loadPersistedSessionEntry(storePath, sessionKey)?.agentHarnessId).toBeUndefined();
    });
  });

  it("persists claude-cli session bindings when the backend is configured", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {
        agents: {
          defaults: {},
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
      await seedSessionStore(storePath, sessionStore);

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

      const persisted = loadPersistedSessionStore(storePath);
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
          defaults: {},
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
      await seedSessionStore(storePath, sessionStore);

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

      const persisted = loadPersistedSessionStore(storePath);
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
      await seedSessionStore(storePath, { [sessionKey]: existing });

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

      const persisted = loadPersistedSessionEntry(storePath, sessionKey);
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
      await seedSessionStore(storePath, { [sessionKey]: terminalEntry });

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

      const persisted = loadPersistedSessionEntry(storePath, sessionKey);
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
      await seedSessionStore(storePath, sessionStore);

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

      const persisted = loadPersistedSessionEntry(storePath, sessionKey);
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
          defaults: {},
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
        sessionStore: {},
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

      const persisted = loadPersistedSessionEntry(storePath, first.sessionKey!);
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
      await seedSessionStore(storePath, {
        [sessionKey]: {
          sessionId: existingSessionId,
          updatedAt: now,
          status: "done",
          startedAt: now - 1_000,
          endedAt: now - 100,
          runtimeMs: 900,
        },
      });

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
      await seedSessionStore(storePath, sessionStore);

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

      const persisted = loadPersistedSessionStore(storePath);
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
      await seedSessionStore(storePath, sessionStore);

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

      const persisted = loadPersistedSessionStore(storePath);
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
      await seedSessionStore(storePath, sessionStore);

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

      const persisted = loadPersistedSessionStore(storePath);
      expect(persisted[sessionKey]?.contextBudgetStatus).toBeUndefined();
    });
  });

  it("does not treat CLI cumulative usage as a fresh context snapshot", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {
        agents: {
          defaults: {},
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
      await seedSessionStore(storePath, sessionStore);

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

  it("uses non-CLI last-call usage when promptTokens is unavailable", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:test-responses-cumulative-usage";
      const sessionId = "test-responses-cumulative-usage-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
        },
      };
      await seedSessionStore(storePath, sessionStore);

      await updateSessionStoreAfterAgentRun({
        cfg: {} as OpenClawConfig,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "custom-openai",
        defaultModel: "responses-model",
        result: {
          meta: {
            durationMs: 1,
            agentMeta: {
              sessionId,
              provider: "custom-openai",
              model: "responses-model",
              usage: {
                input: 497_720,
                output: 7_485,
                cacheRead: 1_323_520,
                cacheWrite: 0,
                total: 1_828_725,
              },
              lastCallUsage: {
                input: 38_333,
                output: 66,
                cacheRead: 120_320,
                cacheWrite: 0,
                total: 158_719,
              },
            },
          },
        } as EmbeddedAgentRunResult,
      });

      expect(sessionStore[sessionKey]?.totalTokens).toBe(158_653);
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(true);
      expect(loadPersistedSessionEntry(storePath, sessionKey)?.totalTokens).toBe(158_653);
    });
  });

  it.each([
    { observation: "compaction after model", tokens: 80_000, count: 1 },
    { observation: "model after compaction", tokens: 95_000, count: 1 },
    { observation: "zero-token compaction", tokens: 0, count: 1 },
    { observation: "unknown context", tokens: undefined, count: 1 },
    { observation: "model-only initial writer", tokens: 95_000, count: 0 },
  ])("persists private $observation independently of billing usage", async ({ tokens, count }) => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:ordered-context";
      const sessionId = "ordered-context-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          totalTokens: 180_000,
          totalTokensFresh: true,
          compactionCount: 3,
          estimatedCostUsd: 1.25,
          lifecycleRevision: "lifecycle",
          activeWriterRunId: "previous-writer",
        },
      };
      await seedSessionStore(storePath, {
        [sessionKey]: { ...sessionStore[sessionKey]!, activeWriterRunId: "current-writer" },
      });
      const usage = {
        input: 100_000,
        output: 3_000,
        cacheRead: 20_000,
        cacheWrite: 1_000,
        cost: { total: 0.75 },
      };
      const lastCallUsage = { input: 91_000, output: 1_000, cacheRead: 4_000 };
      const result: EmbeddedAgentRunResult = {
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId,
            provider: "openai",
            model: "gpt-5.6-luna",
            usage,
            lastCallUsage,
            promptTokens: 95_000,
            compactionCount: 99,
            compactionTokensAfter: 80_000,
          },
        },
      };

      await updateSessionStoreAfterAgentRun({
        cfg: {},
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.6-luna",
        compactionAccounting: {
          kind: "durable",
          count,
          currentContextSnapshot: { tokens },
          target: {
            agentId: "main",
            sessionId,
            sessionKey,
            storePath,
            lifecycleRevision: "lifecycle",
            activeWriterRunId: "current-writer",
          },
        },
        result,
      });

      for (const entry of [
        sessionStore[sessionKey],
        loadPersistedSessionEntry(storePath, sessionKey),
      ]) {
        expect(entry).toMatchObject({
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          estimatedCostUsd: 0.75,
          compactionCount: 3,
          activeWriterRunId: "current-writer",
          totalTokensFresh: tokens !== undefined,
        });
        expect(entry?.totalTokens).toBe(tokens);
        expect(resolveFreshSessionTotalTokens(entry)).toBe(tokens);
      }
      expect(result.meta.agentMeta?.usage).toEqual(usage);
      expect(result.meta.agentMeta?.lastCallUsage).toEqual(lastCallUsage);
    });
  });

  it.each(["missing", "replaced"] as const)(
    "does not write through a private fact whose owner is %s",
    async (ownerState) => {
      await withTempSessionStore(async ({ storePath }) => {
        const sessionId = "stale-private-fact";
        const sessionKey = `agent:main:explicit:${sessionId}`;
        const replacement: SessionEntry | undefined =
          ownerState === "replaced"
            ? {
                sessionId,
                updatedAt: 1,
                lifecycleRevision: "lifecycle",
                activeWriterRunId: "replacement-writer",
                totalTokens: 73_000,
                totalTokensFresh: true,
              }
            : undefined;
        if (replacement) {
          await seedSessionStore(storePath, { [sessionKey]: replacement });
        }
        const before = loadPersistedSessionEntry(storePath, sessionKey);
        const sessionStore: Record<string, SessionEntry> = {};

        await updateSessionStoreAfterAgentRun({
          cfg: {},
          sessionId,
          sessionKey,
          storePath,
          sessionStore,
          defaultProvider: "openai",
          defaultModel: "gpt-5.6-luna",
          compactionAccounting: {
            kind: "durable",
            count: 0,
            currentContextSnapshot: { tokens: 42 },
            target: {
              agentId: "main",
              sessionId,
              sessionKey,
              storePath,
              lifecycleRevision: "lifecycle",
              activeWriterRunId: "previous-writer",
            },
          },
          result: {
            meta: {
              durationMs: 1,
              agentMeta: {
                sessionId,
                provider: "openai",
                model: "gpt-5.6-luna",
                usage: { cost: { total: 0.75 } },
              },
            },
          },
        });

        expect(loadPersistedSessionEntry(storePath, sessionKey)).toEqual(before);
        expect(sessionStore[sessionKey]).toBeUndefined();
      });
    },
  );

  it("persists CLI lastCallUsage as the context snapshot (totalTokens)", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {
        agents: {
          defaults: {},
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
      await seedSessionStore(storePath, sessionStore);

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
      expect(loadPersistedSessionEntry(storePath, sessionKey)?.totalTokens).toBe(50_006);
      expect(loadPersistedSessionEntry(storePath, sessionKey)?.totalTokensFresh).toBe(true);
    });
  });

  it.each([21_225, 0])(
    "persists private context %s without erasing prior billing",
    async (tokens) => {
      await withTempSessionStore(async ({ storePath }) => {
        const sessionKey = "agent:main:explicit:private-context-without-usage";
        const sessionId = "private-context-without-usage";
        const billing = { inputTokens: 20, outputTokens: 10, cacheRead: 30, cacheWrite: 40 };
        const sessionStore: Record<string, SessionEntry> = {
          [sessionKey]: { sessionId, updatedAt: 1, ...billing },
        };
        await seedSessionStore(storePath, sessionStore);

        await updateSessionStoreAfterAgentRun({
          cfg: {},
          sessionId,
          sessionKey,
          storePath,
          sessionStore,
          defaultProvider: "openai",
          defaultModel: "gpt-5.6-luna",
          compactionAccounting: {
            kind: "durable",
            count: 1,
            currentContextSnapshot: { tokens },
            target: {
              agentId: "main",
              sessionId,
              sessionKey,
              storePath,
              lifecycleRevision: undefined,
              activeWriterRunId: undefined,
            },
          },
          result: {
            meta: {
              durationMs: 500,
              agentMeta: {
                sessionId,
                provider: "openai",
                model: "gpt-5.6-luna",
                compactionCount: 99,
                compactionTokensAfter: 80_000,
              },
            },
          },
        });

        for (const entry of [
          sessionStore[sessionKey],
          loadPersistedSessionEntry(storePath, sessionKey),
        ]) {
          expect(entry).toMatchObject({ ...billing, totalTokens: tokens, totalTokensFresh: true });
          expect(resolveFreshSessionTotalTokens(entry)).toBe(tokens);
          expect(entry?.compactionCount).toBeUndefined();
        }
      });
    },
  );

  it.each([
    {
      runtime: "CLI",
      sessionKey: "agent:main:explicit:test-zero-compaction-with-usage",
      sessionId: "test-zero-compaction-with-usage-session",
      provider: "claude-cli",
      model: "claude-opus-4-7",
      initial: {
        totalTokens: 1_794_391,
        inputTokens: 20,
        outputTokens: 10_855,
        cacheRead: 1_761_324,
        cacheWrite: 33_047,
      },
      usage: { input: 20, output: 10_855, cacheRead: 1_761_324, cacheWrite: 33_047 },
      lastCallUsage: { input: 20, output: 10_855, cacheRead: 1_761_324, cacheWrite: 33_047 },
      compactionTokensAfter: 0,
      expected: {
        totalTokens: 1_794_391,
        inputTokens: 20,
        outputTokens: 10_855,
        cacheRead: 1_761_324,
        cacheWrite: 33_047,
      },
    },
    {
      runtime: "model",
      sessionKey: "agent:main:explicit:test-positive-compaction-with-usage",
      sessionId: "test-positive-compaction-with-usage-session",
      provider: "openai",
      model: "gpt-5.5",
      initial: { totalTokens: 180_000 },
      usage: { input: 100_000, output: 3_000, cacheRead: 20_000 },
      lastCallUsage: { input: 91_000, output: 1_000, cacheRead: 4_000 },
      compactionTokensAfter: 80_000,
      expected: {
        totalTokens: 95_000,
        inputTokens: 100_000,
        outputTokens: 3_000,
        cacheRead: 20_000,
      },
    },
  ])(
    "keeps ordinary $runtime context independent of historical compaction metadata",
    async (testCase) => {
      await withTempSessionStore(async ({ storePath }) => {
        const cfg = {} as OpenClawConfig;
        const { sessionKey, sessionId, provider, model } = testCase;
        const sessionStore: Record<string, SessionEntry> = {
          [sessionKey]: {
            sessionId,
            updatedAt: 1,
            ...testCase.initial,
            totalTokensFresh: true,
          },
        };
        await seedSessionStore(storePath, sessionStore);

        await updateSessionStoreAfterAgentRun({
          cfg,
          sessionId,
          sessionKey,
          storePath,
          sessionStore,
          defaultProvider: provider,
          defaultModel: model,
          result: {
            meta: {
              durationMs: 500,
              agentMeta: {
                sessionId,
                provider,
                model,
                usage: testCase.usage,
                lastCallUsage: testCase.lastCallUsage,
                compactionCount: 1,
                compactionTokensAfter: testCase.compactionTokensAfter,
              },
            },
          } as EmbeddedAgentRunResult,
        });

        expect(sessionStore[sessionKey]).toMatchObject({
          ...testCase.expected,
          totalTokensFresh: true,
        });
      });
    },
  );

  it.each([0, 80_000, Number.POSITIVE_INFINITY])(
    "does not revive historical compaction snapshot %s without a private fact",
    async (compactionTokensAfter) => {
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
        await seedSessionStore(storePath, sessionStore);

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
                compactionTokensAfter,
              },
            },
          },
        });

        expect(sessionStore[sessionKey]?.totalTokens).toBe(12_000);
        expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(false);
      });
    },
  );

  it.each([
    {
      name: "estimated token usage",
      usage: { input: 10_000, output: 5_000 },
      total: 0.25,
      hasTokens: true,
    },
    {
      name: "cost-only positive total",
      usage: { cost: { total: 0.75 } },
      total: 0.75,
      hasTokens: false,
    },
    { name: "cost-only zero total", usage: { cost: { total: 0 } }, total: 0, hasTokens: false },
  ])("snapshots $name instead of accumulating", async ({ usage, total, hasTokens }) => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg: OpenClawConfig = {
        models: {
          providers: {
            fixture: {
              baseUrl: "https://fixture.invalid",
              models: [
                {
                  id: "priced",
                  name: "Priced",
                  reasoning: false,
                  input: ["text"],
                  contextWindow: 128_000,
                  maxTokens: 8_192,
                  cost: { input: 10, output: 30, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
      };
      const sessionKey = "agent:main:explicit:test-cost-snapshot";
      const sessionId = "test-cost-snapshot-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: { sessionId, updatedAt: 1, estimatedCostUsd: 1.25 },
      };
      await seedSessionStore(storePath, sessionStore);
      const result: EmbeddedAgentRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: { sessionId, provider: "fixture", model: "priced", usage },
        },
      };

      // Repeated finalization replaces the prior run's dollars rather than adding them again.
      for (let persist = 0; persist < 2; persist += 1) {
        await updateSessionStoreAfterAgentRun({
          cfg,
          sessionId,
          sessionKey,
          storePath,
          sessionStore,
          defaultProvider: "fixture",
          defaultModel: "priced",
          result,
        });
        for (const entry of [
          sessionStore[sessionKey],
          loadPersistedSessionEntry(storePath, sessionKey),
        ]) {
          expect(entry?.estimatedCostUsd).toBeCloseTo(total, 4);
          if (!hasTokens) {
            for (const key of [
              "inputTokens",
              "outputTokens",
              "cacheRead",
              "cacheWrite",
              "totalTokens",
            ] as const) {
              expect(entry?.[key]).toBeUndefined();
            }
            expect(entry?.totalTokensFresh).not.toBe(true);
          }
        }
      }
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
      await seedSessionStore(storePath, sessionStore);

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
      expect(sessionStore[sessionKey]?.lastActivityAt).toEqual(expect.any(Number));
      expect(sessionStore[sessionKey]?.lastActivityAt).toBeGreaterThan(lastInteractionAt);
      expect(sessionStore[sessionKey]?.sessionStartedAt).toBe(sessionStartedAt);
      expect(sessionStore[sessionKey]?.updatedAt).toBeGreaterThan(lastInteractionAt);
    });
  });

  it("preserves lastActivityAt for heartbeat-style runs", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-heartbeat-run";
      const sessionId = "test-heartbeat-run-session";
      const lastActivityAt = Date.now() - 60 * 60_000;
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: Date.now() - 10_000,
          lastActivityAt,
        },
      };
      await replaceSessionEntry({ storePath, sessionKey }, sessionStore[sessionKey]!);

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
        touchActivity: false,
      });

      expect(sessionStore[sessionKey]?.lastActivityAt).toBe(lastActivityAt);
      expect(sessionStore[sessionKey]?.updatedAt).toBeGreaterThan(lastActivityAt);
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
      await seedSessionStore(storePath, sessionStore);

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

  it("clears main recovery markers after settled background progress", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:test-clear-recovery-state";
      const sessionId = "test-clear-recovery-state-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          abortedLastRun: true,
          restartRecoveryRuns: [
            { runId: "initial-wedged-run", lifecycleGeneration: "gen-1" },
            { runId: "recovery-run-1", lifecycleGeneration: "gen-2" },
            { runId: "recovery-run-2", lifecycleGeneration: "gen-3" },
            { runId: "recovery-run-3", lifecycleGeneration: "gen-4" },
          ],
          mainRestartRecovery: {
            cycleId: "cycle-1",
            revision: 3,
            chargedAttempts: 2,
          },
          subagentRecovery: {
            automaticAttempts: 2,
            lastAttemptAt: 3,
            wedgedAt: 4,
            wedgedReason: "automatic_attempt_budget_exceeded",
          },
        },
      };
      await seedSessionStore(storePath, sessionStore);

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        touchInteraction: false,
        touchActivity: false,
        preserveRuntimeModel: true,
        result: {
          meta: {
            durationMs: 1,
            aborted: false,
            agentMeta: {
              sessionId,
              provider: "openai",
              model: "gpt-5.5",
            },
          },
        } as EmbeddedAgentRunResult,
      });

      expect(sessionStore[sessionKey]?.abortedLastRun).toBe(false);
      expect(sessionStore[sessionKey]?.restartRecoveryRuns).toBeUndefined();
      expect(sessionStore[sessionKey]?.mainRestartRecovery).toBeUndefined();
      expect(sessionStore[sessionKey]?.subagentRecovery).toEqual({
        automaticAttempts: 2,
        lastAttemptAt: 3,
        wedgedAt: 4,
        wedgedReason: "automatic_attempt_budget_exceeded",
      });
      const persisted = loadPersistedSessionEntry(storePath, sessionKey);
      expect(persisted?.abortedLastRun).toBe(false);
      expect(persisted?.restartRecoveryRuns).toBeUndefined();
      expect(persisted).not.toHaveProperty("mainRestartRecovery");
      expect(persisted?.subagentRecovery).toEqual({
        automaticAttempts: 2,
        lastAttemptAt: 3,
        wedgedAt: 4,
        wedgedReason: "automatic_attempt_budget_exceeded",
      });
    });
  });

  it("preserves a replacement recovery cycle from an older healthy finalizer", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:test-recovery-finalizer-aba";
      const sessionId = "test-recovery-finalizer-aba-session";
      const staleEntry: SessionEntry = {
        sessionId,
        updatedAt: 1,
        status: "running",
        abortedLastRun: true,
        mainRestartRecovery: {
          cycleId: "cycle-old",
          revision: 2,
          chargedAttempts: 1,
        },
      };
      const sessionStore = { [sessionKey]: staleEntry };
      const replacementEntry: SessionEntry = {
        ...staleEntry,
        updatedAt: 2,
        restartRecoveryRuns: [{ runId: "replacement-run", lifecycleGeneration: "gen-new" }],
        mainRestartRecovery: {
          cycleId: "cycle-new",
          revision: 1,
          chargedAttempts: 0,
        },
      };
      await seedSessionStore(storePath, { [sessionKey]: replacementEntry });

      await updateSessionStoreAfterAgentRun({
        cfg: {} as OpenClawConfig,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        result: {
          meta: {
            durationMs: 1,
            aborted: false,
            agentMeta: { sessionId, provider: "openai", model: "gpt-5.5" },
          },
        } as EmbeddedAgentRunResult,
      });

      const persisted = loadPersistedSessionEntry(storePath, sessionKey);
      expect(persisted).toMatchObject({
        abortedLastRun: true,
        restartRecoveryRuns: [{ runId: "replacement-run", lifecycleGeneration: "gen-new" }],
        mainRestartRecovery: {
          cycleId: "cycle-new",
          revision: 1,
          chargedAttempts: 0,
        },
      });
      expect(sessionStore[sessionKey]).toEqual(persisted);
    });
  });

  it("preserves a concurrent restart marker when a stale run settles healthy", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:test-restart-finalizer-race";
      const sessionId = "test-restart-finalizer-race-session";
      const initialEntry: SessionEntry = {
        sessionId,
        updatedAt: 1,
        status: "running",
        abortedLastRun: true,
        restartRecoveryRuns: [{ runId: "run-1", lifecycleGeneration: "generation-1" }],
        mainRestartRecovery: {
          cycleId: "cycle-1",
          revision: 2,
          chargedAttempts: 0,
          foregroundClaims: {
            lifecycleGeneration: "generation-1",
            tokens: ["owner-1"],
          },
        },
      };
      const sessionStore = { [sessionKey]: initialEntry };
      const concurrentEntry: SessionEntry = {
        ...structuredClone(initialEntry),
        updatedAt: 2,
        restartRecoveryRuns: [
          ...(initialEntry.restartRecoveryRuns ?? []),
          { runId: "run-1", lifecycleGeneration: "generation-2" },
        ],
        mainRestartRecovery: {
          ...initialEntry.mainRestartRecovery!,
          revision: 3,
        },
      };
      await seedSessionStore(storePath, { [sessionKey]: concurrentEntry });

      await updateSessionStoreAfterAgentRun({
        cfg: {} as OpenClawConfig,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "openai",
        defaultModel: "gpt-5.5",
        result: {
          meta: {
            durationMs: 1,
            aborted: false,
            agentMeta: { sessionId, provider: "openai", model: "gpt-5.5" },
          },
        } as EmbeddedAgentRunResult,
      });

      for (const entry of [
        sessionStore[sessionKey],
        loadPersistedSessionEntry(storePath, sessionKey),
      ]) {
        expect(entry?.abortedLastRun).toBe(true);
        expect(entry?.restartRecoveryRuns).toEqual(concurrentEntry.restartRecoveryRuns);
        expect(entry?.mainRestartRecovery).toEqual(concurrentEntry.mainRestartRecovery);
      }
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
          agentHarnessId: "openclaw",
          contextTokens: 1_000_000,
          cliSessionBindings: {
            "claude-cli": { sessionId: "existing-cli-session" },
          },
          cliSessionIds: {
            "claude-cli": "existing-cli-session",
          },
          claudeCliSessionId: "existing-cli-session",
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
      await seedSessionStore(storePath, sessionStore);

      // Heartbeat turn uses a different model
      const result: EmbeddedAgentRunResult = {
        meta: {
          durationMs: 500,
          agentMeta: {
            sessionId,
            provider: "claude-cli",
            model: "claude-sonnet-4-6",
            agentHarnessId: "codex",
            contextTokens: 128_000,
            cliSessionBinding: { sessionId: "heartbeat-cli-session" },
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
      expect(sessionStore[sessionKey]?.agentHarnessId).toBe("openclaw");
      expect(sessionStore[sessionKey]?.contextTokens).toBe(1_000_000);
      expect(sessionStore[sessionKey]?.contextBudgetStatus?.provider).toBe("anthropic");
      expect(sessionStore[sessionKey]?.contextBudgetStatus?.estimatedPromptTokens).toBe(640_000);
      expect(sessionStore[sessionKey]?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "existing-cli-session",
      });

      const persisted = loadPersistedSessionStore(storePath);
      expect(persisted[sessionKey]?.model).toBe("claude-opus-4-6");
      expect(persisted[sessionKey]?.modelProvider).toBe("anthropic");
      expect(persisted[sessionKey]?.agentHarnessId).toBe("openclaw");
      expect(persisted[sessionKey]?.contextTokens).toBe(1_000_000);
      expect(persisted[sessionKey]?.contextBudgetStatus?.provider).toBe("anthropic");
      expect(persisted[sessionKey]?.contextBudgetStatus?.estimatedPromptTokens).toBe(640_000);
      expect(persisted[sessionKey]?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "existing-cli-session",
      });
    });
  });

  it("preserves user-facing run accounting while allowing session touch metadata", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {
        agents: {
          defaults: {},
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
      await seedSessionStore(storePath, sessionStore);
      const freshVisibleEntry: SessionEntry = {
        sessionId: "fresh-visible-session-id",
        updatedAt: 2,
        sessionStartedAt: 777,
        lastInteractionAt: 20,
        lastActivityAt: 21,
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
      await seedSessionStore(storePath, { [sessionKey]: freshVisibleEntry });

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
      // Preserved-state runs must not re-flag the session unread.
      expect(next?.lastActivityAt).toBe(21);
    });
  });

  it("does not recreate a missing persisted row while preserving user-facing state", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:missing-visible-row";
      const sessionId = "missing-visible-row-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          modelProvider: "openai",
          model: "gpt-5.5",
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
        preserveUserFacingSessionModelState: true,
        result: {
          meta: {
            durationMs: 1,
            agentMeta: {
              sessionId,
              provider: "claude-cli",
              model: "claude-sonnet-4-6",
            },
          },
        },
      });

      expect(sessionStore[sessionKey]).toEqual({
        sessionId,
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5.5",
      });
      expect(loadPersistedSessionEntry(storePath, sessionKey)).toBeUndefined();
    });
  });

  it("creates a missing persisted row for a new normal run", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:new-normal-row";
      const sessionId = "new-normal-row-session";
      const sessionStore: Record<string, SessionEntry> = {};

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
            durationMs: 1,
            agentMeta: {
              sessionId,
              provider: "openai",
              model: "gpt-5.5",
            },
          },
        },
      });

      expect(sessionStore[sessionKey]).toMatchObject({ sessionId });
      expect(loadPersistedSessionEntry(storePath, sessionKey)).toMatchObject({
        sessionId,
      });
    });
  });

  it("does not recreate a missing persisted row after a normal run with a preloaded entry", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:deleted-normal-row";
      const sessionId = "deleted-normal-row-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          modelProvider: "openai",
          model: "gpt-5.5",
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
        result: {
          meta: {
            durationMs: 1,
            agentMeta: {
              sessionId,
              provider: "openai",
              model: "gpt-5.5",
              usage: { input: 100, output: 20 },
            },
          },
        },
      });

      expect(sessionStore[sessionKey]).toEqual({
        sessionId,
        updatedAt: 1,
        modelProvider: "openai",
        model: "gpt-5.5",
      });
      expect(loadPersistedSessionEntry(storePath, sessionKey)).toBeUndefined();
    });
  });

  it("does not overwrite a replacement persisted row after a normal run", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const cfg = {} as OpenClawConfig;
      const sessionKey = "agent:main:explicit:rebound-visible-row";
      const sessionId = "run-session-id";
      const replacementEntry: SessionEntry = {
        sessionId: "replacement-session-id",
        updatedAt: 2,
        delivery: { kind: "none" },
        modelProvider: "openai",
        model: "gpt-5.5",
      };
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          modelProvider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      };
      await seedSessionStore(storePath, { [sessionKey]: replacementEntry });

      await updateSessionStoreAfterAgentRun({
        cfg,
        sessionId,
        sessionKey,
        storePath,
        sessionStore,
        defaultProvider: "anthropic",
        defaultModel: "claude-sonnet-4-6",
        result: {
          meta: {
            durationMs: 1,
            agentMeta: {
              sessionId,
              provider: "anthropic",
              model: "claude-sonnet-4-6",
            },
          },
        },
      });

      expect(loadPersistedSessionEntry(storePath, sessionKey)).toEqual(replacementEntry);
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
      await seedSessionStore(storePath, sessionStore);

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
      await seedSessionStore(storePath, sessionStore);

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
      await seedSessionStore(storePath, sessionStore);

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

      const persisted = loadPersistedSessionStore(storePath);
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
      await seedSessionStore(storePath, sessionStore);

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
  it("persists native compaction token counts without clearing its CLI binding", async () => {
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
      await seedSessionStore(storePath, sessionStore);

      await recordCliCompactionInStore({
        expectedSession: { sessionId, lifecycleRevision: undefined, activeWriterRunId: undefined },
        compactionKind: "native-harness",
        sessionKey,
        sessionStore,
        storePath,
        tokensAfter: 3_210,
      });

      const persisted = loadPersistedSessionStore(storePath);
      expect(sessionStore[sessionKey]?.compactionCount).toBe(1);
      expect(sessionStore[sessionKey]?.totalTokens).toBe(3_210);
      expect(sessionStore[sessionKey]?.totalTokensFresh).toBe(true);
      expect(resolveFreshSessionTotalTokens(sessionStore[sessionKey])).toBe(3_210);
      expect(sessionStore[sessionKey]?.inputTokens).toBeUndefined();
      expect(sessionStore[sessionKey]?.outputTokens).toBeUndefined();
      expect(sessionStore[sessionKey]?.cacheRead).toBeUndefined();
      expect(sessionStore[sessionKey]?.cacheWrite).toBeUndefined();
      expect(sessionStore[sessionKey]?.contextBudgetStatus).toBeUndefined();
      expect(sessionStore[sessionKey]?.cliSessionBindings?.codex).toEqual({
        sessionId: "stale-cli-session",
      });
      expect(sessionStore[sessionKey]?.cliSessionIds?.codex).toBe("stale-cli-session");
      expect(persisted[sessionKey]?.totalTokens).toBe(3_210);
      expect(persisted[sessionKey]?.totalTokensFresh).toBe(true);
      expect(resolveFreshSessionTotalTokens(persisted[sessionKey])).toBe(3_210);
      expect(persisted[sessionKey]?.contextBudgetStatus).toBeUndefined();
      expect(persisted[sessionKey]?.cliSessionBindings?.codex).toEqual({
        sessionId: "stale-cli-session",
      });
      expect(persisted[sessionKey]?.cliSessionIds?.codex).toBe("stale-cli-session");
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
      await seedSessionStore(storePath, sessionStore);

      await recordCliCompactionInStore({
        expectedSession: { sessionId, lifecycleRevision: undefined, activeWriterRunId: undefined },
        compactionKind: "native-harness",
        sessionKey,
        sessionStore,
        storePath,
      });

      const persisted = loadPersistedSessionStore(storePath);
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

  it("records compaction on the existing row and clears its context-engine CLI binding", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:test-record-cli-compaction-missing-row";
      const sessionId = "test-record-cli-compaction-missing-row-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          modelProvider: "openai",
          model: "gpt-5.5",
          totalTokens: 12_000,
          totalTokensFresh: true,
          inputTokens: 9_000,
          outputTokens: 100,
          cacheRead: 2_900,
          cacheWrite: 0,
          cliSessionBindings: {
            codex: {
              sessionId: "stale-cli-session",
            },
            "claude-cli": {
              sessionId: "stale-claude-session",
            },
          },
          cliSessionIds: {
            codex: "stale-cli-session",
            "claude-cli": "stale-claude-session",
          },
          claudeCliSessionId: "stale-claude-session",
        },
      };

      await seedSessionStore(storePath, sessionStore);

      await recordCliCompactionInStore({
        expectedSession: { sessionId, lifecycleRevision: undefined, activeWriterRunId: undefined },
        compactionKind: "context-engine",
        sessionKey,
        sessionStore,
        storePath,
        tokensAfter: 42,
      });

      const persisted = loadPersistedSessionEntry(storePath, sessionKey);
      expect(sessionStore[sessionKey]?.sessionId).toBe(sessionId);
      expect(sessionStore[sessionKey]?.modelProvider).toBe("openai");
      expect(sessionStore[sessionKey]?.model).toBe("gpt-5.5");
      expect(sessionStore[sessionKey]?.compactionCount).toBe(1);
      expect(sessionStore[sessionKey]?.totalTokens).toBe(42);
      expect(sessionStore[sessionKey]?.cliSessionBindings?.codex).toBeUndefined();
      expect(sessionStore[sessionKey]?.cliSessionBindings).toBeUndefined();
      expect(sessionStore[sessionKey]?.cliSessionIds).toBeUndefined();
      expect(sessionStore[sessionKey]?.claudeCliSessionId).toBeUndefined();
      expect(persisted?.sessionId).toBe(sessionId);
      expect(persisted?.modelProvider).toBe("openai");
      expect(persisted?.model).toBe("gpt-5.5");
      expect(persisted?.compactionCount).toBe(1);
      expect(persisted?.totalTokens).toBe(42);
      expect(persisted?.cliSessionBindings?.codex).toBeUndefined();
      expect(persisted?.cliSessionIds?.codex).toBeUndefined();
    });
  });

  it("does not recreate a missing row when a post-run compaction has an expected session id", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:test-record-cli-compaction-deleted";
      const sessionId = "test-record-cli-compaction-deleted-session";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          cliSessionIds: {
            codex: "stale-cli-session",
          },
        },
      };

      const result = await recordCliCompactionInStore({
        expectedSession: { sessionId, lifecycleRevision: undefined, activeWriterRunId: undefined },
        compactionKind: "context-engine",
        sessionKey,
        sessionStore,
        storePath,
        tokensAfter: 42,
      });

      expect(result).toBeUndefined();
      expect(loadPersistedSessionEntry(storePath, sessionKey)).toBeUndefined();
    });
  });
  it.each([{ lifecycleRevision: "replacement" }, { activeWriterRunId: "replacement" }])(
    "does not account against a changed CLI owner: %j",
    async (replacement) => {
      await withTempSessionStore(async ({ storePath }) => {
        const sessionKey = "agent:main:cli-fenced-count";
        const entry = {
          sessionId: "same-session",
          updatedAt: 1,
          lifecycleRevision: "lifecycle",
          activeWriterRunId: "writer",
          compactionCount: 3,
        };
        const sessionStore = { [sessionKey]: entry };
        const changed = { ...entry, ...replacement };
        await seedSessionStore(storePath, { [sessionKey]: changed });

        const result = await recordCliCompactionInStore({
          compactionKind: "context-engine",
          sessionKey,
          storePath,
          sessionStore,
          expectedSession: entry,
          tokensAfter: 42,
        });

        expect(result).toBeUndefined();
        expect(loadPersistedSessionEntry(storePath, sessionKey)).toMatchObject(changed);
      });
    },
  );
});

describe("consumeCliSessionForkInStore", () => {
  it("clears the one-shot marker while preserving the bound source id", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:catalog-adopt:claude:test";
      const entry: SessionEntry = {
        sessionId: "openclaw-session-1",
        updatedAt: 1,
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "claude-source-session",
            resumeCheckpointId: "assistant-before-turn",
            forceReuse: true,
            forkNextResume: true,
          },
        },
      };
      const sessionStore = { [sessionKey]: entry };
      await seedSessionStore(storePath, sessionStore);
      await replaceSessionEntry(
        { storePath, sessionKey },
        { ...entry, label: "concurrent update" },
      );
      const consumed = await consumeCliSessionForkInStore({
        provider: "claude-cli",
        sessionKey,
        sessionStore,
        storePath,
        expectedCliSessionId: "claude-source-session",
      });
      expect(consumed?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "claude-source-session",
        resumeCheckpointId: "assistant-before-turn",
        forceReuse: true,
      });
      expect(consumed?.label).toBe("concurrent update");
      expect(
        loadPersistedSessionEntry(storePath, sessionKey)?.cliSessionBindings?.["claude-cli"],
      ).toEqual({
        sessionId: "claude-source-session",
        resumeCheckpointId: "assistant-before-turn",
        forceReuse: true,
      });
      await expect(
        consumeCliSessionForkInStore({
          provider: "claude-cli",
          sessionKey,
          sessionStore,
          storePath,
          expectedCliSessionId: "claude-source-session",
        }),
      ).resolves.toBeUndefined();
    });
  });

  it("re-arms a claimed marker after a failed turn", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:plugin:anthropic:catalog-adopt:claude:test";
      const entry: SessionEntry = {
        sessionId: "openclaw-session-1",
        updatedAt: 1,
        cliSessionBindings: {
          "claude-cli": { sessionId: "claude-source-session", forceReuse: true },
        },
      };
      const sessionStore = { [sessionKey]: entry };
      await seedSessionStore(storePath, sessionStore);

      const restored = await restoreCliSessionForkInStore({
        provider: "claude-cli",
        sessionKey,
        sessionStore,
        storePath,
        expectedCliSessionId: "claude-source-session",
      });

      expect(restored?.cliSessionBindings?.["claude-cli"]?.forkNextResume).toBe(true);
      expect(
        loadPersistedSessionEntry(storePath, sessionKey)?.cliSessionBindings?.["claude-cli"]
          ?.forkNextResume,
      ).toBe(true);
    });
  });

  it("persists the fork successor before turn finalization", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:plugin:anthropic:catalog-adopt:claude:test";
      const entry: SessionEntry = {
        sessionId: "openclaw-session-1",
        updatedAt: 1,
        cliSessionBindings: {
          "claude-cli": {
            sessionId: "claude-source-session",
            resumeCheckpointId: "assistant-before-turn",
            forceReuse: true,
            authProfileId: "claude:work",
            authEpoch: "epoch-1",
            authEpochVersion: 3,
          },
        },
      };
      const sessionStore = { [sessionKey]: entry };
      await seedSessionStore(storePath, sessionStore);

      const persisted = await persistCliSessionForkSuccessorInStore({
        provider: "claude-cli",
        sessionKey,
        sessionStore,
        storePath,
        expectedCliSessionId: "claude-source-session",
        successorCliSessionId: "claude-fork-session",
      });

      expect(persisted?.cliSessionBindings?.["claude-cli"]).toEqual({
        sessionId: "claude-fork-session",
        resumeCheckpointId: "assistant-before-turn",
        forceReuse: true,
        authProfileId: "claude:work",
        authEpoch: "epoch-1",
        authEpochVersion: 3,
      });
      expect(
        loadPersistedSessionEntry(storePath, sessionKey)?.cliSessionBindings?.["claude-cli"],
      ).toEqual({
        sessionId: "claude-fork-session",
        resumeCheckpointId: "assistant-before-turn",
        forceReuse: true,
        authProfileId: "claude:work",
        authEpoch: "epoch-1",
        authEpochVersion: 3,
      });
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
      await seedSessionStore(storePath, sessionStore);

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

      const persisted = loadPersistedSessionEntry(storePath, sessionKey);
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
      await seedSessionStore(storePath, sessionStore);

      const cleared = await clearCliSessionInStore({
        provider: "claude-cli",
        sessionKey: "agent:main:explicit:missing",
        sessionStore,
        storePath,
      });

      expect(cleared).toBeUndefined();
      expect(sessionStore[existingKey]?.claudeCliSessionId).toBe("claude-session-1");
      expect(loadPersistedSessionEntry(storePath, existingKey)?.claudeCliSessionId).toBe(
        "claude-session-1",
      );
    });
  });

  it("clears the caller snapshot and recreates a complete persisted row when the store row is missing", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:test-clear-cli-missing-row";
      const entry: SessionEntry = {
        sessionId: "openclaw-session-1",
        updatedAt: 1,
        modelProvider: "anthropic",
        model: "claude-opus-4-6",
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

      const cleared = await clearCliSessionInStore({
        provider: "claude-cli",
        sessionKey,
        sessionStore,
        storePath,
      });

      const persisted = loadPersistedSessionEntry(storePath, sessionKey);
      expect(cleared?.sessionId).toBe("openclaw-session-1");
      expect(cleared?.modelProvider).toBe("anthropic");
      expect(cleared?.model).toBe("claude-opus-4-6");
      expect(cleared?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
      expect(cleared?.cliSessionBindings?.["codex-cli"]).toEqual({
        sessionId: "codex-session-1",
      });
      expect(cleared?.claudeCliSessionId).toBeUndefined();
      expect(sessionStore[sessionKey]).toEqual(cleared);
      expect(persisted?.sessionId).toBe("openclaw-session-1");
      expect(persisted?.modelProvider).toBe("anthropic");
      expect(persisted?.model).toBe("claude-opus-4-6");
      expect(persisted?.cliSessionBindings?.["claude-cli"]).toBeUndefined();
      expect(persisted?.cliSessionBindings?.["codex-cli"]).toEqual({
        sessionId: "codex-session-1",
      });
      expect(persisted?.claudeCliSessionId).toBeUndefined();
    });
  });

  it("does not recreate a missing row when a post-run binding clear has an expected session id", async () => {
    await withTempSessionStore(async ({ storePath }) => {
      const sessionKey = "agent:main:explicit:test-clear-cli-deleted-row";
      const sessionId = "openclaw-session-1";
      const sessionStore: Record<string, SessionEntry> = {
        [sessionKey]: {
          sessionId,
          updatedAt: 1,
          claudeCliSessionId: "claude-session-1",
        },
      };

      await clearCliSessionInStore({
        provider: "claude-cli",
        sessionKey,
        sessionStore,
        storePath,
        expectedSessionId: sessionId,
      });

      expect(loadPersistedSessionEntry(storePath, sessionKey)).toBeUndefined();
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
