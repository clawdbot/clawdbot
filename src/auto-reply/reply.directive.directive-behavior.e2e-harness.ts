import path from "node:path";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles.js";
import { resetSkillsRefreshForTest } from "../agents/skills/refresh.js";
import { clearSessionStoreCacheForTest, loadSessionStore } from "../config/sessions.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginProviderRegistration } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  clearSessionAuthProfileOverrideMock,
  compactEmbeddedPiSessionMock,
  loadModelCatalogMock,
  resolveCommandSecretRefsViaGatewayMock,
  resolveSessionAuthProfileOverrideMock,
  runDirectiveBehaviorReplyAgent,
  runEmbeddedPiAgentMock,
  runDirectiveBehaviorPreparedReply,
  runPreparedReplyMock,
  runReplyAgentMock,
} from "./reply.directive.directive-behavior.e2e-mocks.js";
import { withFastReplyConfig, withFullRuntimeReplyConfig } from "./reply/get-reply-fast-path.js";

export const MAIN_SESSION_KEY = "agent:main:main";
type RunPreparedReply = typeof import("./reply/get-reply-run.js").runPreparedReply;

export const DEFAULT_TEST_MODEL_CATALOG: Array<{
  id: string;
  name: string;
  provider: string;
}> = [
  { id: "claude-opus-4-6", name: "Opus 4.5", provider: "anthropic" },
  { id: "claude-sonnet-4-1", name: "Sonnet 4.1", provider: "anthropic" },
  { id: "gpt-5.4", name: "GPT-5.4", provider: "openai" },
  { id: "gpt-5.4-pro", name: "GPT-5.4 Pro", provider: "openai" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini", provider: "openai" },
  { id: "gpt-5.4-nano", name: "GPT-5.4 Nano", provider: "openai" },
  { id: "gpt-5.4", name: "GPT-5.4 (Codex)", provider: "openai-codex" },
  { id: "gpt-5.4-pro", name: "GPT-5.4 Pro (Codex)", provider: "openai-codex" },
  { id: "gpt-5.4-mini", name: "GPT-5.4 Mini (Codex)", provider: "openai-codex" },
  { id: "gpt-4.1-mini", name: "GPT-4.1 Mini", provider: "openai" },
];

export type ReplyPayloadText = { text?: string | null } | null | undefined;

const OPENAI_XHIGH_MODEL_IDS = [
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.2",
] as const;

const OPENAI_CODEX_XHIGH_MODEL_IDS = [
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.2-codex",
  "gpt-5.1-codex",
] as const;

function createThinkingPolicyProvider(
  providerId: string,
  xhighModelIds: readonly string[],
): ProviderPlugin {
  return {
    id: providerId,
    label: providerId,
    auth: [],
    supportsXHighThinking: ({ modelId }) =>
      xhighModelIds.includes(normalizeLowercaseStringOrEmpty(modelId)),
  };
}

function createDirectiveBehaviorProviderRegistry(): ReturnType<typeof createEmptyPluginRegistry> {
  const registry = createEmptyPluginRegistry();
  const providers: PluginProviderRegistration[] = [
    {
      pluginId: "openai",
      pluginName: "OpenAI Provider",
      source: "test",
      provider: createThinkingPolicyProvider("openai", OPENAI_XHIGH_MODEL_IDS),
    },
    {
      pluginId: "openai",
      pluginName: "OpenAI Provider",
      source: "test",
      provider: createThinkingPolicyProvider("openai-codex", OPENAI_CODEX_XHIGH_MODEL_IDS),
    },
  ];
  registry.providers.push(...providers);
  return registry;
}

export function replyText(res: ReplyPayloadText | ReplyPayloadText[]): string | undefined {
  if (Array.isArray(res)) {
    return typeof res[0]?.text === "string" ? res[0]?.text : undefined;
  }
  return typeof res?.text === "string" ? res.text : undefined;
}

export function replyTexts(res: ReplyPayloadText | ReplyPayloadText[]): string[] {
  const payloads = Array.isArray(res) ? res : [res];
  return payloads
    .map((entry) => (typeof entry?.text === "string" ? entry.text : undefined))
    .filter((value): value is string => Boolean(value));
}

export function makeEmbeddedTextResult(text = "done") {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  };
}

export function mockEmbeddedTextResult(text = "done") {
  runEmbeddedPiAgentMock.mockResolvedValue(makeEmbeddedTextResult(text));
}

export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      return await fn(home);
    },
    {
      env: {
        OPENCLAW_AGENT_DIR: (home) => path.join(home, ".openclaw", "agent"),
        PI_CODING_AGENT_DIR: (home) => path.join(home, ".openclaw", "agent"),
      },
      prefix: "openclaw-reply-",
    },
  );
}

export function sessionStorePath(home: string): string {
  return path.join(home, "sessions.json");
}

export function makeWhatsAppDirectiveConfig(
  home: string,
  defaults: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return withFastReplyConfig({
    agents: {
      defaults: {
        workspace: path.join(home, "openclaw"),
        ...defaults,
      },
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: sessionStorePath(home) },
    ...extra,
  });
}

export const AUTHORIZED_WHATSAPP_COMMAND = {
  From: "+1222",
  To: "+1222",
  Provider: "whatsapp",
  SenderE164: "+1222",
  CommandAuthorized: true,
} as const;

export function makeElevatedDirectiveConfig(home: string) {
  return makeWhatsAppDirectiveConfig(
    home,
    {
      model: "anthropic/claude-opus-4-6",
      elevatedDefault: "on",
    },
    {
      tools: {
        elevated: {
          allowFrom: { whatsapp: ["+1222"] },
        },
      },
      channels: { whatsapp: { allowFrom: ["+1222"] } },
      session: { store: sessionStorePath(home) },
    },
  );
}

export function assertModelSelection(
  storePath: string,
  selection: { model?: string; provider?: string } = {},
) {
  const store = loadSessionStore(storePath);
  const entry = store[MAIN_SESSION_KEY];
  expect(entry).toBeDefined();
  expect(entry?.modelOverride).toBe(selection.model);
  expect(entry?.providerOverride).toBe(selection.provider);
}

export function assertElevatedOffStatusReply(text: string | undefined) {
  expect(text).toContain("Elevated mode disabled.");
  const optionsLine = text?.split("\n").find((line) => line.trim().startsWith("⚙️"));
  expect(optionsLine).toBeTruthy();
  expect(optionsLine).not.toContain("elevated");
}

export function installDirectiveBehaviorE2EHooks() {
  beforeEach(async () => {
    await resetSkillsRefreshForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    clearSessionStoreCacheForTest();
    resetSystemEventsForTest();
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createDirectiveBehaviorProviderRegistry());
    compactEmbeddedPiSessionMock.mockReset();
    compactEmbeddedPiSessionMock.mockResolvedValue({ payloads: [], meta: {} });
    runEmbeddedPiAgentMock.mockReset();
    loadModelCatalogMock.mockReset();
    loadModelCatalogMock.mockResolvedValue(DEFAULT_TEST_MODEL_CATALOG);
    resolveCommandSecretRefsViaGatewayMock.mockReset();
    resolveCommandSecretRefsViaGatewayMock.mockImplementation(async ({ config }) => ({
      resolvedConfig: config,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    }));
    clearSessionAuthProfileOverrideMock.mockReset();
    clearSessionAuthProfileOverrideMock.mockResolvedValue(undefined);
    resolveSessionAuthProfileOverrideMock.mockReset();
    resolveSessionAuthProfileOverrideMock.mockResolvedValue(undefined);
    runReplyAgentMock.mockReset();
    runReplyAgentMock.mockImplementation(runDirectiveBehaviorReplyAgent);
    runPreparedReplyMock.mockReset();
    runPreparedReplyMock.mockImplementation(runDirectiveBehaviorPreparedReply);
  });

  afterEach(async () => {
    await resetSkillsRefreshForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    clearSessionStoreCacheForTest();
    resetSystemEventsForTest();
    resetPluginRuntimeStateForTest();
    vi.restoreAllMocks();
  });
}

export function installFreshDirectiveBehaviorReplyMocks(params?: {
  onActualRunPreparedReply?: (runPreparedReply: RunPreparedReply) => void;
  runPreparedReply?: (...args: Parameters<RunPreparedReply>) => unknown;
}) {
  vi.doMock("../agents/pi-embedded.js", () => ({
    abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
    compactEmbeddedPiSession: (...args: unknown[]) => compactEmbeddedPiSessionMock(...args),
    runEmbeddedPiAgent: (...args: unknown[]) => runEmbeddedPiAgentMock(...args),
    queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
    resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
    isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
    isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  }));
  vi.doMock("../agents/pi-embedded.runtime.js", () => ({
    abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
    compactEmbeddedPiSession: (...args: unknown[]) => compactEmbeddedPiSessionMock(...args),
    runEmbeddedPiAgent: (...args: unknown[]) => runEmbeddedPiAgentMock(...args),
    queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
    resolveActiveEmbeddedRunSessionId: vi.fn().mockReturnValue(undefined),
    resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
    isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
    isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
    waitForEmbeddedPiRunEnd: vi.fn().mockResolvedValue(true),
  }));
  vi.doMock("../agents/model-catalog.js", () => ({
    loadModelCatalog: loadModelCatalogMock,
  }));
  vi.doMock("../cli/command-secret-gateway.js", () => ({
    resolveCommandSecretRefsViaGateway: (...args: unknown[]) =>
      resolveCommandSecretRefsViaGatewayMock(...args),
  }));
  vi.doMock("../agents/auth-profiles/session-override.js", () => ({
    clearSessionAuthProfileOverride: (...args: unknown[]) =>
      clearSessionAuthProfileOverrideMock(...args),
    resolveSessionAuthProfileOverride: (...args: unknown[]) =>
      resolveSessionAuthProfileOverrideMock(...args),
  }));
  vi.doMock("../plugins/hook-runner-global.js", () => ({
    getGlobalHookRunner: () => undefined,
  }));
  vi.doMock("./reply/agent-runner.runtime.js", () => ({
    runReplyAgent: (...args: unknown[]) => runReplyAgentMock(...args),
  }));
  vi.doMock("./reply/get-reply-run.js", () => ({
    runPreparedReply: (...args: unknown[]) => runPreparedReplyMock(...args),
  }));
  if (params?.runPreparedReply || params?.onActualRunPreparedReply) {
    if (params.runPreparedReply && !params.onActualRunPreparedReply) {
      vi.doMock("./reply/get-reply-run.js", () => ({
        runPreparedReply: (...args: Parameters<RunPreparedReply>) =>
          params.runPreparedReply?.(...args),
      }));
      return;
    }
    vi.doMock("./reply/get-reply-run.js", async () => {
      const actual = await vi.importActual<typeof import("./reply/get-reply-run.js")>(
        "./reply/get-reply-run.js",
      );
      params.onActualRunPreparedReply?.(actual.runPreparedReply);
      return {
        ...actual,
        runPreparedReply: (...args: Parameters<RunPreparedReply>) =>
          params.runPreparedReply?.(...args),
      };
    });
  }
}

export function makeRestrictedElevatedDisabledConfig(home: string) {
  return withFullRuntimeReplyConfig({
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-6",
        workspace: path.join(home, "openclaw"),
      },
      list: [
        {
          id: "restricted",
          tools: {
            elevated: { enabled: false },
          },
        },
      ],
    },
    tools: {
      elevated: {
        allowFrom: { whatsapp: ["+1222"] },
      },
    },
    channels: { whatsapp: { allowFrom: ["+1222"] } },
    session: { store: path.join(home, "sessions.json") },
  } as const);
}
