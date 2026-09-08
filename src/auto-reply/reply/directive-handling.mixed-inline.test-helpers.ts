import { vi } from "vitest";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { ModelAliasIndex } from "../../agents/model-selection.js";
import { createModelVisibilityPolicy } from "../../agents/model-visibility-policy.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { MsgContext } from "../templating.js";
import { parseInlineSessionDirectives, type InlineDirectives } from "./directive-handling.parse.js";
import { applyInlineDirectiveOverrides } from "./get-reply-directives-apply.js";

export function createSessionEntry(overrides?: Partial<SessionEntry>): SessionEntry {
  return { sessionId: "session-1", updatedAt: 1, ...overrides };
}

export async function applyMixedDirectives(params: {
  body: string;
  cfg?: OpenClawConfig;
  ctx?: MsgContext;
  agentDir?: string;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  storePath?: string;
  channel?: string;
  provider?: string;
  model?: string;
  defaultProvider?: string;
  defaultModel?: string;
  allowedModels?: ModelCatalogEntry[];
  modelAliases?: string[];
  aliasIndex?: ModelAliasIndex;
  senderIsOwner?: boolean;
  gatewayClientScopes?: string[];
  directives?: InlineDirectives;
  resolveDefaultThinkingLevel?: Parameters<
    typeof applyInlineDirectiveOverrides
  >[0]["modelState"]["resolveDefaultThinkingLevel"];
}) {
  const cfg =
    params.cfg ?? ({ commands: { text: true }, agents: { defaults: {} } } as OpenClawConfig);
  const provider = params.provider ?? "anthropic";
  const model = params.model ?? "claude-opus-4-6";
  const channel = params.channel ?? "telegram";
  const sessionKey = params.sessionKey ?? "agent:main:dm:1";
  const sessionEntry = params.sessionEntry ?? createSessionEntry();
  const sessionStore = { [sessionKey]: sessionEntry };
  const directives =
    params.directives ??
    parseInlineSessionDirectives(params.body, {
      modelAliases: params.modelAliases,
    });
  const allowedModels = params.allowedModels ?? [];
  const aliasIndex = params.aliasIndex ?? { byAlias: new Map(), byKey: new Map() };
  const modelState: Parameters<typeof applyInlineDirectiveOverrides>[0]["modelState"] = {
    provider,
    model,
    requestedRouteResolution: "resolved",
    modelPolicy: createModelVisibilityPolicy({
      cfg,
      catalog: allowedModels,
      defaultProvider: params.defaultProvider ?? provider,
      defaultModel: params.defaultModel ?? model,
      agentId: "main",
    }),
    allowedModelKeys: new Set(allowedModels.map((entry) => `${entry.provider}/${entry.id}`)),
    allowedModelCatalog: allowedModels,
    policyAliasIndex: aliasIndex,
    resetModelOverride: false,
    resolveThinkingCatalog: async () => allowedModels,
    resolveDefaultThinkingLevel: params.resolveDefaultThinkingLevel ?? (async () => "off"),
    resolveDefaultReasoningLevel: async () => "off",
    needsModelCatalog: false,
  };
  const typing = {
    onReplyStart: async () => {},
    startTypingLoop: async () => {},
    startTypingOnText: async () => {},
    refreshTypingTtl: () => {},
    isActive: () => false,
    markRunComplete: () => {},
    markDispatchIdle: () => {},
    cleanup: vi.fn(),
  };

  const result = await applyInlineDirectiveOverrides({
    ctx: {
      ...params.ctx,
      Body: params.body,
      Provider: channel,
      Surface: channel,
      ...(params.gatewayClientScopes ? { GatewayClientScopes: params.gatewayClientScopes } : {}),
    },
    cfg,
    agentId: "main",
    agentDir: params.agentDir ?? "/tmp/agent",
    workspaceDir: "/tmp/workspace",
    agentCfg: cfg.agents?.defaults ?? {},
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath: params.storePath,
    sessionScope: undefined,
    isGroup: false,
    allowTextCommands: true,
    command: {
      surface: channel,
      channel,
      ownerList: [],
      senderIsOwner: params.senderIsOwner ?? false,
      isAuthorizedSender: true,
      rawBodyNormalized: params.body,
      commandBodyNormalized: params.body,
    },
    directives,
    messageProviderKey: channel,
    elevatedEnabled: true,
    elevatedAllowed: true,
    elevatedFailures: [],
    defaultProvider: params.defaultProvider ?? provider,
    defaultModel: params.defaultModel ?? model,
    aliasIndex,
    provider,
    model,
    modelState,
    initialModelLabel: `${provider}/${model}`,
    formatModelSwitchEvent: (label) => `Model switched to ${label}.`,
    resolvedElevatedLevel: "off",
    defaultActivation: () => "always",
    contextTokens: 8192,
    effectiveModelDirective: directives.rawModelDirective,
    typing,
  });

  return { result, sessionEntry, sessionStore, typing };
}
