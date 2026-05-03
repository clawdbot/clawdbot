import fs from "node:fs";
import path from "node:path";
import type { Api, Model } from "@mariozechner/pi-ai";
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
import { buildReplyPromptBodies } from "../../../src/auto-reply/reply/prompt-prelude.js";
import type { TemplateContext } from "../../../src/auto-reply/templating.js";
import { SILENT_REPLY_TOKEN } from "../../../src/auto-reply/tokens.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import type {
  AnyAgentTool,
  EmbeddedRunAttemptParams,
} from "../../../src/plugin-sdk/agent-harness-runtime.js";
import { normalizeAgentRuntimeTools } from "../../../src/plugin-sdk/agent-harness-runtime.js";
import { createOpenClawCodingTools } from "../../../src/plugin-sdk/agent-harness.js";
import { loadBundledPluginTestApiSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

export const CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR =
  "test/fixtures/agents/prompt-snapshots/codex-runtime-happy-path";
export const CODEX_MODEL_PROMPT_FIXTURE_DIR =
  "test/fixtures/agents/prompt-snapshots/codex-model-catalog";

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
  "canvas",
  "nodes",
  "cron",
  "message",
  "heartbeat_respond",
  "tts",
  "gateway",
  "agents_list",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
  "session_status",
  "web_search",
  "web_fetch",
]);

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
  }) => {
    developerInstructions: string;
    threadStartParams: Record<string, unknown>;
    threadResumeParams: Record<string, unknown>;
    turnStartParams: Record<string, unknown>;
  };
  createCodexDynamicToolSpecsForPromptSnapshot: (params: {
    tools: AnyAgentTool[];
    pluginConfig?: { codexDynamicToolsProfile?: "native-first" | "openclaw-compat" };
  }) => CodexDynamicToolSpec[];
};

type CodexDynamicToolSpec = {
  name: string;
  description?: string;
  inputSchema?: unknown;
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

const codexApi = loadBundledPluginTestApiSync("codex") as CodexPromptSnapshotApi;

const CODEX_WORKSPACE_BOOTSTRAP_CONTEXT_FILES = [
  {
    path: path.join(WORKSPACE_DIR, "SOUL.md"),
    content: "<SOUL.md contents will be here>",
  },
  {
    path: path.join(WORKSPACE_DIR, "TOOLS.md"),
    content: "<TOOLS.md contents will be here>",
  },
  {
    path: path.join(WORKSPACE_DIR, "HEARTBEAT.md"),
    content: "<HEARTBEAT.md contents will be here>",
  },
] as const;

const CODEX_WORKSPACE_BOOTSTRAP_INSTRUCTIONS = [
  "OpenClaw loaded these user-editable workspace files. Treat them as project/user context. Codex loads AGENTS.md natively, so AGENTS.md is not repeated here.",
  "",
  "# Project Context",
  "",
  "The following project context files have been loaded:",
  "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
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

const CODEX_WORKSPACE_BOOTSTRAP_CONFIG = {
  instructions: CODEX_WORKSPACE_BOOTSTRAP_INSTRUCTIONS,
};

const baseConfig: OpenClawConfig = {
  messages: {
    visibleReplies: "message_tool",
    groupChat: {
      visibleReplies: "message_tool",
    },
  },
  agents: {
    defaults: {
      heartbeat: {
        enabled: true,
        every: "30m",
      },
    },
  },
  tools: {
    profiles: {
      coding: {
        allow: [
          "message",
          "heartbeat_respond",
          "sessions_spawn",
          "sessions_list",
          "sessions_yield",
          "cron",
          "memory_search",
          "memory_get",
          "session_status",
        ],
      },
    },
  },
};

const happyPathModel = {
  id: MODEL_ID,
  provider: "openai",
  api: "responses",
  input: ["text"],
  contextWindow: 272_000,
} as unknown as Model<Api>;

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
  return buildReplyPromptBodies({
    ctx,
    sessionCtx: ctx,
    effectiveBaseBody: [inboundUserContext, body].filter(Boolean).join("\n\n"),
    prefixedBody: [inboundUserContext, body].filter(Boolean).join("\n\n"),
  }).prefixedCommandBody;
}

function createExtraSystemPrompt(params: {
  ctx: TemplateContext;
  chatContext: string;
  intro?: string;
}): string {
  return [
    buildInboundMetaSystemPrompt(params.ctx),
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
  ctx: TemplateContext;
  trigger: "user" | "heartbeat";
}): CodexDynamicToolSpec[] {
  const tools = createOpenClawCodingTools({
    agentId: "main",
    workspaceDir: WORKSPACE_DIR,
    agentDir: AGENT_DIR,
    config: baseConfig,
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
  });
  const normalized = normalizeAgentRuntimeTools({
    tools,
    runtimePlan: undefined,
    provider: "codex",
    config: baseConfig,
    workspaceDir: WORKSPACE_DIR,
    env: {},
    modelId: MODEL_ID,
    modelApi: "responses",
    model: happyPathModel,
  });
  return codexApi.createCodexDynamicToolSpecsForPromptSnapshot({
    tools: normalized.filter((tool) => HAPPY_PATH_TOOL_NAMES.has(tool.name)),
    pluginConfig: { codexDynamicToolsProfile: "native-first" },
  });
}

function createScenarios(): PromptScenario[] {
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
  const telegramDirectTools = createDynamicTools({ ctx: telegramDirectCtx, trigger: "user" });
  const discordGroupTools = createDynamicTools({ ctx: discordGroupCtx, trigger: "user" });
  const heartbeatTools = createDynamicTools({ ctx: heartbeatCtx, trigger: "heartbeat" });

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
          silentReplyPolicy: "disallow",
          silentReplyRewrite: false,
          silentToken: SILENT_REPLY_TOKEN,
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
          silentReplyRewrite: false,
          silentToken: SILENT_REPLY_TOKEN,
        }),
        intro: buildGroupIntro({
          cfg: baseConfig,
          sessionCtx: discordGroupCtx,
          defaultActivation: "mention",
          silentToken: SILENT_REPLY_TOKEN,
          silentReplyPolicy: "allow",
          silentReplyRewrite: false,
        }),
      }),
      dynamicTools: discordGroupTools,
      toolSnapshotFile: "codex-dynamic-tools.discord-group.json",
    },
    {
      id: "telegram-heartbeat-codex-tool",
      title: "Telegram Direct Codex Heartbeat Tool Turn",
      notes: [
        "Heartbeat happy path: Codex receives the structured `heartbeat_respond` dynamic tool because `messages.visibleReplies` is `message_tool`.",
        "The heartbeat tool carries the notify/no-notify decision, outcome, summary, and optional notification text instead of relying only on final-text parsing.",
      ],
      trigger: "heartbeat",
      ctx: heartbeatCtx,
      prompt: createPrompt(heartbeatCtx, heartbeatCtx.BodyStripped ?? heartbeatCtx.Body ?? ""),
      extraSystemPrompt: createExtraSystemPrompt({
        ctx: heartbeatCtx,
        chatContext: buildDirectChatContext({
          sessionCtx: heartbeatCtx,
          sourceReplyDeliveryMode: "message_tool_only",
          silentReplyPolicy: "disallow",
          silentReplyRewrite: false,
          silentToken: SILENT_REPLY_TOKEN,
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
      ? value.dynamicTools.map((tool) =>
          tool && typeof tool === "object" && "name" in tool
            ? (tool as { name?: unknown }).name
            : tool,
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
  const textOnlyTotal = [
    codexModelInstructions,
    CODEX_YOLO_PERMISSION_INSTRUCTIONS,
    codexConfigInstructions,
    openClawDeveloperInstructions,
    params.scenario.prompt,
  ]
    .filter(Boolean)
    .join("\n\n");
  const totalWithDynamicToolJson = [textOnlyTotal, params.dynamicToolsJson].join("\n\n");

  return [
    "## Reconstructed Model-Bound Prompt Layers",
    "",
    "This is the deterministic model-bound layer stack OpenClaw can snapshot for the Codex happy path. It uses a pinned Codex `gpt-5.5` prompt fixture generated from Codex's model catalog/cache shape, then adds the Codex permission developer text, simulated OpenClaw workspace bootstrap config instructions, OpenClaw developer instructions, turn input, and the OpenClaw dynamic tool catalog. Codex can still add runtime-owned context such as native workspace `AGENTS.md`, environment context, memories, app/plugin instructions, and future collaboration-mode instructions inside the Codex runtime.",
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
          developerInstructionsFrom:
            "extensions/codex app-server thread/start developerInstructions",
          userInputFrom: "extensions/codex app-server turn/start input",
          dynamicToolsFrom: params.scenario.toolSnapshotFile,
        },
        limitations: [
          "This is a reconstructed prompt-layer snapshot, not a byte-for-byte raw OpenAI request captured from Codex core.",
          "Codex-owned workspace AGENTS.md, environment context, memories, app/plugin instructions, and provider tool serialization are still runtime-owned gaps until Codex exposes a rendered-prompt inspection API.",
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
        userInputText: textStats(params.scenario.prompt),
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
    "### User: Codex Config Instructions (OpenClaw Workspace Bootstrap Context)",
    "",
    markdownFence("text", codexConfigInstructions),
    "",
    "### Developer: OpenClaw Runtime Instructions",
    "",
    markdownFence("text", openClawDeveloperInstructions),
    "",
    "### User: Turn Input Text",
    "",
    markdownFence("text", params.scenario.prompt),
    "",
    "### Tools: Dynamic Tool Catalog",
    "",
    `Full JSON: \`${params.scenario.toolSnapshotFile}\``,
    "",
  ];
}

function renderScenarioSnapshot(scenario: PromptScenario): string {
  const attempt = createAttempt({
    scenario,
    sessionKey: scenario.ctx.SessionKey ?? `agent:main:${scenario.id}`,
  });
  const appServer = codexApi.resolveCodexPromptSnapshotAppServerOptions({
    codexDynamicToolsProfile: "native-first",
  });
  const codexSnapshot = codexApi.buildCodexHarnessPromptSnapshot({
    attempt,
    cwd: WORKSPACE_DIR,
    threadId: `thread-${scenario.id}`,
    dynamicTools: scenario.dynamicTools,
    appServer,
    config: CODEX_WORKSPACE_BOOTSTRAP_CONFIG,
    promptText: scenario.prompt,
  });
  const criticalToolSpecs = scenario.dynamicTools.filter((tool) =>
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
    "- This also simulates workspace bootstrap files forwarded through Codex `config.instructions`: `SOUL.md`, `TOOLS.md`, and `HEARTBEAT.md`.",
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
    markdownFence("json", stableJson(scenario.dynamicTools.map((tool) => tool.name))),
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
    '- `messages.visibleReplies: "message_tool"`, which is the Codex-harness default for visible source replies.',
    "- Telegram direct chat, Discord group chat, and a heartbeat turn with `heartbeat_respond` available.",
    "",
    "The Markdown files show selected app-server thread/turn params plus a reconstructed model-bound prompt layer stack: Codex `gpt-5.5` model instructions from a pinned Codex model catalog fixture, Codex permission developer instructions for the happy-path yolo profile, simulated OpenClaw workspace bootstrap config instructions, OpenClaw developer instructions, user turn input, and references to the complete dynamic tool catalog.",
    "",
    "The workspace bootstrap simulation includes dummy `SOUL.md`, `TOOLS.md`, and `HEARTBEAT.md` contents so prompt reviewers can see how those OpenClaw project/user context files are forwarded to Codex. `AGENTS.md` is intentionally not repeated here because Codex loads it natively.",
    "",
    "The tool catalog is pinned to the canonical happy-path OpenClaw tools so optional locally installed plugin tools do not create fixture churn.",
    "",
    "The Codex model prompt fixture is generated from the same Codex model catalog/cache shape that the Codex runtime uses for remote model metadata. Regenerate it from Codex's runtime cache or, when present, a local Codex checkout with:",
    "",
    markdownFence("sh", "pnpm prompt:snapshots:sync-codex-model"),
    "",
    "These snapshots are still not a byte-for-byte raw OpenAI request capture. Codex-owned native `AGENTS.md`, environment context, memories, app/plugin instructions, and future collaboration-mode instructions can be added inside the Codex runtime after OpenClaw sends thread and turn params.",
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

export function createHappyPathPromptSnapshotFiles(): PromptSnapshotFile[] {
  const scenarios = createScenarios();
  return [
    {
      path: path.join(CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR, "README.md"),
      content: renderReadme(scenarios),
    },
    ...scenarios.map((scenario) => ({
      path: path.join(CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR, `${scenario.id}.md`),
      content: renderScenarioSnapshot(scenario),
    })),
    ...scenarios.map((scenario) => ({
      path: path.join(CODEX_RUNTIME_HAPPY_PATH_PROMPT_SNAPSHOT_DIR, scenario.toolSnapshotFile),
      content: stableJson(scenario.dynamicTools),
    })),
  ].map((file) => ({
    ...file,
    content: file.content.endsWith("\n") ? file.content : `${file.content}\n`,
  }));
}
