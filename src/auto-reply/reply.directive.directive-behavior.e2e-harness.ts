import { afterEach, beforeEach, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles.js";
import { resetSkillsRefreshForTest } from "../agents/skills/refresh.js";
import { clearSessionStoreCacheForTest } from "../config/sessions.js";
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

const DEFAULT_TEST_MODEL_CATALOG: Array<{
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
