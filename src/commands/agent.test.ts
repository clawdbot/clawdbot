import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import "./agent-command.test-mocks.js";
import "../cron/isolated-agent.mocks.js";
import { __testing as acpManagerTesting } from "../acp/control-plane/manager.js";
import { resolveAgentDir, resolveSessionAgentId } from "../agents/agent-scope.js";
import * as authProfilesModule from "../agents/auth-profiles.js";
import * as sessionStoreModule from "../agents/command/session-store.js";
import { resolveSession } from "../agents/command/session.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import * as modelSelectionModule from "../agents/model-selection.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { OpenClawConfig } from "../config/config.js";
import * as configModule from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions.js";
import * as sessionPathsModule from "../config/sessions/paths.js";
import {
  emitAgentEvent,
  onAgentEvent,
  resetAgentEventsForTest,
  resetAgentRunContextForTest,
} from "../infra/agent-events.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { RuntimeEnv } from "../runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { agentCommand, agentCommandFromIngress } from "./agent.js";

vi.mock("../agents/auth-profiles.js", () => {
  return {
    ensureAuthProfileStore: vi.fn(() => ({ version: 1, profiles: {} })),
  };
});

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

vi.mock("../agents/command/session-store.js", () => {
  return {
    updateSessionStoreAfterAgentRun: vi.fn(async () => undefined),
  };
});

const runtime: RuntimeEnv = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

const configSpy = vi.spyOn(configModule, "loadConfig");
const readConfigFileSnapshotForWriteSpy = vi.spyOn(configModule, "readConfigFileSnapshotForWrite");

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "openclaw-agent-" });
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
  configSpy.mockReturnValue(cfg);
  return cfg;
}

async function runWithDefaultAgentConfig(params: {
  home: string;
  args: Parameters<typeof agentCommand>[0];
  agentsList?: Array<{ id: string; default?: boolean }>;
}) {
  const store = path.join(params.home, "sessions.json");
  mockConfig(params.home, store, undefined, undefined, params.agentsList);
  await agentCommand(params.args, runtime);
  return vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
}

async function runEmbeddedWithTempConfig(params: {
  args: Parameters<typeof agentCommand>[0];
  agentOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>>;
  telegramOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["channels"]>["telegram"]>>;
  agentsList?: Array<{ id: string; default?: boolean }>;
}) {
  return withTempHome(async (home) => {
    const store = path.join(home, "sessions.json");
    mockConfig(home, store, params.agentOverrides, params.telegramOverrides, params.agentsList);
    await agentCommand(params.args, runtime);
    return vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
  });
}

function writeSessionStoreSeed(
  storePath: string,
  sessions: Record<string, Record<string, unknown>>,
) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(sessions, null, 2));
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

async function withCrossAgentResumeFixture(
  run: (params: { sessionId: string; sessionKey: string; cfg: OpenClawConfig }) => Promise<void>,
): Promise<void> {
  await withTempHome(async (home) => {
    const storePattern = path.join(home, "sessions", "{agentId}", "sessions.json");
    const execStore = path.join(home, "sessions", "exec", "sessions.json");
    const sessionId = "session-exec-hook";
    const sessionKey = "agent:exec:hook:gmail:thread-1";
    writeSessionStoreSeed(execStore, {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        systemSent: true,
      },
    });
    const cfg = mockConfig(home, storePattern, undefined, undefined, [
      { id: "dev" },
      { id: "exec", default: true },
    ]);
    await run({ sessionId, sessionKey, cfg });
  });
}

async function expectPersistedSessionFile(params: {
  seedKey: string;
  sessionId: string;
  expectedPathFragment: string;
}) {
  await withTempHome(async (home) => {
    const store = path.join(home, "sessions.json");
    writeSessionStoreSeed(store, {
      [params.seedKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
      },
    });
    mockConfig(home, store);
    await agentCommand({ message: "hi", sessionKey: params.seedKey }, runtime);
    const saved = readSessionStore<{ sessionId?: string; sessionFile?: string }>(store);
    const entry = saved[params.seedKey];
    expect(entry?.sessionId).toBe(params.sessionId);
    expect(entry?.sessionFile).toContain(params.expectedPathFragment);
    expect(getLastEmbeddedCall()?.sessionFile).toBe(entry?.sessionFile);
  });
}

async function runAgentWithSessionKey(sessionKey: string): Promise<void> {
  await agentCommand({ message: "hi", sessionKey }, runtime);
}

async function expectDefaultThinkLevel(params: {
  agentOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>>;
  catalogEntry: Record<string, unknown>;
  expected: string;
}) {
  await withTempHome(async (home) => {
    const store = path.join(home, "sessions.json");
    mockConfig(home, store, params.agentOverrides);
    vi.mocked(loadModelCatalog).mockResolvedValueOnce([params.catalogEntry as never]);
    await agentCommand({ message: "hi", to: "+1555" }, runtime);
    expect(getLastEmbeddedCall()?.thinkLevel).toBe(params.expected);
  });
}

function createTelegramOutboundPlugin() {
  const sendWithTelegram = async (
    ctx: {
      deps?: { [channelId: string]: unknown };
      to: string;
      text: string;
      accountId?: string | null;
      mediaUrl?: string;
    },
    mediaUrl?: string,
  ) => {
    const sendTelegram = ctx.deps?.["telegram"] as
      | ((
          to: string,
          text: string,
          opts: Record<string, unknown>,
        ) => Promise<{ messageId: string; chatId: string }>)
      | undefined;
    if (!sendTelegram) {
      throw new Error("sendTelegram dependency missing");
    }
    const result = await sendTelegram(ctx.to, ctx.text, {
      accountId: ctx.accountId ?? undefined,
      ...(mediaUrl ? { mediaUrl } : {}),
      verbose: false,
    });
    return { channel: "telegram", messageId: result.messageId, chatId: result.chatId };
  };

  return createOutboundTestPlugin({
    id: "telegram",
    outbound: {
      deliveryMode: "direct",
      sendText: async (ctx) => sendWithTelegram(ctx),
      sendMedia: async (ctx) => sendWithTelegram(ctx, ctx.mediaUrl),
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionStoreCacheForTest();
  resetAgentEventsForTest();
  resetAgentRunContextForTest();
  resetPluginRuntimeStateForTest();
  acpManagerTesting.resetAcpSessionManagerForTests();
  configModule.clearRuntimeConfigSnapshot();
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue(createDefaultAgentResult());
  vi.mocked(loadModelCatalog).mockResolvedValue([]);
  vi.mocked(modelSelectionModule.isCliProvider).mockImplementation(() => false);
  readConfigFileSnapshotForWriteSpy.mockResolvedValue({
    snapshot: { valid: false, resolved: {} as OpenClawConfig },
    writeOptions: {},
  } as Awaited<ReturnType<typeof configModule.readConfigFileSnapshotForWrite>>);
});

describe("agentCommand", () => {
  it("persists thinking and verbose overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "hi", to: "+1222", thinking: "high", verbose: "on" }, runtime);

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
    });
  });

  it.each([
    {
      name: "defaults senderIsOwner to true for local agent runs",
      args: { message: "hi", to: "+1555" },
      expected: true,
    },
    {
      name: "honors explicit senderIsOwner override",
      args: { message: "hi", to: "+1555", senderIsOwner: false },
      expected: false,
    },
  ])("$name", async ({ args, expected }) => {
    const callArgs = await runEmbeddedWithTempConfig({ args });
    expect(callArgs?.senderIsOwner).toBe(expected);
  });

  it("requires explicit senderIsOwner for ingress runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);
      await expect(
        // Runtime guard for non-TS callers; TS callsites are statically typed.
        agentCommandFromIngress({ message: "hi", to: "+1555" } as never, runtime),
      ).rejects.toThrow("senderIsOwner must be explicitly set for ingress agent runs.");
    });
  });

  it("requires explicit allowModelOverride for ingress runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);
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
  });

  it("honors explicit senderIsOwner for ingress runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);
      await agentCommandFromIngress(
        { message: "hi", to: "+1555", senderIsOwner: false, allowModelOverride: false },
        runtime,
      );
      const ingressCall = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(ingressCall?.senderIsOwner).toBe(false);
      expect(ingressCall).not.toHaveProperty("allowModelOverride");
    });
  });

  it("resumes when session-id is provided", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      writeSessionStoreSeed(store, {
        foo: {
          sessionId: "session-123",
          updatedAt: Date.now(),
          systemSent: true,
        },
      });
      mockConfig(home, store);

      await agentCommand({ message: "resume me", sessionId: "session-123" }, runtime);

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.sessionId).toBe("session-123");
    });
  });

  it("creates a stable session key for explicit session-id-only runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const cfg = mockConfig(home, store);

      const resolution = resolveSession({ cfg, sessionId: "explicit-session-123" });

      expect(resolution.sessionKey).toBe("agent:main:explicit:explicit-session-123");
      expect(resolution.sessionId).toBe("explicit-session-123");
    });
  });

  it("persists explicit session-id-only runs with the synthetic session key", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, {
        model: { primary: "claude-cli/claude-sonnet-4-6" },
        models: { "claude-cli/claude-sonnet-4-6": {} },
      });
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 5,
          agentMeta: {
            sessionId: "claude-cli-session-1",
            provider: "claude-cli",
            model: "claude-sonnet-4-6",
            cliSessionBinding: {
              sessionId: "claude-cli-session-1",
            },
          },
        },
      });

      await agentCommand({ message: "resume me", sessionId: "explicit-session-123" }, runtime);

      expect(vi.mocked(sessionStoreModule.updateSessionStoreAfterAgentRun)).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "explicit-session-123",
          sessionKey: "agent:main:explicit:explicit-session-123",
        }),
      );
    });
  });

  it("uses the resumed session agent scope when sessionId resolves to another agent store", async () => {
    await withCrossAgentResumeFixture(async ({ sessionId, sessionKey, cfg }) => {
      const resolution = resolveSession({ cfg, sessionId });
      expect(resolution.sessionKey).toBe(sessionKey);
      const agentId = resolveSessionAgentId({ sessionKey: resolution.sessionKey, config: cfg });
      expect(agentId).toBe("exec");
      expect(resolveAgentDir(cfg, agentId)).toContain(
        `${path.sep}agents${path.sep}exec${path.sep}agent`,
      );
    });
  });

  it("resolves duplicate cross-agent sessionIds deterministically", async () => {
    await withTempHome(async (home) => {
      const storePattern = path.join(home, "sessions", "{agentId}", "sessions.json");
      const otherStore = path.join(home, "sessions", "other", "sessions.json");
      const retiredStore = path.join(home, "sessions", "retired", "sessions.json");
      writeSessionStoreSeed(otherStore, {
        "agent:other:main": {
          sessionId: "run-dup",
          updatedAt: Date.now() + 1_000,
        },
      });
      writeSessionStoreSeed(retiredStore, {
        "agent:retired:acp:run-dup": {
          sessionId: "run-dup",
          updatedAt: Date.now(),
        },
      });
      const cfg = mockConfig(home, storePattern, undefined, undefined, [
        { id: "other" },
        { id: "retired", default: true },
      ]);

      const resolution = resolveSession({ cfg, sessionId: "run-dup" });

      expect(resolution.sessionKey).toBe("agent:retired:acp:run-dup");
      expect(resolution.storePath).toBe(retiredStore);
    });
  });

  it("uses origin.provider for channel-specific session reset overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      writeSessionStoreSeed(store, {
        main: {
          sessionId: "origin-provider-reset",
          updatedAt: Date.now() - 30 * 60_000,
          origin: { provider: "discord" },
        },
      });
      const cfg = mockConfig(home, store);
      cfg.session = {
        ...cfg.session,
        reset: { mode: "idle", idleMinutes: 10 },
        resetByChannel: {
          discord: { mode: "idle", idleMinutes: 120 },
        },
      };

      const resolution = resolveSession({ cfg, sessionKey: "main" });

      expect(resolution.sessionId).toBe("origin-provider-reset");
      expect(resolution.isNewSession).toBe(false);
    });
  });

  it("forwards resolved outbound session context when resuming by sessionId", async () => {
    await withCrossAgentResumeFixture(async ({ sessionId, sessionKey, cfg }) => {
      const resolution = resolveSession({ cfg, sessionId });
      expect(resolution.sessionKey).toBe(sessionKey);
      const agentId = resolveSessionAgentId({ sessionKey: resolution.sessionKey, config: cfg });
      expect(
        buildOutboundSessionContext({
          cfg,
          sessionKey: resolution.sessionKey,
          agentId,
        }),
      ).toEqual(
        expect.objectContaining({
          key: sessionKey,
          agentId: "exec",
        }),
      );
    });
  });

  it("resolves resumed session transcript path from custom session store directory", async () => {
    await withTempHome(async (home) => {
      const customStoreDir = path.join(home, "custom-state");
      const store = path.join(customStoreDir, "sessions.json");
      writeSessionStoreSeed(store, {});
      mockConfig(home, store);
      const resolveSessionFilePathSpy = vi.spyOn(sessionPathsModule, "resolveSessionFilePath");

      await agentCommand({ message: "resume me", sessionId: "session-custom-123" }, runtime);

      const matchingCall = resolveSessionFilePathSpy.mock.calls.find(
        (call) => call[0] === "session-custom-123",
      );
      expect(matchingCall?.[2]).toEqual(
        expect.objectContaining({
          agentId: "main",
          sessionsDir: customStoreDir,
        }),
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

      await agentCommand({ message: "hi", to: "+1555" }, runtime);
      stop();

      const matching = assistantEvents.filter((evt) => evt.text === "hello");
      expect(matching).toHaveLength(1);
    });
  });

  it("uses provider/model from agents.defaults.model.primary", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, {
        model: { primary: "openai/gpt-4.1-mini" },
        models: {
          "anthropic/claude-opus-4-6": {},
          "openai/gpt-4.1-mini": {},
        },
      });

      await agentCommand({ message: "hi", to: "+1555" }, runtime);

      expectLastRunProviderModel("openai", "gpt-4.1-mini");
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

  it("keeps stored session model override when models allowlist is empty", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      writeSessionStoreSeed(store, {
        "agent:main:subagent:allow-any": {
          sessionId: "session-allow-any",
          updatedAt: Date.now(),
          providerOverride: "openai",
          modelOverride: "gpt-custom-foo",
        },
      });

      mockConfig(home, store, {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: {},
      });

      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        { id: "claude-opus-4-6", name: "Opus", provider: "anthropic" },
      ]);

      await runAgentWithSessionKey("agent:main:subagent:allow-any");

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.provider).toBe("openai");
      expect(callArgs?.model).toBe("gpt-custom-foo");

      const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
        string,
        { providerOverride?: string; modelOverride?: string }
      >;
      expect(saved["agent:main:subagent:allow-any"]?.providerOverride).toBe("openai");
      expect(saved["agent:main:subagent:allow-any"]?.modelOverride).toBe("gpt-custom-foo");
    });
  });

  it("persists cleared model and auth override fields when stored override falls back to default", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      writeSessionStoreSeed(store, {
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

      mockConfig(home, store, {
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

      const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
        string,
        {
          providerOverride?: string;
          modelOverride?: string;
          authProfileOverride?: string;
          authProfileOverrideSource?: string;
          authProfileOverrideCompactionCount?: number;
          fallbackNoticeSelectedModel?: string;
          fallbackNoticeActiveModel?: string;
          fallbackNoticeReason?: string;
        }
      >;
      const entry = saved["agent:main:subagent:clear-overrides"];
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

  it("applies per-run provider and model overrides without persisting them", async () => {
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
    });
  });

  it("rejects explicit override values that contain control characters", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, {
        models: {
          "anthropic/claude-opus-4-6": {},
          "openai/gpt-4.1-mini": {},
        },
      });

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
    });
  });

  it("sanitizes provider/model text in model-allowlist errors", async () => {
    const parseModelRefSpy = vi.spyOn(modelSelectionModule, "parseModelRef");
    parseModelRefSpy.mockImplementationOnce(() => ({
      provider: "anthropic\u001b[31m",
      model: "claude-haiku-4-5\u001b[32m",
    }));
    try {
      await withTempHome(async (home) => {
        const store = path.join(home, "sessions.json");
        mockConfig(home, store, {
          models: {
            "openai/gpt-4.1-mini": {},
          },
        });

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
      });
    } finally {
      parseModelRefSpy.mockRestore();
    }
  });

  it("keeps stored auth profile overrides during one-off cross-provider runs", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      writeSessionStoreSeed(store, {
        "agent:main:subagent:temp-openai-run": {
          sessionId: "session-temp-openai-run",
          updatedAt: Date.now(),
          authProfileOverride: "anthropic:work",
          authProfileOverrideSource: "user",
          authProfileOverrideCompactionCount: 2,
        },
      });
      mockConfig(home, store, {
        models: {
          "anthropic/claude-opus-4-6": {},
          "openai/gpt-4.1-mini": {},
        },
      });
      vi.mocked(authProfilesModule.ensureAuthProfileStore).mockReturnValue({
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

      const saved = readSessionStore<{
        authProfileOverride?: string;
        authProfileOverrideSource?: string;
        authProfileOverrideCompactionCount?: number;
      }>(store);
      expect(saved["agent:main:subagent:temp-openai-run"]?.authProfileOverride).toBe(
        "anthropic:work",
      );
      expect(saved["agent:main:subagent:temp-openai-run"]?.authProfileOverrideSource).toBe("user");
      expect(saved["agent:main:subagent:temp-openai-run"]?.authProfileOverrideCompactionCount).toBe(
        2,
      );
    });
  });

  it("keeps explicit sessionKey even when sessionId exists elsewhere", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      writeSessionStoreSeed(store, {
        "agent:main:main": {
          sessionId: "sess-main",
          updatedAt: Date.now(),
        },
      });
      mockConfig(home, store);

      await agentCommand(
        {
          message: "hi",
          sessionId: "sess-main",
          sessionKey: "agent:main:subagent:abc",
        },
        runtime,
      );

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.sessionKey).toBe("agent:main:subagent:abc");

      const saved = JSON.parse(fs.readFileSync(store, "utf-8")) as Record<
        string,
        { sessionId?: string }
      >;
      expect(saved["agent:main:subagent:abc"]?.sessionId).toBe("sess-main");
    });
  });

  it("persists resolved sessionFile for existing session keys", async () => {
    await expectPersistedSessionFile({
      seedKey: "agent:main:subagent:abc",
      sessionId: "sess-main",
      expectedPathFragment: `${path.sep}agents${path.sep}main${path.sep}sessions${path.sep}sess-main.jsonl`,
    });
  });

  it("derives session key from --agent when no routing target is provided", async () => {
    await withTempHome(async (home) => {
      const callArgs = await runWithDefaultAgentConfig({
        home,
        args: { message: "hi", agentId: "ops" },
        agentsList: [{ id: "ops" }],
      });
      expect(callArgs?.sessionKey).toBe("agent:ops:main");
      expect(callArgs?.sessionFile).toContain(`${path.sep}agents${path.sep}ops${path.sep}sessions`);
    });
  });

  it("rejects unknown agent overrides", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await expect(agentCommand({ message: "hi", agentId: "ghost" }, runtime)).rejects.toThrow(
        'Unknown agent id "ghost"',
      );
    });
  });

  it("defaults thinking to low for reasoning-capable models", async () => {
    await expectDefaultThinkLevel({
      catalogEntry: {
        id: "claude-opus-4-6",
        name: "Opus 4.5",
        provider: "anthropic",
        reasoning: true,
      },
      expected: "low",
    });
  });

  it("defaults thinking to adaptive for Anthropic Claude 4.6 models", async () => {
    await expectDefaultThinkLevel({
      agentOverrides: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
      },
      catalogEntry: {
        id: "claude-opus-4-6",
        name: "Opus 4.6",
        provider: "anthropic",
        reasoning: true,
      },
      expected: "adaptive",
    });
  });

  it("prefers per-model thinking over global thinkingDefault", async () => {
    await expectDefaultThinkLevel({
      agentOverrides: {
        thinkingDefault: "low",
        models: {
          "anthropic/claude-opus-4-6": {
            params: { thinking: "high" },
          },
        },
      },
      catalogEntry: {
        id: "claude-opus-4-6",
        name: "Opus 4.5",
        provider: "anthropic",
        reasoning: true,
      },
      expected: "high",
    });
  });

  it("prints JSON payload when requested", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue(
        createDefaultAgentResult({
          payloads: [{ text: "json-reply", mediaUrl: "http://x.test/a.jpg" }],
          durationMs: 42,
        }),
      );
      const store = path.join(home, "sessions.json");
      mockConfig(home, store);

      await agentCommand({ message: "hi", to: "+1999", json: true }, runtime);

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

  it("passes the message through as the agent prompt", async () => {
    const callArgs = await runEmbeddedWithTempConfig({
      args: { message: "ping", to: "+1333" },
    });
    expect(callArgs?.prompt).toBe("ping");
  });

  it("passes through telegram accountId when delivering", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      mockConfig(home, store, undefined, { botToken: "t-1" });
      setActivePluginRegistry(
        createTestRegistry([
          { pluginId: "telegram", plugin: createTelegramOutboundPlugin(), source: "test" },
        ]),
      );
      const deps = {
        sendMessageWhatsApp: vi.fn(),
        sendMessageTelegram: vi.fn().mockResolvedValue({ messageId: "t1", chatId: "123" }),
        sendMessageSlack: vi.fn(),
        sendMessageDiscord: vi.fn(),
        sendMessageSignal: vi.fn(),
        sendMessageIMessage: vi.fn(),
      };

      const prevTelegramToken = process.env.TELEGRAM_BOT_TOKEN;
      process.env.TELEGRAM_BOT_TOKEN = "";
      try {
        await agentCommand(
          {
            message: "hi",
            to: "123",
            deliver: true,
            channel: "telegram",
          },
          runtime,
          deps,
        );

        expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
          "123",
          "ok",
          expect.objectContaining({ accountId: undefined, verbose: false }),
        );
      } finally {
        if (prevTelegramToken === undefined) {
          delete process.env.TELEGRAM_BOT_TOKEN;
        } else {
          process.env.TELEGRAM_BOT_TOKEN = prevTelegramToken;
        }
      }
    });
  });

  it("uses reply channel as the message channel context", async () => {
    const callArgs = await runEmbeddedWithTempConfig({
      args: { message: "hi", agentId: "ops", replyChannel: "slack" },
      agentsList: [{ id: "ops" }],
    });
    expect(callArgs?.messageChannel).toBe("slack");
  });

  it("prefers runContext for embedded routing", async () => {
    const callArgs = await runEmbeddedWithTempConfig({
      args: {
        message: "hi",
        to: "+1555",
        channel: "whatsapp",
        runContext: { messageChannel: "slack", accountId: "acct-2" },
      },
    });
    expect(callArgs?.messageChannel).toBe("slack");
    expect(callArgs?.agentAccountId).toBe("acct-2");
  });

  it("forwards accountId to embedded runs", async () => {
    const callArgs = await runEmbeddedWithTempConfig({
      args: { message: "hi", to: "+1555", accountId: "kev" },
    });
    expect(callArgs?.agentAccountId).toBe("kev");
  });

  it("logs output when delivery is disabled", async () => {
    await withTempHome(async (home) => {
      await runWithDefaultAgentConfig({
        home,
        args: { message: "hi", agentId: "ops" },
        agentsList: [{ id: "ops" }],
      });

      expect(runtime.log).toHaveBeenCalledWith("ok");
    });
  });
});
