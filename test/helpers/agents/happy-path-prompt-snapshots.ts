// Happy path prompt snapshot helper reads expected prompt snapshot files.
import fs from "node:fs";
import path from "node:path";
import type { Model } from "openclaw/plugin-sdk/llm";
import { resolveHeartbeatPromptForResponseTool } from "../../../src/auto-reply/heartbeat.js";
import {
  buildDirectChatContext,
  buildGroupChatContext,
  buildGroupIntro,
} from "../../../src/auto-reply/reply/groups.js";
import {
  buildInboundMetaSystemPrompt,
  buildInboundUserContextPrefix,
} from "../../../src/auto-reply/reply/inbound-meta.js";
import { buildReplyPromptEnvelope } from "../../../src/auto-reply/reply/prompt-prelude.js";
import type { TemplateContext } from "../../../src/auto-reply/templating.js";
import { SILENT_REPLY_TOKEN } from "../../../src/auto-reply/tokens.js";
import { normalizeChatType } from "../../../src/channels/chat-type.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import type {
  AnyAgentTool,
  EmbeddedRunAttemptParams,
} from "../../../src/plugin-sdk/agent-harness-runtime.js";
import { normalizeAgentRuntimeTools } from "../../../src/plugin-sdk/agent-harness-runtime.js";
import { createOpenClawCodingTools } from "../../../src/plugin-sdk/agent-harness.js";
import type { PluginRegistry } from "../../../src/plugins/registry.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../../src/plugins/runtime.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../../../src/test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../../../src/test-utils/channel-plugins.js";
import {
  CODEX_MODEL_PROMPT_FIXTURE_DIR,
  CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR,
} from "./prompt-snapshot-paths.js";

// Builds Codex happy-path prompt snapshot fixtures for agent prompt regression tests.

export { CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR };

const WORKSPACE_DIR = "/tmp/openclaw-happy-path/workspace";
const AGENT_DIR = "/tmp/openclaw-happy-path/agent";
const SESSION_FILE = "/tmp/openclaw-happy-path/session.jsonl";
const MODEL_ID = "gpt-5.5";
const CODEX_PROMPT_PERSONALITY = "pragmatic";
const CODEX_MODEL_PROMPT_FIXTURE_PATH = path.join(
  CODEX_MODEL_PROMPT_FIXTURE_DIR,
  `${MODEL_ID}.${CODEX_PROMPT_PERSONALITY}.instructions.md`,
);
const CODEX_MODEL_PROMPT_SOURCE_PATH = path.join(
  CODEX_MODEL_PROMPT_FIXTURE_DIR,
  `${MODEL_ID}.${CODEX_PROMPT_PERSONALITY}.source.json`,
);
const CODEX_YOLO_PERMISSION_INSTRUCTIONS = [
  "Filesystem sandboxing defines which files can be read or written. `sandbox_mode` is `danger-full-access`: No filesystem sandboxing - all commands are permitted. Network access is enabled.",
  "Approval policy is currently never. Do not provide the `sandbox_permissions` for any reason, commands will be rejected.",
].join("\n");
const HAPPY_PATH_TOOL_NAMES = new Set([
  "nodes",
  "cron",
  "message",
  "heartbeat_respond",
  "tts",
  "gateway",
  "agents_list",
  "sessions_list",
  "sessions_history",
  "sessions_search",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
  "session_status",
  "web_search",
  "web_fetch",
]);

type CodexDynamicToolFunctionSpec = {
  type?: "function";
  name: string;
  description?: string;
  inputSchema?: unknown;
};

type CodexDynamicToolNamespaceSpec = {
  type: "namespace";
  name: string;
  tools: CodexDynamicToolFunctionSpec[];
};

type CodexDynamicToolSpec = CodexDynamicToolFunctionSpec | CodexDynamicToolNamespaceSpec;

function flattenCodexDynamicToolSpecs(
  specs: readonly CodexDynamicToolSpec[],
): CodexDynamicToolFunctionSpec[] {
  return specs.flatMap((spec) => (spec.type === "namespace" ? spec.tools : [spec]));
}

type CodexPromptSnapshotApi = {
  resolveCodexPromptSnapshotAppServerOptions: (pluginConfig?: unknown) => unknown;
  buildCodexHarnessPromptSnapshot: (params: {
    attempt: EmbeddedRunAttemptParams;
    cwd: string;
    threadId: string;
    dynamicTools: CodexDynamicToolSpec[];
    appServer: unknown;
    config?: Record<string, unknown>;
    promptText?: string;
    developerInstructionAdditions?: string;
    turnScopedDeveloperInstructions?: string;
    heartbeatCollaborationInstructions?: string;
  }) => {
    developerInstructions: string;
    threadStartParams: Record<string, unknown>;
    threadResumeParams: Record<string, unknown>;
    turnStartParams: Record<string, unknown> & {
      input?: unknown;
      collaborationMode?: { settings?: { developer_instructions?: string } };
    };
  };
  createCodexDynamicToolSpecsForPromptSnapshot: (params: {
    tools: AnyAgentTool[];
    pluginConfig?: {
      codexDynamicToolsLoading?: "searchable" | "direct";
      codexDynamicToolsExclude?: string[];
    };
    directToolNames?: string[];
  }) => CodexDynamicToolSpec[];
};

type PromptSnapshotFile = {
  path: string;
  content: string;
};

type PromptScenario = {
  id: string;
  title: string;
  notes: string[];
  trigger: "user" | "heartbeat";
  ctx: TemplateContext;
  prompt: string;
  extraSystemPrompt: string;
  dynamicTools: CodexDynamicToolSpec[];
  toolSnapshotFile: string;
};

const CODEX_TEST_API_MODULE_ID = resolveRelativeBundledPluginPublicModuleId({
  fromModuleUrl: import.meta.url,
  pluginId: "codex",
  artifactBasename: "test-api.js",
});

/** Load the Codex public test API without hardcoding plugin-private paths. */
async function loadCodexPromptSnapshotApi(): Promise<CodexPromptSnapshotApi> {
  return (await import(CODEX_TEST_API_MODULE_ID)) as CodexPromptSnapshotApi;
}

type ScenarioChannelPluginFixture = {
  pluginId: string;
  plugin: unknown;
};

const scenarioChannelPluginFixtures = new Map<string, Promise<ScenarioChannelPluginFixture>>();

/**
 * Tool construction resolves the scenario's channel plugin for message-tool
 * schema data. Without a loaded channel registry that lookup falls back to the
 * bundled-channel jiti loader, which re-transpiles the core source graph and
 * stalls snapshot generation by minutes. Import the entry-declared channel
 * plugin surface through the ambient (tsx/vitest) module graph instead so the
 * already-evaluated core modules are reused.
 */
function scenarioChannelPluginFixture(pluginId: string): Promise<ScenarioChannelPluginFixture> {
  const cached = scenarioChannelPluginFixtures.get(pluginId);
  if (cached) {
    return cached;
  }
  const loading = loadScenarioChannelPluginFixture(pluginId);
  scenarioChannelPluginFixtures.set(pluginId, loading);
  return loading;
}

async function loadScenarioChannelPluginFixture(
  pluginId: string,
): Promise<ScenarioChannelPluginFixture> {
  const moduleId = resolveRelativeBundledPluginPublicModuleId({
    fromModuleUrl: import.meta.url,
    pluginId,
    artifactBasename: "channel-plugin-api.js",
  });
  const moduleNamespace = (await import(moduleId)) as Record<string, unknown>;
  // Bundled channel entries (extensions/<id>/index.ts) declare their channel
  // plugin export from channel-plugin-api.js as `<id>Plugin`; the setup-only
  // sibling export shares the channel id, so name selection stays exact.
  const exportName = `${pluginId}Plugin`;
  const plugin = moduleNamespace[exportName];
  if (!plugin || typeof plugin !== "object") {
    throw new Error(
      `missing channel plugin export "${exportName}" in ${moduleId}; align the snapshot helper with the ${pluginId} plugin entry`,
    );
  }
  return { pluginId, plugin };
}

/**
 * Pins exactly the scenario channel while its tools are built. Cross-channel
 * action discovery walks every loaded channel plugin, so registering more than
 * the scenario channel would change the generated message-tool schema bytes.
 */
function withScenarioChannelRegistry<T>(fixture: ScenarioChannelPluginFixture, build: () => T): T {
  const previousRegistry: PluginRegistry | null = getActivePluginRegistry();
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: fixture.pluginId,
        plugin: fixture.plugin,
        source: "prompt-snapshot-fixture",
        origin: "bundled",
      },
    ]),
  );
  try {
    return build();
  } finally {
    if (previousRegistry) {
      setActivePluginRegistry(previousRegistry);
    } else {
      resetPluginRuntimeStateForTest();
    }
  }
}

const CODEX_WORKSPACE_BOOTSTRAP_CONTEXT_FILES = [
  {
    path: path.join(WORKSPACE_DIR, "MEMORY.md"),
    content: "<MEMORY.md contents will be here>",
  },
] as const;

const CODEX_WORKSPACE_THREAD_DEVELOPER_CONTEXT_FILES = [
  {
    path: path.join(WORKSPACE_DIR, "TOOLS.md"),
    content: "<TOOLS.md contents will be here>",
  },
] as const;

const CODEX_WORKSPACE_TURN_SCOPED_DEVELOPER_CONTEXT_FILES = [
  {
    path: path.join(WORKSPACE_DIR, "IDENTITY.md"),
    content: "<IDENTITY.md contents will be here>",
  },
  {
    path: path.join(WORKSPACE_DIR, "SOUL.md"),
    content: "<SOUL.md contents will be here>",
  },
  {
    path: path.join(WORKSPACE_DIR, "USER.md"),
    content: "<USER.md contents will be here>",
  },
] as const;

const CODEX_HEARTBEAT_CONTEXT_FILE = {
  path: path.join(WORKSPACE_DIR, "HEARTBEAT.md"),
  content: "<HEARTBEAT.md contents will be here>",
} as const;

const CODEX_WORKSPACE_BOOTSTRAP_PROMPT_CONTEXT = [
  "OpenClaw loaded these user-editable workspace files for the current turn. Codex loads AGENTS.md natively. TOOLS.md is provided as inherited Codex developer instructions. SOUL.md, IDENTITY.md, and USER.md are provided as turn-scoped collaboration instructions so native Codex subagents do not inherit them. HEARTBEAT.md is handled by heartbeat collaboration-mode guidance. Those files are not repeated here.",
  "",
  "# Project Context",
  "",
  "The following project context files have been loaded:",
  "",
  ...CODEX_WORKSPACE_BOOTSTRAP_CONTEXT_FILES.flatMap((file) => [
    `## ${file.path}`,
    "",
    file.content,
    "",
  ]),
]
  .join("\n")
  .trim();

const CODEX_WORKSPACE_THREAD_DEVELOPER_INSTRUCTIONS = [
  "## OpenClaw Workspace Instructions",
  "",
  "OpenClaw loaded these workspace instruction files from the active agent workspace. Internalize and follow them accordingly.",
  "",
  ...CODEX_WORKSPACE_THREAD_DEVELOPER_CONTEXT_FILES.flatMap((file) => [
    `### ${file.path}`,
    "",
    file.content,
    "",
  ]),
]
  .join("\n")
  .trim();

const CODEX_WORKSPACE_TURN_SCOPED_DEVELOPER_INSTRUCTIONS = [
  "## OpenClaw Agent Soul",
  "",
  "OpenClaw loaded these workspace instruction files from the active agent workspace. They are the canonical definitions of who you are, how you think and work, and the human you work alongside. Internalize and follow them accordingly.",
  "",
  ...CODEX_WORKSPACE_TURN_SCOPED_DEVELOPER_CONTEXT_FILES.flatMap((file) => [
    `### ${file.path}`,
    "",
    file.content,
    "",
  ]),
]
  .join("\n")
  .trim();

const CODEX_HEARTBEAT_COLLABORATION_INSTRUCTIONS = [
  "## OpenClaw Heartbeat Workspace",
  "",
  "HEARTBEAT.md exists in the active agent workspace. Read it before proceeding with this heartbeat, then decide what action is appropriate.",
  "",
  `- ${CODEX_HEARTBEAT_CONTEXT_FILE.path}`,
].join("\n");

const CODEX_PROMPT_SNAPSHOT_THREAD_CONFIG = {
  "features.code_mode_only": false,
};

const baseConfig: OpenClawConfig = {
  messages: {
    groupChat: {
      visibleReplies: "message_tool",
    },
  },
  agents: {
    defaults: {
      heartbeat: {
        every: "30m",
      },
    },
  },
};

const dynamicToolsConfig: OpenClawConfig = {
  ...baseConfig,
  plugins: {
    enabled: true,
    slots: {
      memory: "none",
    },
  },
};

const happyPathModel = {
  id: MODEL_ID,
  provider: "openai",
  api: "responses",
  input: ["text"],
  contextWindow: 272_000,
} as unknown as Model;

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableJsonValue(child)]),
  );
}

function stableJson(value: unknown): string {
  return `${JSON.stringify(stableJsonValue(value), null, 2)}\n`;
}

function markdownFence(info: string, value: string): string {
  const body = value.trimEnd();
  const longestBacktickRun = Math.max(
    3,
    ...(body.match(/`+/g) ?? []).map((match) => match.length + 1),
  );
  const fence = "`".repeat(longestBacktickRun);
  return [`${fence}${info}`, body, fence].join("\n");
}

function readFixture(pathFromRepoRoot: string): string {
  return fs.readFileSync(path.resolve(pathFromRepoRoot), "utf8");
}

function approximateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function textStats(value: string): { chars: number; roughTokens: number } {
  return {
    chars: value.length,
    roughTokens: approximateTokens(value),
  };
}

function createPrompt(ctx: TemplateContext, body: string): string {
  const inboundUserContext = buildInboundUserContextPrefix(ctx);
  const promptBody = [inboundUserContext, body].filter(Boolean).join("\n\n");
  return buildReplyPromptEnvelope({
    ctx,
    sessionCtx: ctx,
    baseBody: promptBody,
    hasUserBody: true,
    inboundUserContext: "",
    isBareSessionReset: false,
    startupAction: "new",
    prefixedBody: promptBody,
  }).prefixedCommandBody;
}

function createExtraSystemPrompt(params: {
  ctx: TemplateContext;
  chatContext: string;
  intro?: string;
}): string {
  return [
    buildInboundMetaSystemPrompt(params.ctx, {}),
    params.chatContext,
    params.intro,
    params.ctx.GroupSystemPrompt,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function createAttempt(params: {
  scenario: PromptScenario;
  sessionKey: string;
}): EmbeddedRunAttemptParams {
  return {
    agentId: "main",
    agentDir: AGENT_DIR,
    workspaceDir: WORKSPACE_DIR,
    sessionFile: SESSION_FILE,
    sessionKey: params.sessionKey,
    sessionId: `session-${params.scenario.id}`,
    runId: `run-${params.scenario.id}`,
    provider: "codex",
    modelId: MODEL_ID,
    model: happyPathModel,
    prompt: params.scenario.prompt,
    extraSystemPrompt: params.scenario.extraSystemPrompt,
    config: baseConfig,
    thinkLevel: "medium",
    timeoutMs: 600_000,
    trigger: params.scenario.trigger,
    messageProvider: params.scenario.ctx.Provider,
    messageChannel: params.scenario.ctx.OriginatingChannel,
    chatType: normalizeChatType(params.scenario.ctx.ChatType),
    agentAccountId: params.scenario.ctx.AccountId,
    messageTo: params.scenario.ctx.OriginatingTo,
    messageThreadId: params.scenario.ctx.MessageThreadId,
    groupId: params.scenario.ctx.From,
    groupChannel: params.scenario.ctx.GroupChannel,
    groupSpace: params.scenario.ctx.GroupSpace,
    senderId: params.scenario.ctx.SenderId,
    senderName: params.scenario.ctx.SenderName,
    senderUsername: params.scenario.ctx.SenderUsername,
    senderE164: params.scenario.ctx.SenderE164,
    senderIsOwner: true,
    currentMessageId: params.scenario.ctx.MessageSid,
    sourceReplyDeliveryMode: "message_tool_only",
    forceMessageTool: true,
    authStorage: {} as EmbeddedRunAttemptParams["authStorage"],
    modelRegistry: {} as EmbeddedRunAttemptParams["modelRegistry"],
  } as EmbeddedRunAttemptParams;
}

function createDynamicTools(params: {
  codexApi: CodexPromptSnapshotApi;
  ctx: TemplateContext;
  trigger: "user" | "heartbeat";
}): CodexDynamicToolSpec[] {
  const tools = createOpenClawCodingTools({
    agentId: "main",
    workspaceDir: WORKSPACE_DIR,
    agentDir: AGENT_DIR,
    sessionKey: params.ctx.SessionKey,
    sessionId: `session-tools-${params.trigger}`,
    runId: `run-tools-${params.trigger}`,
    messageProvider: params.ctx.Provider,
    agentAccountId: params.ctx.AccountId,
    messageTo: params.ctx.OriginatingTo,
    messageThreadId: params.ctx.MessageThreadId,
    groupId: params.ctx.From,
    groupChannel: params.ctx.GroupChannel,
    groupSpace: params.ctx.GroupSpace,
    senderId: params.ctx.SenderId,
    senderName: params.ctx.SenderName,
    senderUsername: params.ctx.SenderUsername,
    senderE164: params.ctx.SenderE164,
    senderIsOwner: true,
    currentMessageId: params.ctx.MessageSid,
    modelProvider: "openai",
    modelId: MODEL_ID,
    modelApi: "responses",
    modelContextWindowTokens: 272_000,
    forceMessageTool: true,
    enableHeartbeatTool: params.trigger === "heartbeat",
    forceHeartbeatTool: params.trigger === "heartbeat",
    trigger: params.trigger,
    config: dynamicToolsConfig,
    toolConstructionPlan: {
      includeBaseCodingTools: false,
      includeShellTools: false,
      includeChannelTools: false,
      includeOpenClawTools: true,
      includePluginTools: false,
    },
  });
  const normalized = normalizeAgentRuntimeTools({
    tools,
    runtimePlan: undefined,
    provider: "codex",
    config: dynamicToolsConfig,
    workspaceDir: WORKSPACE_DIR,
    env: {},
    modelId: MODEL_ID,
    modelApi: "responses",
    model: happyPathModel,
    // No provider runtime plugin owns tool-schema hooks for the `codex`
    // harness provider, so a runtime plugin load can only rediscover that
    // through the jiti source loader (minutes of core re-transpilation).
    // Registry-only resolution keeps the same no-op outcome instantly.
    allowProviderRuntimePluginLoad: false,
  });
  return params.codexApi.createCodexDynamicToolSpecsForPromptSnapshot({
    tools: normalized.filter((tool) => HAPPY_PATH_TOOL_NAMES.has(tool.name)),
    directToolNames: ["message"],
  });
}

async function createScenarioDynamicTools(params: {
  codexApi: CodexPromptSnapshotApi;
  ctx: TemplateContext;
  trigger: "user" | "heartbeat";
}): Promise<CodexDynamicToolSpec[]> {
  const provider = params.ctx.Provider;
  if (!provider) {
    throw new Error("prompt snapshot scenarios must set ctx.Provider for channel tool fixtures");
  }
  const fixture = await scenarioChannelPluginFixture(provider);
  return withScenarioChannelRegistry(fixture, () => createDynamicTools(params));
}

async function createScenarios(codexApi: CodexPromptSnapshotApi): Promise<PromptScenario[]> {
  const telegramDirectCtx: TemplateContext = {
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "user:1000001",
    AccountId: "primary",
    ChatType: "direct",
    SessionKey: "agent:main:telegram:direct:1000001",
    MessageSid: "tg-msg-0001",
    SenderId: "1000001",
    SenderName: "Pash",
    SenderUsername: "pash",
    Body: "Can you check whether the nightly build finished and tell me what happened?",
    BodyStripped: "Can you check whether the nightly build finished and tell me what happened?",
  };
  const discordGroupCtx: TemplateContext = {
    Provider: "discord",
    Surface: "discord",
    OriginatingChannel: "discord",
    OriginatingTo: "channel:987654321",
    From: "guild:123456789/channel:987654321",
    AccountId: "primary",
    ChatType: "group",
    SessionKey: "agent:main:discord:guild:123456789:channel:987654321",
    MessageSid: "discord-msg-0001",
    SenderId: "424242",
    SenderName: "Pash",
    SenderUsername: "pash",
    GroupSubject: "OpenClaw maintainers",
    GroupChannel: "#agent-sandbox",
    GroupSpace: "OpenClaw",
    ConversationLabel: "OpenClaw/#agent-sandbox",
    WasMentioned: true,
    InboundHistory: [
      {
        sender: "Peter",
        body: "I pushed the Discord-side message-tool bridge.",
      },
      {
        sender: "Pash",
        body: "@OpenClaw please verify the Codex happy path too.",
      },
    ],
    Body: "@OpenClaw can you audit whether this prompt path has conflicting silence instructions?",
    BodyStripped: "can you audit whether this prompt path has conflicting silence instructions?",
  };
  const heartbeatCtx: TemplateContext = {
    ...telegramDirectCtx,
    MessageSid: "heartbeat-0001",
    Body: resolveHeartbeatPromptForResponseTool(),
    BodyStripped: resolveHeartbeatPromptForResponseTool(),
  };
  const telegramDirectTools = await createScenarioDynamicTools({
    codexApi,
    ctx: telegramDirectCtx,
    trigger: "user",
  });
  const discordGroupTools = await createScenarioDynamicTools({
    codexApi,
    ctx: discordGroupCtx,
    trigger: "user",
  });
  const heartbeatTools = await createScenarioDynamicTools({
    codexApi,
    ctx: heartbeatCtx,
    trigger: "heartbeat",
  });

  return [
    {
      id: "telegram-direct-codex-message-tool",
      title: "Telegram Direct Codex Message Tool Turn",
      notes: [
        "Default happy path: OpenAI model through the Codex harness/runtime, Telegram direct conversation, and message-tool-only visible replies.",
        "A quiet turn is represented by not calling `message(action=send)`; the normal final assistant text is private to OpenClaw/Codex.",
      ],
      trigger: "user",
      ctx: telegramDirectCtx,
      prompt: createPrompt(
        telegramDirectCtx,
        telegramDirectCtx.BodyStripped ?? telegramDirectCtx.Body ?? "",
      ),
      extraSystemPrompt: createExtraSystemPrompt({
        ctx: telegramDirectCtx,
        chatContext: buildDirectChatContext({
          sessionCtx: telegramDirectCtx,
          sourceReplyDeliveryMode: "message_tool_only",
        }),
      }),
      dynamicTools: telegramDirectTools,
      toolSnapshotFile: "codex-dynamic-tools.telegram-direct.json",
    },
    {
      id: "discord-group-codex-message-tool",
      title: "Discord Group Codex Message Tool Turn",
      notes: [
        "Default happy path: the same Codex agent is mentioned in a Discord group/channel while Telegram can remain the user's primary direct interface.",
        "Group-visible output must be explicit through the message tool; the model is also told to mostly lurk unless directly addressed or clearly useful.",
      ],
      trigger: "user",
      ctx: discordGroupCtx,
      prompt: createPrompt(
        discordGroupCtx,
        discordGroupCtx.BodyStripped ?? discordGroupCtx.Body ?? "",
      ),
      extraSystemPrompt: createExtraSystemPrompt({
        ctx: discordGroupCtx,
        chatContext: buildGroupChatContext({
          sessionCtx: discordGroupCtx,
          sourceReplyDeliveryMode: "message_tool_only",
          silentReplyPolicy: "allow",
          silentToken: SILENT_REPLY_TOKEN,
        }),
        intro: buildGroupIntro({
          defaultActivation: "mention",
        }),
      }),
      dynamicTools: discordGroupTools,
      toolSnapshotFile: "codex-dynamic-tools.discord-group.json",
    },
    {
      id: "telegram-heartbeat-codex-tool",
      title: "Telegram Direct Codex Heartbeat Tool Turn",
      notes: [
        "Heartbeat happy path: Codex receives the structured `heartbeat_respond` dynamic tool in the searchable catalog instead of the initial tool context.",
        "The heartbeat tool still carries the notify/no-notify decision, outcome, summary, and optional notification text instead of relying only on final-text parsing.",
      ],
      trigger: "heartbeat",
      ctx: heartbeatCtx,
      prompt: createPrompt(heartbeatCtx, heartbeatCtx.BodyStripped ?? heartbeatCtx.Body ?? ""),
      extraSystemPrompt: createExtraSystemPrompt({
        ctx: heartbeatCtx,
        chatContext: buildDirectChatContext({
          sessionCtx: heartbeatCtx,
          sourceReplyDeliveryMode: "message_tool_only",
        }),
      }),
      dynamicTools: heartbeatTools,
      toolSnapshotFile: "codex-dynamic-tools.heartbeat-turn.json",
    },
  ];
}

function selectedThreadStartParams(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    developerInstructions: "<see Reconstructed Model-Bound Prompt Layers>",
    dynamicTools: Array.isArray(value.dynamicTools)
      ? flattenCodexDynamicToolSpecs(value.dynamicTools as CodexDynamicToolSpec[]).map(
          (tool) => tool.name,
        )
      : value.dynamicTools,
  };
}

function selectedThreadResumeParams(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    developerInstructions: "<see Reconstructed Model-Bound Prompt Layers>",
  };
}

function selectedTurnStartParams(value: Record<string, unknown>): Record<string, unknown> {
  return {
    ...value,
    input: Array.isArray(value.input)
      ? value.input.map((item) =>
          item && typeof item === "object" && "type" in item
            ? {
                ...item,
                text:
                  typeof (item as { text?: unknown }).text === "string"
                    ? "<see Reconstructed Model-Bound Prompt Layers>"
                    : (item as { text?: unknown }).text,
              }
            : item,
        )
      : value.input,
  };
}

function renderModelBoundPromptLayers(params: {
  scenario: PromptScenario;
  codexSnapshot: ReturnType<CodexPromptSnapshotApi["buildCodexHarnessPromptSnapshot"]>;
  dynamicToolsJson: string;
}): string[] {
  const codexModelInstructions = readFixture(CODEX_MODEL_PROMPT_FIXTURE_PATH);
  const codexModelSource = JSON.parse(readFixture(CODEX_MODEL_PROMPT_SOURCE_PATH)) as unknown;
  const codexConfigInstructions =
    typeof params.codexSnapshot.threadStartParams.config === "object" &&
    params.codexSnapshot.threadStartParams.config &&
    "instructions" in params.codexSnapshot.threadStartParams.config &&
    typeof params.codexSnapshot.threadStartParams.config.instructions === "string"
      ? params.codexSnapshot.threadStartParams.config.instructions
      : "";
  const openClawDeveloperInstructions = params.codexSnapshot.developerInstructions;
  const codexCollaborationModeInstructions =
    typeof params.codexSnapshot.turnStartParams.collaborationMode?.settings
      ?.developer_instructions === "string"
      ? params.codexSnapshot.turnStartParams.collaborationMode.settings.developer_instructions
      : "";
  const turnInputText = readCodexTurnInputText(params.codexSnapshot.turnStartParams);
  const textOnlyTotal = [
    codexModelInstructions,
    CODEX_YOLO_PERMISSION_INSTRUCTIONS,
    codexConfigInstructions,
    openClawDeveloperInstructions,
    codexCollaborationModeInstructions,
    turnInputText,
  ]
    .filter(Boolean)
    .join("\n\n");
  const totalWithDynamicToolJson = [textOnlyTotal, params.dynamicToolsJson].join("\n\n");

  return [
    "## Reconstructed Model-Bound Prompt Layers",
    "",
    "This is the deterministic model-bound layer stack OpenClaw can snapshot for the Codex happy path. It uses a pinned Codex `gpt-5.5` prompt fixture generated from Codex's model catalog/cache shape, then adds the Codex permission developer text, Codex thread config instructions when present, OpenClaw developer instructions, turn-scoped collaboration-mode instructions when OpenClaw provides them, turn input with OpenClaw runtime context, and the OpenClaw dynamic tool catalog. Codex can still add runtime-owned context such as native workspace `AGENTS.md`, environment context, memories, app/plugin instructions, and built-in collaboration-mode instructions inside the Codex runtime.",
    "",
    "### Layer Metadata",
    "",
    markdownFence(
      "json",
      stableJson({
        codexModelInstructions: {
          fixture: CODEX_MODEL_PROMPT_FIXTURE_PATH,
          source: codexModelSource,
        },
        codexPermissions: {
          sandbox: "danger-full-access",
          approvalPolicy: "never",
          networkAccess: "enabled",
        },
        openClawRuntime: {
          configInstructionsFrom: "extensions/codex app-server thread/start config.instructions",
          workspaceBootstrapContextFrom:
            "extensions/codex app-server turn/start input OpenClaw runtime context",
          developerInstructionsFrom:
            "extensions/codex app-server thread/start developerInstructions",
          collaborationModeDeveloperInstructionsFrom:
            "extensions/codex app-server turn/start collaborationMode.settings.developer_instructions",
          userInputFrom: "extensions/codex app-server turn/start input",
          dynamicToolsFrom: params.scenario.toolSnapshotFile,
        },
        limitations: [
          "This is a reconstructed prompt-layer snapshot, not a byte-for-byte raw OpenAI request captured from Codex core.",
          "Codex-owned workspace AGENTS.md, environment context, memories, app/plugin instructions, built-in Default collaboration-mode instructions, and provider tool serialization are still runtime-owned gaps until Codex exposes a rendered-prompt inspection API.",
        ],
      }),
    ),
    "",
    "### Rough Text Token Estimates",
    "",
    markdownFence(
      "json",
      stableJson({
        codexModelInstructions: textStats(codexModelInstructions),
        codexPermissionDeveloperInstructions: textStats(CODEX_YOLO_PERMISSION_INSTRUCTIONS),
        codexWorkspaceBootstrapConfigInstructions: textStats(codexConfigInstructions),
        openClawDeveloperInstructions: textStats(openClawDeveloperInstructions),
        codexCollaborationModeDeveloperInstructions: textStats(codexCollaborationModeInstructions),
        userInputText: textStats(turnInputText),
        dynamicToolsJson: textStats(params.dynamicToolsJson),
        totalTextOnly: textStats(textOnlyTotal),
        totalWithDynamicToolsJson: textStats(totalWithDynamicToolJson),
      }),
    ),
    "",
    `### System: Codex Model Instructions (${MODEL_ID}, ${CODEX_PROMPT_PERSONALITY})`,
    "",
    markdownFence("text", codexModelInstructions),
    "",
    "### Developer: Codex Permission Instructions",
    "",
    markdownFence("text", CODEX_YOLO_PERMISSION_INSTRUCTIONS),
    "",
    "### User: Codex Config Instructions",
    "",
    markdownFence("text", codexConfigInstructions),
    "",
    "### Developer: OpenClaw Runtime Instructions",
    "",
    markdownFence("text", openClawDeveloperInstructions),
    "",
    "### Developer: Codex Collaboration Mode Instructions",
    "",
    codexCollaborationModeInstructions
      ? markdownFence("text", codexCollaborationModeInstructions)
      : "This turn asks Codex app-server to resolve its built-in Default collaboration-mode instructions at runtime.",
    "",
    "### User: Turn Input Text",
    "",
    markdownFence("text", turnInputText),
    "",
    "### Tools: Dynamic Tool Catalog",
    "",
    `Full JSON: \`${params.scenario.toolSnapshotFile}\``,
    "",
  ];
}

function readCodexTurnInputText(turnStartParams: { input?: unknown }): string {
  const input = turnStartParams.input;
  if (!Array.isArray(input)) {
    return "";
  }
  const firstText = input.find(
    (item): item is { text: string } =>
      item !== null &&
      typeof item === "object" &&
      typeof (item as { text?: unknown }).text === "string",
  );
  return firstText?.text ?? "";
}

function buildCodexOpenClawRuntimeContext(): string {
  return [
    "OpenClaw runtime context for this turn:",
    "Treat this OpenClaw-provided context as supporting project/user reference for the current request.",
    "",
    "## OpenClaw Workspace Context",
    "",
    CODEX_WORKSPACE_BOOTSTRAP_PROMPT_CONTEXT,
  ].join("\n");
}

function prependCodexOpenClawRuntimeContext(prompt: string): string {
  return [buildCodexOpenClawRuntimeContext(), "", "Current user request:", prompt].join("\n");
}

function renderScenarioSnapshot(
  codexApi: CodexPromptSnapshotApi,
  scenario: PromptScenario,
): string {
  const attempt = createAttempt({
    scenario,
    sessionKey: scenario.ctx.SessionKey ?? `agent:main:${scenario.id}`,
  });
  const appServer = codexApi.resolveCodexPromptSnapshotAppServerOptions();
  const codexTurnPromptText = prependCodexOpenClawRuntimeContext(scenario.prompt);
  const codexSnapshot = codexApi.buildCodexHarnessPromptSnapshot({
    attempt,
    cwd: WORKSPACE_DIR,
    threadId: `thread-${scenario.id}`,
    dynamicTools: scenario.dynamicTools,
    appServer,
    config: CODEX_PROMPT_SNAPSHOT_THREAD_CONFIG,
    promptText: codexTurnPromptText,
    developerInstructionAdditions: CODEX_WORKSPACE_THREAD_DEVELOPER_INSTRUCTIONS,
    turnScopedDeveloperInstructions: CODEX_WORKSPACE_TURN_SCOPED_DEVELOPER_INSTRUCTIONS,
    heartbeatCollaborationInstructions:
      scenario.trigger === "heartbeat" ? CODEX_HEARTBEAT_COLLABORATION_INSTRUCTIONS : undefined,
  });
  const dynamicToolFunctions = flattenCodexDynamicToolSpecs(scenario.dynamicTools);
  const criticalToolSpecs = dynamicToolFunctions.filter((tool) =>
    ["message", "heartbeat_respond"].includes(tool.name),
  );
  const dynamicToolsJson = stableJson(scenario.dynamicTools);
  return [
    `# ${scenario.title}`,
    "",
    "<!-- Generated by `pnpm prompt:snapshots:gen`. Do not edit by hand. -->",
    "",
    "## Scope",
    "",
    ...scenario.notes.map((note) => `- ${note}`),
    "- This captures the OpenClaw-owned Codex app-server inputs and reconstructs the stable Codex model/permission layers from committed Codex prompt fixtures.",
    "- This also simulates Codex workspace bootstrap routing: `TOOLS.md` as inherited developer instructions, `SOUL.md`, `IDENTITY.md`, and `USER.md` as turn-scoped collaboration instructions, `MEMORY.md` in turn input, and `HEARTBEAT.md` as a heartbeat-only file pointer.",
    "",
    "## Scenario Metadata",
    "",
    markdownFence(
      "json",
      stableJson({
        harness: "codex",
        runtime: "codex_app_server",
        modelProvider: "openai",
        model: MODEL_ID,
        sourceReplyDeliveryMode: "message_tool_only",
        trigger: scenario.trigger,
        channel: scenario.ctx.Provider,
        chatType: scenario.ctx.ChatType,
        toolSnapshot: scenario.toolSnapshotFile,
        codexModelInstructionsFixture: CODEX_MODEL_PROMPT_FIXTURE_PATH,
        simulatedWorkspaceBootstrapFiles: CODEX_WORKSPACE_BOOTSTRAP_CONTEXT_FILES.map(
          (file) => file.path,
        ),
        simulatedWorkspaceDeveloperInstructionFiles:
          CODEX_WORKSPACE_THREAD_DEVELOPER_CONTEXT_FILES.map((file) => file.path),
        simulatedWorkspaceTurnScopedDeveloperInstructionFiles:
          CODEX_WORKSPACE_TURN_SCOPED_DEVELOPER_CONTEXT_FILES.map((file) => file.path),
        simulatedHeartbeatWorkspaceFile: CODEX_HEARTBEAT_CONTEXT_FILE.path,
      }),
    ),
    "",
    "## Effective OpenClaw Config",
    "",
    markdownFence("json", stableJson(baseConfig)),
    "",
    "## Thread Start Params",
    "",
    markdownFence("json", stableJson(selectedThreadStartParams(codexSnapshot.threadStartParams))),
    "",
    "## Thread Resume Params",
    "",
    markdownFence("json", stableJson(selectedThreadResumeParams(codexSnapshot.threadResumeParams))),
    "",
    "## Turn Start Params",
    "",
    markdownFence("json", stableJson(selectedTurnStartParams(codexSnapshot.turnStartParams))),
    "",
    ...renderModelBoundPromptLayers({ scenario, codexSnapshot, dynamicToolsJson }),
    "## Dynamic Tool Names",
    "",
    markdownFence("json", stableJson(dynamicToolFunctions.map((tool) => tool.name))),
    "",
    "## Critical Visible-Reply Tool Specs",
    "",
    markdownFence("json", stableJson(criticalToolSpecs)),
    "",
  ].join("\n");
}

function renderReadme(scenarios: PromptScenario[]): string {
  return [
    "# Codex Happy Path Prompt Snapshots",
    "",
    "<!-- Generated by `pnpm prompt:snapshots:gen`. Do not edit by hand. -->",
    "",
    "These fixtures capture the default OpenAI/Codex happy path for prompt review:",
    "",
    "- OpenAI model through the Codex harness and Codex app-server runtime.",
    "- Codex harness default coverage for tool-only visible source replies.",
    "- Telegram direct chat, Discord group chat, and a heartbeat turn with `heartbeat_respond` available through searchable dynamic tools.",
    "",
    "The Markdown files show selected app-server thread/turn params plus a reconstructed model-bound prompt layer stack: Codex `gpt-5.5` model instructions from a pinned Codex model catalog fixture, Codex permission developer instructions for the happy-path yolo profile, OpenClaw developer instructions, turn input with simulated OpenClaw workspace bootstrap runtime context, heartbeat collaboration-mode guidance when applicable, and references to the complete dynamic tool catalog.",
    "",
    "The workspace bootstrap simulation includes dummy workspace contents so prompt reviewers can see how OpenClaw routes stable profile files into Codex developer instructions, keeps `MEMORY.md` in turn input, and points heartbeat turns at `HEARTBEAT.md` without inlining it. `AGENTS.md` is intentionally not repeated here because Codex loads it natively.",
    "",
    "The tool catalog is pinned to the canonical happy-path OpenClaw tools so optional locally installed plugin tools do not create fixture churn.",
    "",
    "The Codex model prompt fixture is generated from the same Codex model catalog/cache shape that the Codex runtime uses for remote model metadata. Regenerate it from Codex's runtime cache or, when present, a local Codex checkout with:",
    "",
    markdownFence("sh", "pnpm prompt:snapshots:sync-codex-model"),
    "",
    "These snapshots are still not a byte-for-byte raw OpenAI request capture. Codex-owned native `AGENTS.md`, environment context, memories, app/plugin instructions, and built-in collaboration-mode instructions can be added inside the Codex runtime after OpenClaw sends thread and turn params.",
    "",
    "Regenerate with:",
    "",
    markdownFence("sh", "pnpm prompt:snapshots:gen"),
    "",
    "Check for drift with:",
    "",
    markdownFence("sh", "pnpm prompt:snapshots:check"),
    "",
    "Snapshots:",
    "",
    ...scenarios.map((scenario) => `- ${scenario.id}.md`),
    ...scenarios.map((scenario) => `- ${scenario.toolSnapshotFile}`),
    "",
    "Codex model prompt fixtures:",
    "",
    `- ${path.relative(
      CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR,
      CODEX_MODEL_PROMPT_FIXTURE_PATH,
    )}`,
    `- ${path.relative(
      CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR,
      CODEX_MODEL_PROMPT_SOURCE_PATH,
    )}`,
    "",
  ].join("\n");
}

/** Build all Codex happy-path prompt snapshot files without writing them. */
export async function createHappyPathPromptSnapshotFiles(): Promise<PromptSnapshotFile[]> {
  const codexApi = await loadCodexPromptSnapshotApi();
  const scenarios = await createScenarios(codexApi);
  const files = [
    {
      path: path.join(CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR, "README.md"),
      content: renderReadme(scenarios),
    },
    ...scenarios.map((scenario) => ({
      path: path.join(CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR, `${scenario.id}.md`),
      content: renderScenarioSnapshot(codexApi, scenario),
    })),
    ...scenarios.map((scenario) => ({
      path: path.join(CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR, scenario.toolSnapshotFile),
      content: stableJson(scenario.dynamicTools),
    })),
  ];
  return files.map((file) => ({
    path: file.path,
    content: file.content.endsWith("\n") ? file.content : `${file.content}\n`,
  }));
}
