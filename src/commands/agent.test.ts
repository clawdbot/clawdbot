// Agent command tests cover local agent runs, session routing, and command runtime behavior.
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { buildChannelOutboundSessionRoute } from "openclaw/plugin-sdk/core";
import { withTempHome as withTempHomeBase } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
// Register shared mocks before imports bind their production exports.
import "./agent-command.test-mocks.js";
import { testing as acpManagerTesting } from "../acp/control-plane/manager.js";
import * as authProfileStoreModule from "../agents/auth-profiles/store.js";
import * as attemptExecutionRuntime from "../agents/command/attempt-execution.runtime.js";
import { deliverAgentCommandResult } from "../agents/command/delivery.runtime.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { loadManifestModelCatalog, loadModelCatalog } from "../agents/model-catalog.js";
import * as modelSelectionModule from "../agents/model-selection.js";
import { isAgentRunRestartAbortReason } from "../agents/run-termination.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { BASE_THINKING_LEVELS } from "../auto-reply/thinking.shared.js";
import * as runtimeSnapshotModule from "../config/runtime-snapshot.js";
import {
  listSessionEntries,
  loadSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/sqlite-marker.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitAgentEvent, onAgentEvent, resetAgentEventsForTest } from "../infra/agent-events.js";
import type { PluginProviderRegistration } from "../plugins/registry.test-fixtures.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import { AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE } from "../sessions/agent-harness-session-key.js";
import { MODEL_SELECTION_LOCKED_MESSAGE } from "../sessions/model-overrides.js";
import { interruptSessionWorkAdmissions } from "../sessions/session-lifecycle-admission.js";
import {
  createDirectOutboundTestAdapter,
  createOutboundTestPlugin,
  createTestRegistry,
} from "../test-utils/channel-plugins.js";
import { getAgentHarnessPluginMocks } from "./agent-command-state.test-mocks.js";
import { agentCommand, agentCommandFromIngress, testing as agentCommandTesting } from "./agent.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

const configIoMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));
const agentHarnessPluginMocks = getAgentHarnessPluginMocks();

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: configIoMocks.loadConfig,
  loadConfig: configIoMocks.loadConfig,
  readConfigFileSnapshotForWrite: configIoMocks.readConfigFileSnapshotForWrite,
}));

vi.mock("../agents/auth-profiles/store.js", () => {
  const createEmptyStore = () => ({ version: 1, profiles: {} });
  return {
    clearRuntimeAuthProfileStoreSnapshots: vi.fn(),
    ensureAuthProfileStore: vi.fn(createEmptyStore),
    ensureAuthProfileStoreForLocalUpdate: vi.fn(createEmptyStore),
    hasAnyAuthProfileStoreSource: vi.fn(() => false),
    loadAuthProfileStore: vi.fn(createEmptyStore),
    loadAuthProfileStoreForRuntime: vi.fn(createEmptyStore),
    loadAuthProfileStoreForSecretsRuntime: vi.fn(createEmptyStore),
    loadAuthProfileStoreWithoutExternalProfiles: vi.fn(createEmptyStore),
    replaceRuntimeAuthProfileStoreSnapshots: vi.fn(),
    saveAuthProfileStore: vi.fn(),
    updateAuthProfileStoreWithLock: vi.fn(async () => createEmptyStore()),
  };
});

vi.mock("../agents/auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSource: vi.fn(() => false),
}));

vi.mock("../agents/command/session-store.runtime.js", async () => {
  const accessor = await import("../config/sessions/session-accessor.js");
  return {
    loadSessionEntry: accessor.loadSessionEntry,
    updateSessionStoreAfterAgentRun: vi.fn(async () => undefined),
  };
});

vi.mock("../agents/command/cli-compaction.js", () => {
  return {
    runCliTurnCompactionLifecycle: vi.fn(
      async (params: { sessionEntry?: unknown }) => params.sessionEntry,
    ),
  };
});

vi.mock("../agents/command/attempt-execution.runtime.js", () => {
  return {
    buildAcpResult: vi.fn(),
    createAcpToolLifecycleTracker: () => ({
      active: new Map(),
      terminalToolCallIds: new Set(),
      saturated: false,
    }),
    createAcpVisibleTextAccumulator: vi.fn(),
    emitAcpAssistantDelta: vi.fn(),
    emitAcpLifecycleEnd: vi.fn(),
    emitAcpLifecycleError: vi.fn(),
    emitAcpLifecycleStart: vi.fn(),
    persistAcpTurnTranscript: vi.fn(async (params: { sessionEntry?: unknown }) => ({
      kind: "persisted",
      sessionEntry: params.sessionEntry,
    })),
    persistCliTurnTranscript: vi.fn(async (params: { sessionEntry?: unknown }) => ({
      kind: "persisted",
      sessionEntry: params.sessionEntry,
    })),
    runAgentAttempt: vi.fn(async (params: Record<string, unknown>) => {
      const opts = params.opts as Record<string, unknown>;
      const runContext = params.runContext as Record<string, unknown>;
      const sessionEntry = params.sessionEntry as
        | {
            authProfileOverride?: string;
            authProfileOverrideSource?: string;
          }
        | undefined;
      const providerOverride = params.providerOverride as string;
      const authProfileProvider = params.authProfileProvider as string;
      const authProfileId =
        providerOverride === authProfileProvider ? sessionEntry?.authProfileOverride : undefined;

      return await runEmbeddedAgent({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.sessionAgentId,
        trigger: "user",
        messageChannel: params.messageChannel,
        agentAccountId: runContext.accountId,
        messageTo: opts.replyTo ?? opts.to,
        messageThreadId: opts.threadId,
        sessionFile: params.sessionFile,
        workspaceDir: params.workspaceDir,
        config: params.cfg,
        skillsSnapshot: params.skillsSnapshot,
        prompt: params.body,
        images: opts.images,
        imageOrder: opts.imageOrder,
        clientTools: opts.clientTools,
        provider: providerOverride,
        model: params.modelOverride,
        authProfileId,
        authProfileIdSource: authProfileId ? sessionEntry?.authProfileOverrideSource : undefined,
        thinkLevel: params.resolvedThinkLevel,
        fastMode: params.fastMode,
        verboseLevel: params.resolvedVerboseLevel,
        timeoutMs: params.timeoutMs,
        runId: params.runId,
        lane: opts.lane,
        abortSignal: opts.abortSignal,
        extraSystemPrompt: opts.extraSystemPrompt,
        bootstrapContextMode: opts.bootstrapContextMode,
        bootstrapContextRunKind: opts.bootstrapContextRunKind,
        internalEvents: opts.internalEvents,
        inputProvenance: opts.inputProvenance,
        streamParams: opts.streamParams,
        agentDir: params.agentDir,
        allowTransientCooldownProbe: params.allowTransientCooldownProbe,
        cleanupBundleMcpOnRunEnd: opts.cleanupBundleMcpOnRunEnd,
        cleanupCliLiveSessionOnRunEnd: opts.cleanupCliLiveSessionOnRunEnd,
        modelRun: opts.modelRun,
        promptMode: opts.promptMode,
        disableTools: opts.modelRun === true,
        onAgentEvent: params.onAgentEvent,
      } as never);
    }),
    sessionFileHasContent: vi.fn(async () => false),
  };
});

vi.mock("../agents/command/delivery.runtime.js", () => {
  return {
    deliverAgentCommandResult: vi.fn(
      async (params: {
        cfg: OpenClawConfig;
        deps: {
          sendMessageTelegram?: (
            to: string,
            text: string,
            opts: Record<string, unknown>,
          ) => Promise<unknown>;
        };
        runtime: RuntimeEnv;
        opts: {
          channel?: string;
          deliver?: boolean;
          json?: boolean;
          to?: string;
        };
        result: { meta?: Record<string, unknown> };
        payloads?: Array<{ text?: string; mediaUrl?: string | null }>;
      }) => {
        const payloads = params.payloads ?? [];
        if (params.opts.json) {
          params.runtime.log(JSON.stringify({ payloads, meta: params.result.meta ?? {} }));
          return;
        }
        if (params.opts.deliver && params.opts.channel === "telegram" && params.opts.to) {
          for (const payload of payloads) {
            await params.deps.sendMessageTelegram?.(params.opts.to, payload.text ?? "", {
              ...(payload.mediaUrl ? { mediaUrl: payload.mediaUrl } : {}),
              accountId: undefined,
              verbose: false,
            });
          }
          return;
        }
        for (const payload of payloads) {
          if (payload.text) {
            params.runtime.log(payload.text);
          }
        }
      },
    ),
  };
});

vi.mock("../config/sessions/transcript-resolve.runtime.js", () => {
  return {
    resolveSessionTranscriptFile: vi.fn(
      async (params: {
        sessionId: string;
        sessionKey: string;
        sessionEntry?: { sessionFile?: string; sessionId?: string };
        sessionStore?: Record<string, { sessionFile?: string; sessionId?: string }>;
        storePath?: string;
        agentId: string;
        threadId?: string | number;
      }) => {
        const sessionFile =
          params.sessionEntry?.sessionFile ??
          `sqlite:${params.agentId}:${params.sessionId}:${params.storePath ?? ""}`;
        let sessionEntry = params.sessionEntry;
        if (params.sessionStore && params.sessionKey) {
          const existingEntry = params.sessionStore[params.sessionKey] ?? {};
          sessionEntry = {
            ...existingEntry,
            sessionId: params.sessionId,
            sessionFile,
          };
          params.sessionStore[params.sessionKey] = sessionEntry;
        }
        return { sessionFile, sessionEntry };
      },
    ),
  };
});

const runtime = createThrowingTestRuntime();

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, {
    prefix: "openclaw-agent-",
    skipHomeCleanup: true,
    skipSessionCleanup: true,
  });
}

function mockConfig(
  home: string,
  storePath: string,
  agentOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>>,
  telegramOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>>,
  agentsList?: NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>,
) {
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
        workspace: path.join(home, "openclaw"),
        ...agentOverrides,
      },
      list: agentsList,
    },
    session: { store: storePath, mainKey: "main" },
    channels: {
      telegram: telegramOverrides ? { ...telegramOverrides } : undefined,
    },
  } as OpenClawConfig;
  configIoMocks.loadConfig.mockReturnValue(cfg);
  return cfg;
}

async function writeSessionStoreSeed(
  storePath: string,
  sessions: Record<string, Record<string, unknown>>,
): Promise<void> {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  for (const [sessionKey, entry] of Object.entries(sessions)) {
    const sessionId = typeof entry.sessionId === "string" ? entry.sessionId : sessionKey;
    await replaceSessionEntry({ sessionKey, storePath }, {
      ...entry,
      sessionId,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : Date.now(),
    } as SessionEntry);
  }
}

function createDefaultAgentResult(params?: {
  payloads?: Array<Record<string, unknown>>;
  durationMs?: number;
}) {
  return {
    payloads: params?.payloads ?? [{ text: "ok" }],
    meta: {
      durationMs: params?.durationMs ?? 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  };
}

function getLastEmbeddedCall() {
  const calls = vi.mocked(runEmbeddedAgent).mock.calls;
  return calls[calls.length - 1]?.[0];
}

function expectLastRunProviderModel(provider: string, model: string): void {
  const callArgs = getLastEmbeddedCall();
  expect(callArgs?.provider).toBe(provider);
  expect(callArgs?.model).toBe(model);
}

function readSessionStore<T>(storePath: string): Record<string, T> {
  return Object.fromEntries(
    listSessionEntries({ storePath }).map(({ entry, sessionKey }) => [sessionKey, entry as T]),
  );
}

function expectSqliteSessionFileMarker(params: {
  agentId: string;
  sessionFile: string | undefined;
  sessionId?: string;
  storePath: string;
}): void {
  const marker = parseSqliteSessionFileMarker(params.sessionFile);
  expect(marker?.agentId).toBe(params.agentId);
  if (params.sessionId) {
    expect(marker?.sessionId).toBe(params.sessionId);
  } else {
    expect(marker?.sessionId).toBeTruthy();
  }
  expect(marker?.storePath).toBe(path.resolve(params.storePath));
}

async function runAgentWithSessionKey(sessionKey: string): Promise<void> {
  await agentCommand({ message: "hi", sessionKey }, runtime);
}

function mockModelCatalogOnce(entries: ReturnType<typeof loadManifestModelCatalog>): void {
  vi.mocked(loadManifestModelCatalog).mockReturnValueOnce(entries);
  vi.mocked(loadModelCatalog).mockResolvedValueOnce(entries);
}

function installThinkingTestProviders(channels: Parameters<typeof createTestRegistry>[0] = []) {
  const registry = createTestRegistry(channels);
  registry.providers = ["anthropic", "codex", "ollama", "openai", "openrouter"].map(
    (providerId): PluginProviderRegistration => ({
      pluginId: providerId,
      source: "test",
      provider: {
        id: providerId,
        label: providerId,
        auth: [],
        resolveThinkingProfile: () => ({
          levels: BASE_THINKING_LEVELS.map((id) => ({ id })),
          defaultLevel: "off",
        }),
      },
    }),
  );
  setActivePluginRegistry(registry);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPluginRuntimeStateForTest();
  installThinkingTestProviders();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest();
  acpManagerTesting.resetAcpSessionManagerForTests();
  runtimeSnapshotModule.clearRuntimeConfigSnapshot();
  vi.mocked(runEmbeddedAgent).mockResolvedValue(createDefaultAgentResult());
  vi.mocked(loadManifestModelCatalog).mockReturnValue([]);
  vi.mocked(loadModelCatalog).mockResolvedValue([]);
  vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(() => false);
  configIoMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
    snapshot: { valid: false, resolved: {} as OpenClawConfig },
    writeOptions: {},
  });
});

describe("agentCommand", () => {
  it("passes one-shot OpenAI model overrides to harness plugin preparation", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = mockConfig(home, storePath, { models: undefined });

      await agentCommand(
        {
          message: "hi",
          agentId: "main",
          model: "openai/gpt-5.2",
          allowModelOverride: true,
        },
        runtime,
      );

      expect(agentHarnessPluginMocks.ensureSelectedAgentHarnessPlugin).toHaveBeenCalledOnce();
      expect(agentHarnessPluginMocks.ensureSelectedAgentHarnessPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          config: cfg,
          provider: "openai",
          modelId: "gpt-5.2",
          agentId: "main",
          workspaceDir: path.join(home, "openclaw"),
        }),
      );
      expectLastRunProviderModel("openai", "gpt-5.2");
    });
  });

  it("enforces ingress model override authorization", async () => {
    await expect(
      // Runtime guard for non-TS callers; TS callsites are statically typed.
      agentCommandFromIngress(
        {
          message: "hi",
          to: "+1555",
        } as never,
        runtime,
      ),
    ).rejects.toThrow("allowModelOverride must be explicitly set for ingress agent runs.");
  });

  it("rejects a missing harness-owned session before local CLI dispatch", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await expect(
        agentCommand(
          {
            message: "do not squat",
            sessionKey: "agent:main:harness:codex:supervision:missing-local",
          },
          runtime,
        ),
      ).rejects.toThrow(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);

      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    });
  });

  it("rejects a missing harness-owned session through embedded ingress", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await expect(
        agentCommandFromIngress(
          {
            message: "do not squat",
            sessionKey: "agent:main:harness:codex:supervision:missing-ingress",
            allowModelOverride: false,
          },
          runtime,
        ),
      ).rejects.toThrow(AGENT_HARNESS_SESSION_KEY_RESERVED_MESSAGE);

      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    });
  });

  it("continues an existing locked harness-owned session", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:harness:openclaw:supervision:existing";
      mockConfig(home, store);
      await writeSessionStoreSeed(store, {
        [sessionKey]: {
          sessionId: "existing-harness-session",
          updatedAt: Date.now(),
          agentHarnessId: "openclaw",
          modelSelectionLocked: true,
        },
      });

      await agentCommandFromIngress(
        {
          message: "continue safely",
          sessionKey,
          allowModelOverride: false,
        },
        runtime,
      );

      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(getLastEmbeddedCall()?.sessionId).toBe("existing-harness-session");
    });
  });

  it("reuses a Discord voice session after one stale-session rollover", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:discord:channel:voice-1";
      const staleStartedAt = Date.now() - 2 * 24 * 60 * 60_000;
      mockConfig(home, store);
      await writeSessionStoreSeed(store, {
        [sessionKey]: {
          sessionId: "stale-voice-session",
          updatedAt: staleStartedAt,
          sessionStartedAt: staleStartedAt,
        },
      });

      const runVoiceTurn = async (message: string) =>
        await agentCommandFromIngress(
          {
            message,
            sessionKey,
            agentId: "main",
            messageChannel: "discord",
            messageProvider: "discord-voice",
            allowModelOverride: false,
            deliver: false,
          },
          runtime,
        );

      await runVoiceTurn("remember 42");
      const firstSessionId = getLastEmbeddedCall()?.sessionId;
      expect(firstSessionId).toBeTruthy();
      expect(firstSessionId).not.toBe("stale-voice-session");
      const firstPersisted = readSessionStore<{
        sessionId: string;
        sessionStartedAt?: number;
      }>(store)[sessionKey];
      expect(firstPersisted?.sessionId).toBe(firstSessionId);
      expect(firstPersisted?.sessionStartedAt).toBeGreaterThan(staleStartedAt);

      await runVoiceTurn("what number?");
      expect(getLastEmbeddedCall()?.sessionId).toBe(firstSessionId);

      const persisted = readSessionStore<{ sessionId: string; sessionStartedAt?: number }>(store)[
        sessionKey
      ];
      expect(persisted?.sessionId).toBe(firstSessionId);
      expect(persisted?.sessionStartedAt).toBeGreaterThan(staleStartedAt);
    });
  });

  it("rejects archived sessions selected by session id", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);
      await writeSessionStoreSeed(store, {
        "agent:main:subagent:archived": {
          sessionId: "archived-session-id",
          archivedAt: Date.now(),
          updatedAt: Date.now(),
        },
      });
      vi.mocked(runEmbeddedAgent).mockClear();

      await expect(
        agentCommandFromIngress(
          {
            message: "blocked while archived",
            sessionId: "archived-session-id",
            allowModelOverride: false,
          },
          runtime,
        ),
      ).rejects.toThrow(
        'Session "agent:main:subagent:archived" is archived. Restore it before starting new work.',
      );
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    });
  });

  it("reloads archive state after asynchronous command preparation", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:subagent:archive-race";
      const sessionId = "archive-race-session-id";
      mockConfig(home, store);
      await writeSessionStoreSeed(store, {
        [sessionKey]: { sessionId, updatedAt: Date.now() },
      });
      vi.mocked(ensureAgentWorkspace).mockImplementationOnce(async (params) => {
        await writeSessionStoreSeed(store, {
          [sessionKey]: {
            sessionId,
            archivedAt: Date.now(),
            updatedAt: Date.now(),
          },
        });
        return { dir: params?.dir ?? "/tmp/openclaw-workspace" };
      });

      await expect(
        agentCommandFromIngress(
          {
            message: "blocked after preparation",
            sessionId,
            allowModelOverride: false,
          },
          runtime,
        ),
      ).rejects.toThrow(
        `Session "${sessionKey}" is archived. Restore it before starting new work.`,
      );
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    });
  });

  it("keeps a restored session restored after asynchronous command preparation", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:subagent:restore-race";
      const sessionId = "restore-race-session-id";
      mockConfig(home, store);
      await writeSessionStoreSeed(store, {
        [sessionKey]: {
          sessionId,
          archivedAt: Date.now(),
          updatedAt: Date.now(),
        },
      });
      vi.mocked(ensureAgentWorkspace).mockImplementationOnce(async (params) => {
        await writeSessionStoreSeed(store, {
          [sessionKey]: { sessionId, updatedAt: Date.now() },
        });
        return { dir: params?.dir ?? "/tmp/openclaw-workspace" };
      });

      await agentCommandFromIngress(
        {
          message: "run after restore",
          sessionId,
          allowModelOverride: false,
        },
        runtime,
      );

      expect(runEmbeddedAgent).toHaveBeenCalled();
      expect(
        readSessionStore<{ archivedAt?: number }>(store)[sessionKey]?.archivedAt,
      ).toBeUndefined();
    });
  });

  it("excludes an initiating agent turn from its own lifecycle interruption", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:subagent:in-band-lifecycle";
      const sessionId = "in-band-lifecycle-session-id";
      mockConfig(home, store);
      await writeSessionStoreSeed(store, {
        [sessionKey]: { sessionId, updatedAt: Date.now() },
      });
      vi.mocked(runEmbeddedAgent).mockImplementationOnce(async () => {
        await expect(
          interruptSessionWorkAdmissions({
            scope: store,
            identities: [sessionKey, sessionId],
            timeoutMs: 5,
          }),
        ).resolves.toBe(true);
        return createDefaultAgentResult();
      });

      await agentCommandFromIngress(
        {
          message: "run an in-band lifecycle command",
          sessionId,
          allowModelOverride: false,
        },
        runtime,
      );

      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    });
  });

  it("classifies lifecycle interruption as a restart abort", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:subagent:lifecycle-restart";
      const sessionId = "lifecycle-restart-session-id";
      mockConfig(home, store);
      await writeSessionStoreSeed(store, {
        [sessionKey]: { sessionId, updatedAt: Date.now() },
      });
      let observedAbortReason: unknown;
      vi.mocked(runEmbeddedAgent).mockImplementationOnce(
        async (opts) =>
          await new Promise((resolve) => {
            const finish = () => {
              observedAbortReason = opts.abortSignal?.reason;
              resolve(createDefaultAgentResult());
            };
            if (opts.abortSignal?.aborted) {
              finish();
              return;
            }
            opts.abortSignal?.addEventListener("abort", finish, { once: true });
          }),
      );

      const command = agentCommandFromIngress(
        {
          message: "interrupt this lifecycle run",
          sessionId,
          allowModelOverride: false,
        },
        runtime,
      ).catch((error: unknown) => error);
      await vi.waitFor(() => {
        expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      });
      await interruptSessionWorkAdmissions({
        scope: store,
        identities: [sessionKey, sessionId],
      });
      const commandError = await command;

      expect(isAgentRunRestartAbortReason(observedAbortReason)).toBe(true);
      expect(isAgentRunRestartAbortReason(commandError)).toBe(true);
    });
  });

  it("rejects a stale requested session id after command preparation", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:subagent:stale-request";
      mockConfig(home, store);
      await writeSessionStoreSeed(store, {
        [sessionKey]: { sessionId: "current-session-id", updatedAt: Date.now() },
      });

      await expect(
        agentCommandFromIngress(
          {
            message: "do not enter the replacement session",
            sessionKey,
            sessionId: "stale-session-id",
            allowModelOverride: false,
          },
          runtime,
        ),
      ).rejects.toThrow(`Session "${sessionKey}" changed while starting work. Retry.`);
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    });
  });

  it("uses the selected agent thinkingDefault for fresh ingress runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(
        home,
        store,
        {
          thinkingDefault: "high",
        },
        undefined,
        [{ id: "main", default: true, thinkingDefault: "off" }],
      );

      await agentCommandFromIngress(
        {
          message: "ping",
          agentId: "main",
          allowModelOverride: false,
        },
        runtime,
      );

      expect(getLastEmbeddedCall()?.thinkLevel).toBe("off");
    });
  });

  it("installs a local gateway request scope for embedded agent dispatch", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);
      const { getPluginRuntimeGatewayRequestScope } =
        await import("../plugins/runtime/gateway-request-scope.js");
      vi.mocked(attemptExecutionRuntime.runAgentAttempt).mockImplementationOnce(async () => {
        const scope = getPluginRuntimeGatewayRequestScope();
        expect(scope?.context?.getRuntimeConfig()).toMatchObject({
          session: { store },
        });
        return createDefaultAgentResult();
      });

      await agentCommand({ message: "ping", agentId: "main" }, runtime);

      expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
    });
  });

  it("persists local overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);
      vi.mocked(runEmbeddedAgent).mockResolvedValue(
        createDefaultAgentResult({
          payloads: [{ text: "json-reply", mediaUrl: "http://x.test/a.jpg" }],
          durationMs: 42,
        }),
      );

      await agentCommand(
        {
          message: "ping",
          to: "+1222",
          accountId: "kev",
          thinking: "high",
          verbose: "on",
          json: true,
        },
        runtime,
      );

      const saved = readSessionStore<{ thinkingLevel?: string; verboseLevel?: string }>(store);
      const entry = expectDefined(
        Object.values(saved)[0],
        "Object.values(saved)[0] test invariant",
      );
      expect(entry.thinkingLevel).toBe("high");
      expect(entry.verboseLevel).toBe("on");

      const callArgs = getLastEmbeddedCall();
      expect(callArgs?.thinkLevel).toBe("high");
      expect(callArgs?.verboseLevel).toBe("on");
      expect(callArgs?.prompt).toBe("ping");
      expect(callArgs?.agentAccountId).toBe("kev");

      const logCalls = (runtime.log as unknown as MockInstance).mock.calls;
      const logged = logCalls[logCalls.length - 1]?.[0] as string;
      const parsed = JSON.parse(logged) as {
        payloads: Array<{ text: string; mediaUrl?: string | null }>;
        meta: { durationMs: number };
      };
      expect(expectDefined(parsed.payloads[0], "parsed.payloads[0] test invariant").text).toBe(
        "json-reply",
      );
      expect(expectDefined(parsed.payloads[0], "parsed.payloads[0] test invariant").mediaUrl).toBe(
        "http://x.test/a.jpg",
      );
      expect(parsed.meta.durationMs).toBe(42);
    });
  });

  it("persists embedded-runner turns to the session transcript", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);
      const base = createDefaultAgentResult({ payloads: [{ text: "assistant-visible" }] });
      vi.mocked(runEmbeddedAgent).mockResolvedValueOnce({
        ...base,
        meta: {
          ...base.meta,
          executionTrace: { runner: "embedded" },
        },
      });

      await agentCommand({ message: "hello from user", agentId: "main" }, runtime);

      expect(vi.mocked(attemptExecutionRuntime.persistCliTurnTranscript)).toHaveBeenCalledTimes(1);
      const persistArgs = vi.mocked(attemptExecutionRuntime.persistCliTurnTranscript).mock
        .calls[0]?.[0];
      expect(persistArgs?.embeddedAssistantGapFill).toBe(true);
      expect(persistArgs?.body).toBe("hello from user");
      expect(persistArgs?.result.meta?.executionTrace?.runner).toBe("embedded");
    });
  });

  it("gap-fills Telegram-visible embedded replies without a runner trace", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);
      installThinkingTestProviders([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: createDirectOutboundTestAdapter({ channel: "telegram" }),
            messaging: {
              normalizeTarget: (target) => {
                const chatId = target.trim().replace(/^telegram:/i, "");
                return chatId ? `telegram:${chatId}` : undefined;
              },
              resolveOutboundSessionRoute: (params) => {
                const chatId = params.target.replace(/^telegram:/i, "");
                return buildChannelOutboundSessionRoute({
                  cfg: params.cfg,
                  agentId: params.agentId,
                  channel: "telegram",
                  accountId: params.accountId,
                  peer: { kind: "direct", id: chatId },
                  chatType: "direct",
                  from: `telegram:${chatId}`,
                  to: `telegram:${chatId}`,
                });
              },
            },
          }),
        },
      ]);
      const sendMessageTelegram = vi.fn(async () => undefined);
      const base = createDefaultAgentResult({ payloads: [{ text: "assistant-visible" }] });
      vi.mocked(runEmbeddedAgent).mockResolvedValueOnce({
        ...base,
        meta: {
          ...base.meta,
          finalAssistantVisibleText: "assistant-visible",
        },
      });

      await agentCommandFromIngress(
        {
          message: "call a tool then answer",
          agentId: "main",
          to: "+1222",
          channel: "telegram",
          messageChannel: "telegram",
          deliver: true,
          allowModelOverride: false,
          sessionEffects: "internal",
        },
        runtime,
        { sendMessageTelegram },
      );

      expect(sendMessageTelegram).toHaveBeenCalledWith("telegram:+1222", "assistant-visible", {
        accountId: undefined,
        verbose: false,
      });
      expect(vi.mocked(attemptExecutionRuntime.persistCliTurnTranscript)).toHaveBeenCalledTimes(1);
      const persistArgs = vi.mocked(attemptExecutionRuntime.persistCliTurnTranscript).mock
        .calls[0]?.[0];
      expect(persistArgs?.embeddedAssistantGapFill).toBe(true);
      expect(persistArgs?.body).toBe("call a tool then answer");
    });
  });

  it("passes configured fast mode to embedded runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, {
        model: "openai/gpt-5.5",
        models: {
          "openai/gpt-5.5": { params: { fastMode: true } },
        },
      });

      await agentCommand({ message: "ping", agentId: "main" }, runtime);

      const callArgs = getLastEmbeddedCall();
      expect(callArgs?.provider).toBe("openai");
      expect(callArgs?.model).toBe("gpt-5.5");
      expect(callArgs?.fastMode).toBe(true);
    });
  });

  it("does not load the full model catalog for trusted explicit overrides without an allowlist", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, { models: {} });

      await agentCommand(
        {
          message: "ping",
          to: "+1222",
          model: "openrouter/auto",
        },
        runtime,
      );

      expect(loadModelCatalog).not.toHaveBeenCalled();
      expectLastRunProviderModel("openrouter", "openrouter/auto");
      const thinkingDefaultCall = vi.mocked(modelSelectionModule.resolveThinkingDefault).mock
        .calls[0]?.[0];
      expect(thinkingDefaultCall?.provider).toBe("openrouter");
      expect(thinkingDefaultCall?.model).toBe("openrouter/auto");
      expect(thinkingDefaultCall?.catalog).toBeUndefined();
    });
  });

  it("uses no-tools plain prompt mode for one-shot model runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, { models: {} });

      await agentCommand(
        {
          message: "Reply with exactly OPENCLAW-MODEL-OK",
          agentId: "main",
          model: "openrouter/auto",
          modelRun: true,
          promptMode: "none",
        },
        runtime,
      );

      const callArgs = getLastEmbeddedCall();
      expect(callArgs?.provider).toBe("openrouter");
      expect(callArgs?.model).toBe("openrouter/auto");
      expect(callArgs?.modelRun).toBe(true);
      expect(callArgs?.promptMode).toBe("none");
      expect(callArgs?.disableTools).toBe(true);
    });
  });

  it("bypasses ACP sessions for one-shot model runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:main";
      mockConfig(home, store, { models: {} });
      await writeSessionStoreSeed(store, {
        [sessionKey]: {
          sessionId: "acp-backed-session",
          updatedAt: Date.now(),
        },
      });
      const runTurn = vi.fn();
      acpManagerTesting.setAcpSessionManagerForTests({
        resolveSession: vi.fn(() => ({
          kind: "ready",
          sessionKey,
          meta: {
            backend: "acpx",
            agent: "codex",
            runtimeSessionName: "runtime-1",
            mode: "persistent",
            state: "idle",
            lastActivityAt: Date.now(),
          },
        })),
        runTurn,
      });

      await agentCommand(
        {
          message: "Reply with exactly OPENCLAW-MODEL-OK",
          sessionKey,
          model: "openrouter/auto",
          modelRun: true,
          promptMode: "none",
        },
        runtime,
      );

      expect(runTurn).not.toHaveBeenCalled();
      const callArgs = getLastEmbeddedCall();
      expect(callArgs?.provider).toBe("openrouter");
      expect(callArgs?.model).toBe("openrouter/auto");
      expect(callArgs?.prompt).toBe("Reply with exactly OPENCLAW-MODEL-OK");
      expect(callArgs?.modelRun).toBe(true);
      expect(callArgs?.promptMode).toBe("none");
      expect(callArgs?.disableTools).toBe(true);
    });
  });

  it("borrows session lookup data without returning cached mutable store objects", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:cache-borrow";
      await writeSessionStoreSeed(store, {
        [sessionKey]: {
          sessionId: "session-cache-borrow",
          updatedAt: Date.now(),
          thinkingLevel: "low",
        },
        "agent:main:other": {
          sessionId: "session-other",
          updatedAt: Date.now(),
        },
      });
      mockConfig(home, store, { models: {} });

      const prepared = await agentCommandTesting.prepareAgentCommandExecution(
        {
          message: "prepare only",
          sessionKey,
        },
        runtime,
      );
      const cached = loadSessionEntry({ storePath: store, sessionKey, clone: false });

      expect(prepared.sessionStore).not.toBe(cached);
      expect(prepared.sessionEntry).not.toBe(cached);
      expect(prepared).not.toHaveProperty("recoveryCandidateEntry");
      expect(prepared.sessionStore?.[sessionKey]).toBe(prepared.sessionEntry);
      expect(prepared.sessionStore?.["agent:main:other"]).toBeUndefined();
    });
  });

  it("passes resolved session-id resume files to embedded runs", async () => {
    await withTempHome(async (home) => {
      const resumeStore = path.join(home, "sessions-resume.json");
      await writeSessionStoreSeed(resumeStore, {
        foo: {
          sessionId: "session-123",
          updatedAt: Date.now(),
          systemSent: true,
        },
      });
      mockConfig(home, resumeStore);

      await agentCommand(
        { message: "resume me", sessionId: "session-123", thinking: "low" },
        runtime,
      );

      const callArgs = getLastEmbeddedCall();
      expect(callArgs?.sessionId).toBe("session-123");
      expectSqliteSessionFileMarker({
        agentId: "main",
        sessionFile: callArgs?.sessionFile,
        sessionId: "session-123",
        storePath: resumeStore,
      });
    });
  });

  it("does not duplicate agent events from embedded runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      const assistantEvents: Array<{ runId: string; text?: string }> = [];
      const stop = onAgentEvent((evt) => {
        if (evt.stream !== "assistant") {
          return;
        }
        assistantEvents.push({
          runId: evt.runId,
          text: typeof evt.data?.text === "string" ? evt.data.text : undefined,
        });
      });

      vi.mocked(runEmbeddedAgent).mockImplementationOnce(async (params) => {
        const runId = (params as { runId?: string } | undefined)?.runId ?? "run";
        const data = { text: "hello", delta: "hello" };
        (
          params as {
            onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
          }
        ).onAgentEvent?.({ stream: "assistant", data });
        emitAgentEvent({ runId, stream: "assistant", data });
        return {
          payloads: [{ text: "hello" }],
          meta: { agentMeta: { provider: "p", model: "m" } },
        } as never;
      });

      await agentCommand({ message: "hi", to: "+1555", thinking: "low" }, runtime);
      stop();

      const matching = assistantEvents.filter((evt) => evt.text === "hello");
      expect(matching).toHaveLength(1);
    });
  });

  it("does not publish Codex app-server events from the core command callback", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      const codexEvents: Array<{ runId: string; phase?: string }> = [];
      const stop = onAgentEvent((evt) => {
        if (evt.stream !== "codex_app_server.lifecycle") {
          return;
        }
        codexEvents.push({
          runId: evt.runId,
          phase: typeof evt.data?.phase === "string" ? evt.data.phase : undefined,
        });
      });

      vi.mocked(runEmbeddedAgent).mockImplementationOnce(async (params) => {
        (
          params as {
            onAgentEvent?: (evt: { stream: string; data: Record<string, unknown> }) => void;
          }
        ).onAgentEvent?.({
          stream: "codex_app_server.lifecycle",
          data: { phase: "startup" },
        });
        return {
          payloads: [{ text: "hello" }],
          meta: { agentMeta: { provider: "p", model: "m" } },
        } as never;
      });

      await agentCommand({ message: "hi", to: "+1555", thinking: "low" }, runtime);
      stop();

      expect(codexEvents).toHaveLength(0);
    });
  });

  it("probes the configured primary first for origin-backed auto session model overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      await writeSessionStoreSeed(store, {
        "agent:main:subagent:test": {
          sessionId: "session-subagent",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "openai",
          modelOverrideFallbackOriginModel: "gpt-4.1-mini",
        },
      });

      mockConfig(home, store, {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["openai/gpt-5.4"],
        },
        models: {
          "anthropic/claude-opus-4-6": {},
          "openai/gpt-4.1-mini": {},
          "openai/gpt-5.4": {},
        },
      });

      mockModelCatalogOnce([
        { id: "claude-opus-4-6", name: "Opus", provider: "anthropic" },
        { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
        { id: "gpt-5.4", name: "GPT-5.2", provider: "openai" },
      ]);
      vi.mocked(runEmbeddedAgent)
        .mockRejectedValueOnce(Object.assign(new Error("rate limited"), { status: 429 }))
        .mockResolvedValueOnce({
          payloads: [{ text: "ok" }],
          meta: {
            durationMs: 5,
            agentMeta: { sessionId: "session-subagent", provider: "openai", model: "gpt-5.4" },
          },
        });

      await agentCommand(
        {
          message: "hi",
          sessionKey: "agent:main:subagent:test",
        },
        runtime,
      );

      const attempts = vi
        .mocked(runEmbeddedAgent)
        .mock.calls.map((call) => ({ provider: call[0]?.provider, model: call[0]?.model }));
      expect(attempts).toEqual([
        { provider: "openai", model: "gpt-4.1-mini" },
        { provider: "openai", model: "gpt-5.4" },
      ]);
    });
  });

  it("does not probe or fall back from a locked stored model", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions-locked-model.json");
      const sessionKey = "agent:main:subagent:locked-model";
      await writeSessionStoreSeed(store, {
        [sessionKey]: {
          sessionId: "session-locked-model",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
          modelOverrideSource: "auto",
          modelOverrideFallbackOriginProvider: "openai",
          modelOverrideFallbackOriginModel: "gpt-4.1-mini",
          modelSelectionLocked: true,
        },
      });

      mockConfig(home, store, {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["openai/gpt-5.4"],
        },
        models: {
          "anthropic/claude-opus-4-6": {},
          "openai/gpt-4.1-mini": {},
          "openai/gpt-5.4": {},
        },
      });
      mockModelCatalogOnce([
        { id: "claude-opus-4-6", name: "Opus", provider: "anthropic" },
        { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
        { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
      ]);
      vi.mocked(runEmbeddedAgent).mockRejectedValueOnce(
        Object.assign(new Error("rate limited"), { status: 429 }),
      );

      await expect(runAgentWithSessionKey(sessionKey)).rejects.toThrow("rate limited");
      const attempts = vi
        .mocked(runEmbeddedAgent)
        .mock.calls.map((call) => ({ provider: call[0]?.provider, model: call[0]?.model }));
      expect(attempts).toEqual([{ provider: "anthropic", model: "claude-opus-4-6" }]);
    });
  });

  it("clears legacy auto session model overrides without origin metadata", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions-legacy-auto-override.json");
      await writeSessionStoreSeed(store, {
        "agent:main:subagent:legacy-auto": {
          sessionId: "session-legacy-auto",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
          modelOverrideSource: "auto",
        },
      });

      mockConfig(home, store, {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["openai/gpt-5.4"],
        },
        models: {
          "anthropic/claude-opus-4-6": {},
          "openai/gpt-4.1-mini": {},
          "openai/gpt-5.4": {},
        },
      });

      mockModelCatalogOnce([
        { id: "claude-opus-4-6", name: "Opus", provider: "anthropic" },
        { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
        { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
      ]);

      await agentCommand(
        {
          message: "hi",
          sessionKey: "agent:main:subagent:legacy-auto",
        },
        runtime,
      );

      const attempts = vi
        .mocked(runEmbeddedAgent)
        .mock.calls.map((call) => ({ provider: call[0]?.provider, model: call[0]?.model }));
      expect(attempts).toEqual([{ provider: "openai", model: "gpt-4.1-mini" }]);

      const cleared = readSessionStore<{
        providerOverride?: string;
        modelOverride?: string;
        modelOverrideSource?: string;
      }>(store);
      const entry = cleared["agent:main:subagent:legacy-auto"];
      expect(entry?.providerOverride).toBeUndefined();
      expect(entry?.modelOverride).toBeUndefined();
      expect(entry?.modelOverrideSource).toBeUndefined();
    });
  });

  it("does not repair locked legacy auto session model overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions-locked-legacy-auto-override.json");
      await writeSessionStoreSeed(store, {
        "agent:main:subagent:locked-legacy-auto": {
          sessionId: "session-locked-legacy-auto",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
          modelOverrideSource: "auto",
          modelSelectionLocked: true,
        },
      });

      mockConfig(home, store, {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["openai/gpt-5.4"],
        },
        models: {
          "anthropic/claude-opus-4-6": {},
          "openai/gpt-4.1-mini": {},
          "openai/gpt-5.4": {},
        },
      });

      mockModelCatalogOnce([
        { id: "claude-opus-4-6", name: "Opus", provider: "anthropic" },
        { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
        { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
      ]);

      await expect(
        agentCommand(
          {
            message: "hi",
            sessionKey: "agent:main:subagent:locked-legacy-auto",
          },
          runtime,
        ),
      ).rejects.toMatchObject({
        name: "ModelSelectionLockedError",
        message: MODEL_SELECTION_LOCKED_MESSAGE,
      });

      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      const persisted = readSessionStore<{
        providerOverride?: string;
        modelOverride?: string;
        modelOverrideSource?: string;
        modelSelectionLocked?: boolean;
      }>(store)["agent:main:subagent:locked-legacy-auto"];
      expect(persisted).toMatchObject({
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-6",
        modelOverrideSource: "auto",
        modelSelectionLocked: true,
      });
    });
  });

  it("does not use fallback list for user session model overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions-user-override.json");
      await writeSessionStoreSeed(store, {
        "agent:main:subagent:user-override": {
          sessionId: "session-user-override",
          updatedAt: Date.now(),
          providerOverride: "ollama",
          modelOverride: "qwen3.5:27b",
          modelOverrideSource: "user",
        },
      });

      mockConfig(home, store, {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["openai/gpt-5.4"],
        },
        models: {
          "ollama/qwen3.5:27b": {},
          "openai/gpt-4.1-mini": {},
          "openai/gpt-5.4": {},
        },
      });

      mockModelCatalogOnce([
        { id: "qwen3.5:27b", name: "Qwen 3.5", provider: "ollama" },
        { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
        { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
      ]);
      vi.mocked(runEmbeddedAgent).mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

      await expect(
        agentCommand(
          {
            message: "hi",
            sessionKey: "agent:main:subagent:user-override",
          },
          runtime,
        ),
      ).rejects.toThrow("connect ECONNREFUSED");

      const attempts = vi
        .mocked(runEmbeddedAgent)
        .mock.calls.map((call) => ({ provider: call[0]?.provider, model: call[0]?.model }));
      expect(attempts).toEqual([{ provider: "ollama", model: "qwen3.5:27b" }]);
    });
  });

  it("clears disallowed stored override fields", async () => {
    await withTempHome(async (home) => {
      const clearStore = path.join(home, "sessions-clear-overrides.json");
      await writeSessionStoreSeed(clearStore, {
        "agent:main:subagent:clear-overrides": {
          sessionId: "session-clear-overrides",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
          authProfileOverride: "profile-legacy",
          authProfileOverrideSource: "user",
          authProfileOverrideCompactionCount: 2,
          fallbackNoticeSelectedModel: "anthropic/claude-opus-4-6",
          fallbackNoticeActiveModel: "openai/gpt-4.1-mini",
          fallbackNoticeReason: "fallback",
        },
      });

      mockConfig(home, clearStore, {
        model: { primary: "openai/gpt-4.1-mini" },
        models: {
          "openai/gpt-4.1-mini": {},
        },
      });

      mockModelCatalogOnce([
        { id: "claude-opus-4-6", name: "Opus", provider: "anthropic" },
        { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
      ]);

      await runAgentWithSessionKey("agent:main:subagent:clear-overrides");

      expectLastRunProviderModel("openai", "gpt-4.1-mini");

      const cleared = readSessionStore<{
        providerOverride?: string;
        modelOverride?: string;
        authProfileOverride?: string;
        authProfileOverrideSource?: string;
        authProfileOverrideCompactionCount?: number;
        fallbackNoticeSelectedModel?: string;
        fallbackNoticeActiveModel?: string;
        fallbackNoticeReason?: string;
      }>(clearStore);
      const entry = cleared["agent:main:subagent:clear-overrides"];
      expect(entry?.providerOverride).toBeUndefined();
      expect(entry?.modelOverride).toBeUndefined();
      expect(entry?.authProfileOverride).toBeUndefined();
      expect(entry?.authProfileOverrideSource).toBeUndefined();
      expect(entry?.authProfileOverrideCompactionCount).toBeUndefined();
      expect(entry?.fallbackNoticeSelectedModel).toBeUndefined();
      expect(entry?.fallbackNoticeActiveModel).toBeUndefined();
      expect(entry?.fallbackNoticeReason).toBeUndefined();
    });
  });

  it("rejects a locked disallowed stored override without clearing it", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions-locked-disallowed-override.json");
      const sessionKey = "agent:main:subagent:locked-disallowed";
      await writeSessionStoreSeed(store, {
        [sessionKey]: {
          sessionId: "session-locked-disallowed",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
          modelOverrideSource: "user",
          modelSelectionLocked: true,
        },
      });

      mockConfig(home, store, {
        model: { primary: "openai/gpt-4.1-mini" },
        models: {
          "openai/gpt-4.1-mini": {},
        },
      });
      mockModelCatalogOnce([
        { id: "claude-opus-4-6", name: "Opus", provider: "anthropic" },
        { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
      ]);

      await expect(runAgentWithSessionKey(sessionKey)).rejects.toMatchObject({
        name: "ModelSelectionLockedError",
        message: MODEL_SELECTION_LOCKED_MESSAGE,
      });
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
      expect(
        readSessionStore<{
          providerOverride?: string;
          modelOverride?: string;
          modelOverrideSource?: string;
          modelSelectionLocked?: boolean;
        }>(store)[sessionKey],
      ).toMatchObject({
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-6",
        modelOverrideSource: "user",
        modelSelectionLocked: true,
      });
    });
  });

  it("rejects one-off model overrides for locked sessions", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions-locked-one-off-override.json");
      const sessionKey = "agent:main:subagent:locked-one-off";
      await writeSessionStoreSeed(store, {
        [sessionKey]: {
          sessionId: "session-locked-one-off",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
          modelOverrideSource: "user",
          modelSelectionLocked: true,
        },
      });
      mockConfig(home, store, {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: {
          "anthropic/claude-opus-4-6": {},
          "openai/gpt-4.1-mini": {},
        },
      });

      await expect(
        agentCommand(
          {
            message: "hi",
            sessionKey,
            model: "openai/gpt-4.1-mini",
            allowModelOverride: true,
          },
          runtime,
        ),
      ).rejects.toMatchObject({
        name: "ModelSelectionLockedError",
        message: MODEL_SELECTION_LOCKED_MESSAGE,
      });
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    });
  });

  it("handles one-off provider/model overrides and validates override values", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, {
        models: {
          "anthropic/claude-opus-4-6": {},
          "openai/gpt-4.1-mini": {},
        },
      });

      await agentCommand(
        {
          message: "use the override",
          sessionKey: "agent:main:subagent:run-override",
          provider: "openai",
          model: "gpt-4.1-mini",
        },
        runtime,
      );

      expectLastRunProviderModel("openai", "gpt-4.1-mini");

      const saved = readSessionStore<{
        providerOverride?: string;
        modelOverride?: string;
      }>(store);
      expect(saved["agent:main:subagent:run-override"]?.providerOverride).toBeUndefined();
      expect(saved["agent:main:subagent:run-override"]?.modelOverride).toBeUndefined();

      await writeSessionStoreSeed(store, {
        "agent:main:subagent:temp-openai-run": {
          sessionId: "session-temp-openai-run",
          updatedAt: Date.now(),
          authProfileOverride: "anthropic:work",
          authProfileOverrideSource: "user",
          authProfileOverrideCompactionCount: 2,
        },
      });
      vi.mocked(authProfileStoreModule.ensureAuthProfileStore).mockReturnValue({
        version: 1,
        profiles: {
          "anthropic:work": {
            provider: "anthropic",
          },
        },
      } as never);

      await agentCommand(
        {
          message: "use a different provider once",
          sessionKey: "agent:main:subagent:temp-openai-run",
          provider: "openai",
          model: "gpt-4.1-mini",
        },
        runtime,
      );

      expectLastRunProviderModel("openai", "gpt-4.1-mini");
      expect(getLastEmbeddedCall()?.authProfileId).toBeUndefined();

      const savedAuth = readSessionStore<{
        authProfileOverride?: string;
        authProfileOverrideSource?: string;
        authProfileOverrideCompactionCount?: number;
      }>(store);
      expect(savedAuth["agent:main:subagent:temp-openai-run"]?.authProfileOverride).toBe(
        "anthropic:work",
      );
      expect(savedAuth["agent:main:subagent:temp-openai-run"]?.authProfileOverrideSource).toBe(
        "user",
      );
      expect(
        savedAuth["agent:main:subagent:temp-openai-run"]?.authProfileOverrideCompactionCount,
      ).toBe(2);

      await expect(
        agentCommand(
          {
            message: "use an invalid override",
            sessionKey: "agent:main:subagent:invalid-override",
            provider: "openai\u001b[31m",
            model: "gpt-4.1-mini",
          },
          runtime,
        ),
      ).rejects.toThrow("Provider override contains invalid control characters.");

      const parseModelRefSpy = vi.spyOn(modelSelectionModule, "parseModelRef");
      parseModelRefSpy.mockImplementationOnce(() => ({
        provider: "anthropic\u001b[31m",
        model: "claude-haiku-4-5\u001b[32m",
      }));
      mockConfig(home, store, {
        models: {
          "openai/gpt-4.1-mini": {},
        },
      });
      try {
        await expect(
          agentCommand(
            {
              message: "use disallowed override",
              sessionKey: "agent:main:subagent:sanitized-override-error",
              model: "claude-haiku-4-5",
            },
            runtime,
          ),
        ).rejects.toThrow(
          'Model override "anthropic/claude-haiku-4-5" is not allowed for agent "main".',
        );
      } finally {
        parseModelRefSpy.mockRestore();
      }
    });
  });

  it("passes resolved default thinking level to embedded runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, {
        model: { primary: "openai/gpt-4.1-mini" },
        models: {
          "anthropic/claude-opus-4-6": {},
          "openai/gpt-4.1-mini": {},
        },
      });
      mockModelCatalogOnce([
        {
          id: "gpt-4.1-mini",
          name: "GPT-4.1 Mini",
          provider: "openai",
          reasoning: true,
        },
      ]);

      await agentCommand({ message: "hi", to: "+1555" }, runtime);

      expect(getLastEmbeddedCall()?.thinkLevel).toBe("low");
      expectLastRunProviderModel("openai", "gpt-4.1-mini");
    });
  });

  it("passes routing context to embedded runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, undefined, undefined, [{ id: "ops" }]);

      await agentCommand(
        { message: "hi", agentId: "ops", replyChannel: "slack", thinking: "low" },
        runtime,
      );
      let callArgs = getLastEmbeddedCall();
      expect(callArgs?.sessionKey).toBe("agent:ops:main");
      expectSqliteSessionFileMarker({
        agentId: "ops",
        sessionFile: callArgs?.sessionFile,
        storePath: store,
      });
      expect(callArgs?.messageChannel).toBe("slack");
      expect(runtime.log).toHaveBeenCalledWith("ok");

      await agentCommand(
        {
          message: "hi",
          to: "+1555",
          channel: "whatsapp",
          thinking: "low",
          runContext: { messageChannel: "slack", accountId: "acct-2" },
        },
        runtime,
      );
      callArgs = getLastEmbeddedCall();
      expect(callArgs?.messageChannel).toBe("slack");
      expect(callArgs?.agentAccountId).toBe("acct-2");

      await expect(agentCommand({ message: "hi", agentId: "ghost" }, runtime)).rejects.toThrow(
        'Unknown agent id "ghost"',
      );
    });
  });

  it("routes explicit agent recipients through channel session contracts", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const cfg = mockConfig(home, store, undefined, undefined, [{ id: "ops" }]);

      installThinkingTestProviders([
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "whatsapp",
            outbound: createDirectOutboundTestAdapter({ channel: "whatsapp" }),
            messaging: {
              resolveOutboundSessionRoute: (params) => {
                const chatType = params.target.endsWith("@g.us") ? "group" : "direct";
                return buildChannelOutboundSessionRoute({
                  cfg: params.cfg,
                  agentId: params.agentId,
                  channel: "whatsapp",
                  accountId: params.accountId,
                  peer: { kind: chatType, id: params.target },
                  chatType,
                  from: params.target,
                  to: params.target,
                });
              },
            },
          }),
        },
      ]);
      cfg.session = { ...cfg.session, dmScope: "per-account-channel-peer" };
      await agentCommand(
        {
          message: "hi",
          agentId: "ops",
          channel: "whatsapp",
          to: "+15551234567",
          accountId: "work",
          thinking: "low",
        },
        runtime,
      );
      let callArgs = getLastEmbeddedCall();
      expect(callArgs?.sessionKey).toBe("agent:ops:whatsapp:work:direct:+15551234567");

      await agentCommand(
        {
          message: "hi",
          agentId: "ops",
          channel: "whatsapp",
          to: "120363040000000000@g.us",
          thinking: "low",
        },
        runtime,
      );
      callArgs = getLastEmbeddedCall();
      expect(callArgs?.sessionKey).toBe("agent:ops:whatsapp:group:120363040000000000@g.us");

      cfg.session = { ...cfg.session, dmScope: "main", mainKey: "work" };
      await agentCommand(
        {
          message: "hi",
          agentId: "ops",
          channel: "webchat",
          to: "+15551234567",
          thinking: "low",
        },
        runtime,
      );
      callArgs = getLastEmbeddedCall();
      expect(callArgs?.sessionKey).toBe("agent:ops:work");
    });
  });

  it("uses explicit session keys for embedded runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, undefined, undefined, [{ id: "main" }, { id: "ops" }]);

      await agentCommand({ message: "hi", sessionKey: "agent:ops:incident-42" }, runtime);

      let callArgs = getLastEmbeddedCall();
      expect(callArgs?.agentId).toBe("ops");
      expect(callArgs?.sessionKey).toBe("agent:ops:incident-42");
      expectSqliteSessionFileMarker({
        agentId: "ops",
        sessionFile: callArgs?.sessionFile,
        storePath: store,
      });

      await agentCommand({ message: "hi", agentId: "ops", sessionKey: "incident-42" }, runtime);

      callArgs = getLastEmbeddedCall();
      expect(callArgs?.agentId).toBe("ops");
      expect(callArgs?.sessionKey).toBe("agent:ops:incident-42");

      await agentCommand({ message: "hi", agentId: "ops", sessionKey: "global" }, runtime);

      callArgs = getLastEmbeddedCall();
      expect(callArgs?.agentId).toBe("ops");
      expect(callArgs?.sessionKey).toBe("agent:ops:global");
      expectSqliteSessionFileMarker({
        agentId: "ops",
        sessionFile: callArgs?.sessionFile,
        storePath: store,
      });
    });
  });

  it("rejects agent-scoped to session selectors that conflict with the requested agent", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:openclaw-weixin:direct:o9cq802hhmfc@im.wechat";
      await writeSessionStoreSeed(store, {
        [sessionKey]: { sessionId: "wechat-session", updatedAt: Date.now() },
      });
      mockConfig(home, store, undefined, undefined, [{ id: "main" }, { id: "work" }]);

      await expect(
        agentCommand({ message: "hi", agentId: "work", to: sessionKey }, runtime),
      ).rejects.toThrow('Agent id "work" does not match session key agent "main".');
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    });
  });

  it("does not forward agent-scoped to session selectors as delivery targets", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:openclaw-weixin:direct:o9cq802hhmfc@im.wechat";
      await writeSessionStoreSeed(store, {
        [sessionKey]: {
          sessionId: "wechat-session",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "+1555",
        },
      });
      mockConfig(home, store);
      installThinkingTestProviders([
        {
          pluginId: "telegram",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: createDirectOutboundTestAdapter({ channel: "telegram" }),
          }),
        },
      ]);

      await agentCommand(
        { message: "hi", to: sessionKey, deliver: true, channel: "telegram" },
        runtime,
      );

      const deliveryCall = vi.mocked(deliverAgentCommandResult).mock.calls.at(-1)?.[0] as
        | { opts?: { to?: string }; sessionEntry?: { lastTo?: string } }
        | undefined;
      expect(deliveryCall?.opts?.to).toBeUndefined();
      expect(deliveryCall?.sessionEntry?.lastTo).toBe("+1555");
    });
  });

  it("scopes bare explicit session keys to the default agent for embedded runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, undefined, undefined, [{ id: "ops", default: true }, { id: "main" }]);

      await agentCommand({ message: "hi", sessionKey: "incident-42" }, runtime);

      let callArgs = getLastEmbeddedCall();
      expect(callArgs?.agentId).toBe("ops");
      expect(callArgs?.sessionKey).toBe("agent:ops:incident-42");

      await agentCommand({ message: "hi", sessionKey: "global" }, runtime);

      callArgs = getLastEmbeddedCall();
      expect(callArgs?.agentId).toBe("ops");
      expect(callArgs?.sessionKey).toBe("global");
      expectSqliteSessionFileMarker({
        agentId: "ops",
        sessionFile: callArgs?.sessionFile,
        storePath: store,
      });

      await agentCommand({ message: "hi", sessionKey: "unknown" }, runtime);

      callArgs = getLastEmbeddedCall();
      expect(callArgs?.agentId).toBe("ops");
      expect(callArgs?.sessionKey).toBe("unknown");
      expectSqliteSessionFileMarker({
        agentId: "ops",
        sessionFile: callArgs?.sessionFile,
        storePath: store,
      });
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
