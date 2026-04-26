import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import "./agent-command.test-mocks.js";
import { __testing as acpManagerTesting } from "../acp/control-plane/manager.js";
import * as authProfileStoreModule from "../agents/auth-profiles/store.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import * as modelSelectionModule from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import * as runtimeSnapshotModule from "../config/runtime-snapshot.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  emitAgentEvent,
  onAgentEvent,
  resetAgentEventsForTest,
  resetAgentRunContextForTest,
} from "../infra/agent-events.js";
import type { RuntimeEnv } from "../runtime.js";
import { agentCommand, agentCommandFromIngress } from "./agent.js";
import { createThrowingTestRuntime } from "./test-runtime-config-helpers.js";

const configIoMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  readConfigFileSnapshotForWrite: vi.fn(),
}));

vi.mock("../config/io.js", () => ({
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
    replaceRuntimeAuthProfileStoreSnapshots: vi.fn(),
    saveAuthProfileStore: vi.fn(),
    updateAuthProfileStoreWithLock: vi.fn(async () => createEmptyStore()),
  };
});

vi.mock("../agents/command/session-store.runtime.js", () => {
  return {
    updateSessionStoreAfterAgentRun: vi.fn(async () => undefined),
  };
});

vi.mock("../agents/command/attempt-execution.runtime.js", () => {
  return {
    buildAcpResult: vi.fn(),
    createAcpVisibleTextAccumulator: vi.fn(),
    emitAcpAssistantDelta: vi.fn(),
    emitAcpLifecycleEnd: vi.fn(),
    emitAcpLifecycleError: vi.fn(),
    emitAcpLifecycleStart: vi.fn(),
    persistAcpTurnTranscript: vi.fn(
      async (params: { sessionEntry?: unknown }) => params.sessionEntry,
    ),
    persistCliTurnTranscript: vi.fn(
      async (params: { sessionEntry?: unknown }) => params.sessionEntry,
    ),
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

      return await runEmbeddedPiAgent({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.sessionAgentId,
        trigger: "user",
        messageChannel: params.messageChannel,
        agentAccountId: runContext.accountId,
        messageTo: opts.replyTo ?? opts.to,
        messageThreadId: opts.threadId,
        senderIsOwner: opts.senderIsOwner,
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
  const dirname = (filePath: string): string => {
    const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
    return lastSlash >= 0 ? filePath.slice(0, lastSlash) : ".";
  };
  const joinPath = (...parts: string[]): string => {
    const separator = parts.some((part) => part.includes("\\")) ? "\\" : "/";
    return parts
      .map((part, index) =>
        index === 0 ? part.replace(/[\\/]+$/u, "") : part.replace(/^[\\/]+|[\\/]+$/gu, ""),
      )
      .filter(Boolean)
      .join(separator);
  };
  const resolveSessionFile = (sessionId: string, agentId: string, sessionsDir?: string): string =>
    joinPath(sessionsDir ?? ".openclaw", "agents", agentId, "sessions", `${sessionId}.jsonl`);

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
        const sessionsDir = params.storePath ? dirname(params.storePath) : undefined;
        const sessionFileFromStorePath =
          params.sessionEntry?.sessionFile ??
          resolveSessionFile(params.sessionId, params.agentId, sessionsDir);
        const sessionFile = params.sessionEntry?.sessionFile
          ? sessionFileFromStorePath
          : resolveSessionFile(params.sessionId, params.agentId, sessionsDir);
        let sessionEntry = params.sessionEntry;
        if (params.sessionStore && params.storePath && params.sessionKey) {
          const existingEntry = params.sessionStore[params.sessionKey] ?? {};
          sessionEntry = {
            ...existingEntry,
            sessionId: params.sessionId,
            sessionFile,
          };
          params.sessionStore[params.sessionKey] = sessionEntry;
          fs.writeFileSync(params.storePath, JSON.stringify(params.sessionStore));
        }
        return { sessionFile, sessionEntry };
      },
    ),
  };
});

const runtime = createThrowingTestRuntime();

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-agent-", skipSessionCleanup: true });
}

function mockConfig(
  home: string,
  storePath: string,
  agentOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>>,
  telegramOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>>,
  agentsList?: Array<{ id: string; default?: boolean }>,
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

function writeSessionStoreSeed(
  storePath: string,
  sessions: Record<string, Record<string, unknown>>,
) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(sessions));
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
  return vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
}

function expectLastRunProviderModel(provider: string, model: string): void {
  const callArgs = getLastEmbeddedCall();
  expect(callArgs?.provider).toBe(provider);
  expect(callArgs?.model).toBe(model);
}

function readSessionStore<T>(storePath: string): Record<string, T> {
  return JSON.parse(fs.readFileSync(storePath, "utf-8")) as Record<string, T>;
}

async function runAgentWithSessionKey(sessionKey: string): Promise<void> {
  await agentCommand({ message: "hi", sessionKey }, runtime);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest();
  resetAgentRunContextForTest();
  acpManagerTesting.resetAcpSessionManagerForTests();
  runtimeSnapshotModule.clearRuntimeConfigSnapshot();
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue(createDefaultAgentResult());
  vi.mocked(loadModelCatalog).mockResolvedValue([]);
  vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(() => false);
  configIoMocks.readConfigFileSnapshotForWrite.mockResolvedValue({
    snapshot: { valid: false, resolved: {} as OpenClawConfig },
    writeOptions: {},
  });
});

describe("agentCommand", () => {
  it("enforces ingress trust flags", async () => {
    await expect(
      // Runtime guard for non-TS callers; TS callsites are statically typed.
      agentCommandFromIngress({ message: "hi", to: "+1555" } as never, runtime),
    ).rejects.toThrow("senderIsOwner must be explicitly set for ingress agent runs.");

    await expect(
      // Runtime guard for non-TS callers; TS callsites are statically typed.
      agentCommandFromIngress(
        {
          message: "hi",
          to: "+1555",
          senderIsOwner: false,
        } as never,
        runtime,
      ),
    ).rejects.toThrow("allowModelOverride must be explicitly set for ingress agent runs.");
  });

  it("persists local overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue(
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

      const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
        string,
        { thinkingLevel?: string; verboseLevel?: string }
      >;
      const entry = Object.values(saved)[0];
      expect(entry.thinkingLevel).toBe("high");
      expect(entry.verboseLevel).toBe("on");

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.thinkLevel).toBe("high");
      expect(callArgs?.verboseLevel).toBe("on");
      expect(callArgs?.senderIsOwner).toBe(true);
      expect(callArgs?.prompt).toBe("ping");
      expect(callArgs?.agentAccountId).toBe("kev");

      const logged = (runtime.log as unknown as MockInstance).mock.calls.at(-1)?.[0] as string;
      const parsed = JSON.parse(logged) as {
        payloads: Array<{ text: string; mediaUrl?: string | null }>;
        meta: { durationMs: number };
      };
      expect(parsed.payloads[0].text).toBe("json-reply");
      expect(parsed.payloads[0].mediaUrl).toBe("http://x.test/a.jpg");
      expect(parsed.meta.durationMs).toBe(42);
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
      expect(modelSelectionModule.resolveThinkingDefault).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "openrouter",
          model: "auto",
          catalog: undefined,
        }),
      );
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
      expect(callArgs).toEqual(
        expect.objectContaining({
          provider: "openrouter",
          model: "openrouter/auto",
          modelRun: true,
          promptMode: "none",
          disableTools: true,
        }),
      );
    });
  });

  it("passes resolved session-id resume files to embedded runs", async () => {
    await withTempHome(async (home) => {
      const resumeStore = path.join(home, "sessions-resume.json");
      writeSessionStoreSeed(resumeStore, {
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

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.sessionId).toBe("session-123");
      expect(callArgs?.sessionFile).toContain(
        `${path.dirname(resumeStore)}${path.sep}agents${path.sep}main${path.sep}sessions${path.sep}session-123.jsonl`,
      );
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

      vi.mocked(runEmbeddedPiAgent).mockImplementationOnce(async (params) => {
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

  it("uses default fallback list for session model overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      writeSessionStoreSeed(store, {
        "agent:main:subagent:test": {
          sessionId: "session-subagent",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-6",
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

      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        { id: "claude-opus-4-6", name: "Opus", provider: "anthropic" },
        { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
        { id: "gpt-5.4", name: "GPT-5.2", provider: "openai" },
      ]);
      vi.mocked(runEmbeddedPiAgent)
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
        .mocked(runEmbeddedPiAgent)
        .mock.calls.map((call) => ({ provider: call[0]?.provider, model: call[0]?.model }));
      expect(attempts).toEqual([
        { provider: "anthropic", model: "claude-opus-4-6" },
        { provider: "openai", model: "gpt-5.4" },
      ]);
    });
  });

  it("clears disallowed stored override fields", async () => {
    await withTempHome(async (home) => {
      const clearStore = path.join(home, "sessions-clear-overrides.json");
      writeSessionStoreSeed(clearStore, {
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

      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
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

      writeSessionStoreSeed(store, {
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
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
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
      expect(callArgs?.sessionFile).toContain(`${path.sep}agents${path.sep}ops${path.sep}sessions`);
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
});
