import fs from "node:fs/promises";
import path from "node:path";
import {
  appendBootstrapPromptWarning,
  analyzeBootstrapBudget,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
} from "../../../src/agents/bootstrap-budget.js";
import { resolveBootstrapContextForRun } from "../../../src/agents/bootstrap-files.js";
import { buildEmbeddedSystemPrompt } from "../../../src/agents/pi-embedded-runner/system-prompt.js";
import { buildAgentSystemPrompt } from "../../../src/agents/system-prompt.js";
import { createStubTool } from "../../../src/agents/test-helpers/pi-tool-stubs.js";
import { buildGroupChatContext, buildGroupIntro } from "../../../src/auto-reply/reply/groups.js";
import {
  buildInboundMetaSystemPrompt,
  buildInboundUserContextPrefix,
} from "../../../src/auto-reply/reply/inbound-meta.js";
import type { TemplateContext } from "../../../src/auto-reply/templating.js";
import { SILENT_REPLY_TOKEN } from "../../../src/auto-reply/tokens.js";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../../../src/test-helpers/workspace.js";

export type PromptScenarioTurn = {
  id: string;
  label: string;
  systemPrompt: string;
  bodyPrompt: string;
  notes: string[];
};

export type PromptScenario = {
  scenario: string;
  focus: string;
  expectedStableSystemAfterTurnIds: string[];
  turns: PromptScenarioTurn[];
};

function buildCommonSystemParams(workspaceDir: string) {
  const toolNames = [
    "bash",
    "read",
    "edit",
    "grep",
    "glob",
    "message",
    "memory_search",
    "memory_get",
    "web_search",
    "x_search",
    "web_fetch",
  ];
  return {
    runtimeInfo: {
      agentId: "main",
      host: "cache-lab",
      repoRoot: workspaceDir,
      os: "Darwin 24.0.0",
      arch: "arm64",
      node: process.version,
      model: "anthropic/claude-sonnet-4-6",
      defaultModel: "anthropic/claude-sonnet-4-6",
      shell: "zsh",
    },
    userTimezone: "America/Los_Angeles",
    userTime: "Monday, March 16th, 2026 - 9:00 PM",
    userTimeFormat: "12" as const,
    toolNames,
  };
}

function buildSystemPrompt(params: {
  workspaceDir: string;
  extraSystemPrompt?: string;
  skillsPrompt?: string;
  reactionGuidance?: { level: "minimal" | "extensive"; channel: string };
  contextFiles?: Array<{ path: string; content: string }>;
}) {
  const { runtimeInfo, userTimezone, userTime, userTimeFormat, toolNames } =
    buildCommonSystemParams(params.workspaceDir);
  return buildAgentSystemPrompt({
    workspaceDir: params.workspaceDir,
    extraSystemPrompt: params.extraSystemPrompt,
    runtimeInfo,
    userTimezone,
    userTime,
    userTimeFormat,
    toolNames,
    modelAliasLines: [],
    promptMode: "full",
    acpEnabled: true,
    skillsPrompt: params.skillsPrompt,
    reactionGuidance: params.reactionGuidance,
    contextFiles: params.contextFiles,
  });
}

function buildAutoReplyBody(params: { ctx: TemplateContext; body: string; eventLine?: string }) {
  return [params.eventLine, buildInboundUserContextPrefix(params.ctx), params.body]
    .filter(Boolean)
    .join("\n\n");
}

async function readContextFiles(workspaceDir: string, fileNames: string[]) {
  return Promise.all(
    fileNames.map(async (fileName) => ({
      path: fileName,
      content: await fs.readFile(path.join(workspaceDir, fileName), "utf-8"),
    })),
  );
}

function buildAutoReplySystemPrompt(params: {
  workspaceDir: string;
  sessionCtx: TemplateContext;
  includeGroupChatContext?: boolean;
  includeGroupIntro?: boolean;
  groupSystemPrompt?: string;
}) {
  const extraSystemPromptParts = [
    buildInboundMetaSystemPrompt(params.sessionCtx),
    params.includeGroupChatContext ? buildGroupChatContext({ sessionCtx: params.sessionCtx }) : "",
    params.includeGroupIntro
      ? buildGroupIntro({
          cfg: {} as OpenClawConfig,
          sessionCtx: params.sessionCtx,
          defaultActivation: "mention",
          silentToken: SILENT_REPLY_TOKEN,
        })
      : "",
    params.groupSystemPrompt?.trim() ?? "",
  ].filter(Boolean);
  return buildSystemPrompt({
    workspaceDir: params.workspaceDir,
    extraSystemPrompt: extraSystemPromptParts.join("\n\n") || undefined,
  });
}

function buildToolRichSystemPrompt(params: {
  workspaceDir: string;
  skillsPrompt: string;
  contextFiles: Array<{ path: string; content: string }>;
}) {
  const { runtimeInfo, userTimezone, userTime, userTimeFormat } = buildCommonSystemParams(
    params.workspaceDir,
  );
  const tools = [
    "bash",
    "read",
    "edit",
    "grep",
    "glob",
    "message",
    "memory_search",
    "memory_get",
    "web_search",
    "x_search",
    "web_fetch",
  ].map((name) => Object.assign({}, createStubTool(name), { description: `${name} tool` }));
  return buildEmbeddedSystemPrompt({
    workspaceDir: params.workspaceDir,
    reasoningTagHint: false,
    runtimeInfo,
    tools,
    modelAliasLines: [],
    userTimezone,
    userTime,
    userTimeFormat,
    acpEnabled: true,
    skillsPrompt: params.skillsPrompt,
    reactionGuidance: { level: "extensive", channel: "Telegram" },
    contextFiles: params.contextFiles,
  });
}

function createDirectScenario(workspaceDir: string): PromptScenario {
  const baseCtx: TemplateContext = {
    Provider: "slack",
    Surface: "slack",
    OriginatingChannel: "slack",
    OriginatingTo: "D123",
    AccountId: "A1",
    ChatType: "direct",
    SenderId: "U1",
    SenderName: "Alice",
    Body: "hi",
    BodyStripped: "hi",
  };
  return {
    scenario: "auto-reply-direct",
    focus:
      "Normal direct-chat turns with ids, reply context, think hint, and runtime event body injection",
    expectedStableSystemAfterTurnIds: ["t2", "t3", "t4"],
    turns: [
      {
        id: "t1",
        label: "Direct turn with reply context",
        systemPrompt: buildAutoReplySystemPrompt({
          workspaceDir,
          sessionCtx: {
            ...baseCtx,
            MessageSid: "m1",
            ReplyToId: "r1",
            ReplyToBody: "prior message",
            WasMentioned: true,
          },
        }),
        bodyPrompt: buildAutoReplyBody({
          ctx: {
            ...baseCtx,
            MessageSid: "m1",
            ReplyToId: "r1",
            ReplyToBody: "prior message",
            WasMentioned: true,
          },
          body: "Please summarize yesterday's decision.",
        }),
        notes: ["Direct chat baseline", "Per-message ids and reply context change in body only"],
      },
      {
        id: "t2",
        label: "Direct turn with new message id",
        systemPrompt: buildAutoReplySystemPrompt({
          workspaceDir,
          sessionCtx: {
            ...baseCtx,
            MessageSid: "m2",
            ReplyToId: "r2",
          },
        }),
        bodyPrompt: buildAutoReplyBody({
          ctx: {
            ...baseCtx,
            MessageSid: "m2",
            ReplyToId: "r2",
          },
          body: "Now open the read tool and inspect AGENTS.md.",
        }),
        notes: ["Steady-state direct turn", "No runtime event"],
      },
      {
        id: "t3",
        label: "Direct turn with runtime event and think hint",
        systemPrompt: buildAutoReplySystemPrompt({
          workspaceDir,
          sessionCtx: {
            ...baseCtx,
            MessageSid: "m3",
            ReplyToId: "r3",
          },
        }),
        bodyPrompt: buildAutoReplyBody({
          ctx: {
            ...baseCtx,
            MessageSid: "m3",
            ReplyToId: "r3",
          },
          eventLine: "System: [t] Model switched.",
          body: "low use tools if needed and tell me which file controls startup behavior",
        }),
        notes: ["Touches runtime event body path", "Touches think-hint parsing path"],
      },
      {
        id: "t4",
        label: "Direct turn after runtime event",
        systemPrompt: buildAutoReplySystemPrompt({
          workspaceDir,
          sessionCtx: {
            ...baseCtx,
            MessageSid: "m4",
            ReplyToId: "r4",
          },
        }),
        bodyPrompt: buildAutoReplyBody({
          ctx: {
            ...baseCtx,
            MessageSid: "m4",
            ReplyToId: "r4",
          },
          body: "Repeat the startup file path only.",
        }),
        notes: ["Checks steady-state after event turn"],
      },
    ],
  };
}

function createGroupScenario(workspaceDir: string): PromptScenario {
  const baseCtx: TemplateContext = {
    Provider: "slack",
    Surface: "slack",
    OriginatingChannel: "slack",
    OriginatingTo: "C123",
    AccountId: "A1",
    ChatType: "group",
    GroupSubject: "ops",
    GroupChannel: "#ops",
    GroupMembers: "Bob, Cara, Dan, Eve",
    SenderId: "U2",
    SenderName: "Bob",
    Body: "hi",
    BodyStripped: "hi",
  };
  return {
    scenario: "auto-reply-group",
    focus: "Group chat bootstrap, steady state, and runtime event turns",
    expectedStableSystemAfterTurnIds: ["t3"],
    turns: [
      {
        id: "t1",
        label: "First group turn with one-time intro",
        systemPrompt: buildAutoReplySystemPrompt({
          workspaceDir,
          sessionCtx: {
            ...baseCtx,
            MessageSid: "g1",
            WasMentioned: true,
            InboundHistory: [{ sender: "Cara", timestamp: 1, body: "status?" }],
          },
          includeGroupChatContext: true,
          includeGroupIntro: true,
        }),
        bodyPrompt: buildAutoReplyBody({
          ctx: {
            ...baseCtx,
            MessageSid: "g1",
            WasMentioned: true,
            InboundHistory: [{ sender: "Cara", timestamp: 1, body: "status?" }],
          },
          body: "Can you investigate this issue?",
        }),
        notes: ["Expected first-turn bootstrap churn", "Not steady-state"],
      },
      {
        id: "t2",
        label: "Steady-state group turn",
        systemPrompt: buildAutoReplySystemPrompt({
          workspaceDir,
          sessionCtx: {
            ...baseCtx,
            MessageSid: "g2",
            WasMentioned: false,
            InboundHistory: [
              { sender: "Cara", timestamp: 1, body: "status?" },
              { sender: "Dan", timestamp: 2, body: "please help" },
            ],
          },
          includeGroupChatContext: true,
        }),
        bodyPrompt: buildAutoReplyBody({
          ctx: {
            ...baseCtx,
            MessageSid: "g2",
            WasMentioned: false,
            InboundHistory: [
              { sender: "Cara", timestamp: 1, body: "status?" },
              { sender: "Dan", timestamp: 2, body: "please help" },
            ],
          },
          body: "Give a short update.",
        }),
        notes: ["One-time intro gone", "Should settle afterward"],
      },
      {
        id: "t3",
        label: "Group turn with runtime event",
        systemPrompt: buildAutoReplySystemPrompt({
          workspaceDir,
          sessionCtx: {
            ...baseCtx,
            MessageSid: "g2",
            WasMentioned: false,
            InboundHistory: [
              { sender: "Cara", timestamp: 1, body: "status?" },
              { sender: "Dan", timestamp: 2, body: "please help" },
            ],
          },
          includeGroupChatContext: true,
        }),
        bodyPrompt: buildAutoReplyBody({
          ctx: {
            ...baseCtx,
            MessageSid: "g3",
            WasMentioned: true,
            InboundHistory: [
              { sender: "Cara", timestamp: 1, body: "status?" },
              { sender: "Dan", timestamp: 2, body: "please help" },
              { sender: "Eve", timestamp: 3, body: "what changed?" },
            ],
          },
          eventLine: "System: [t] Node connected.",
          body: "Tell the room whether tools are available.",
        }),
        notes: ["Runtime event lands in body", "System prompt should stay stable vs t2"],
      },
    ],
  };
}

async function createToolRichScenario(workspaceDir: string): Promise<PromptScenario> {
  const skillsPrompt = [
    "<available_skills>",
    "<skill><name>checks</name><description>Run checks before landing changes.</description><location>/skills/checks/SKILL.md</location></skill>",
    "<skill><name>release</name><description>Release OpenClaw safely.</description><location>/skills/release/SKILL.md</location></skill>",
    "</available_skills>",
  ].join("\n");
  const contextFiles = await readContextFiles(workspaceDir, ["AGENTS.md", "TOOLS.md", "SOUL.md"]);
  const systemPrompt = buildToolRichSystemPrompt({
    workspaceDir,
    skillsPrompt,
    contextFiles,
  });
  return {
    scenario: "tool-rich-agent-run",
    focus:
      "Tool-enabled system prompt with skills, reactions, workspace bootstrap, and a follow-up after fictional tool calls",
    expectedStableSystemAfterTurnIds: ["t2"],
    turns: [
      {
        id: "t1",
        label: "Tool-rich turn asking for search, read, and file edits",
        systemPrompt,
        bodyPrompt: [
          "Conversation info (untrusted metadata):",
          "```json",
          JSON.stringify({ message_id: "tool-1", sender_id: "U9", was_mentioned: true }, null, 2),
          "```",
          "",
          "high Search the workspace, read AGENTS.md, inspect the failing test, and propose a patch.",
        ].join("\n"),
        notes: ["Touches tool list in system prompt", "Touches high-thinking hint in body"],
      },
      {
        id: "t2",
        label: "Follow-up after a fictional tool call",
        systemPrompt,
        bodyPrompt: [
          "Conversation info (untrusted metadata):",
          "```json",
          JSON.stringify({ message_id: "tool-2", sender_id: "U9" }, null, 2),
          "```",
          "",
          "Tool transcript summary (untrusted, for context):",
          "```json",
          JSON.stringify(
            [
              { role: "assistant", action: "tool_use", name: "read", target: "AGENTS.md" },
              { role: "tool", name: "read", result: "Loaded AGENTS.md" },
              { role: "assistant", action: "tool_use", name: "grep", target: "failing test" },
              { role: "tool", name: "grep", result: "Matched src/foo.ts:42" },
            ],
            null,
            2,
          ),
          "```",
          "",
          "Continue and explain the root cause.",
        ].join("\n"),
        notes: ["Simulates tool-call-heavy conversation", "System prompt should stay stable"],
      },
    ],
  };
}

async function createBootstrapWarningScenario(workspaceDir: string): Promise<PromptScenario> {
  const bootstrapConfig = {
    agents: {
      defaults: {
        bootstrapMaxChars: 1_500,
        bootstrapTotalMaxChars: 2_200,
      },
    },
  } satisfies OpenClawConfig;
  const largeAgents = "# AGENTS.md\n\n" + "Rules.\n".repeat(5_000);
  const largeTools = "# TOOLS.md\n\n" + "Notes.\n".repeat(3_000);
  await writeWorkspaceFile({ dir: workspaceDir, name: "AGENTS.md", content: largeAgents });
  await writeWorkspaceFile({ dir: workspaceDir, name: "TOOLS.md", content: largeTools });
  const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun({
    workspaceDir,
    config: bootstrapConfig,
  });
  const analysis = analyzeBootstrapBudget({
    files: buildBootstrapInjectionStats({
      bootstrapFiles,
      injectedFiles: contextFiles,
    }),
    bootstrapMaxChars: bootstrapConfig.agents.defaults.bootstrapMaxChars,
    bootstrapTotalMaxChars: bootstrapConfig.agents.defaults.bootstrapTotalMaxChars,
  });
  if (!analysis.hasTruncation) {
    throw new Error("bootstrap-warning scenario expected truncated bootstrap context");
  }
  const warningFirst = buildBootstrapPromptWarning({
    analysis,
    mode: "once",
    seenSignatures: [],
  });
  const warningSeen = buildBootstrapPromptWarning({
    analysis,
    mode: "once",
    seenSignatures: warningFirst.warningSignaturesSeen,
    previousSignature: warningFirst.signature,
  });
  const warningAlways = buildBootstrapPromptWarning({
    analysis,
    mode: "always",
    seenSignatures: warningFirst.warningSignaturesSeen,
    previousSignature: warningFirst.signature,
  });
  return {
    scenario: "bootstrap-warning",
    focus: "Workspace bootstrap truncation warnings inside # Project Context",
    expectedStableSystemAfterTurnIds: ["t2", "t3"],
    turns: [
      {
        id: "t1",
        label: "First warning emission",
        systemPrompt: buildSystemPrompt({
          workspaceDir,
          contextFiles,
        }),
        bodyPrompt: appendBootstrapPromptWarning("hello", warningFirst.lines),
        notes: ["Warning is appended to the turn body", "System prompt should stay stable"],
      },
      {
        id: "t2",
        label: "Same truncation signature after once-mode dedupe",
        systemPrompt: buildSystemPrompt({
          workspaceDir,
          contextFiles,
        }),
        bodyPrompt: appendBootstrapPromptWarning("hello again", warningSeen.lines),
        notes: ["Once-mode removes warning lines", "Only the body tail changes now"],
      },
      {
        id: "t3",
        label: "Always-mode warning",
        systemPrompt: buildSystemPrompt({
          workspaceDir,
          contextFiles,
        }),
        bodyPrompt: appendBootstrapPromptWarning("one more turn", warningAlways.lines),
        notes: [
          "Always-mode keeps warning in the body prompt tail",
          "System prompt remains stable",
        ],
      },
    ],
  };
}

async function createMaintenanceScenario(workspaceDir: string): Promise<PromptScenario> {
  await writeWorkspaceFile({
    dir: workspaceDir,
    name: "AGENTS.md",
    content: [
      "## Session Startup",
      "Read AGENTS.md and MEMORY.md before responding.",
      "",
      "## Red Lines",
      "Do not delete production data.",
      "",
      "## Safety",
      "Never reveal secrets.",
    ].join("\n"),
  });
  const memoryFlushPrompt = [
    "Pre-compaction memory flush.",
    "Store durable memories only in memory/2026-03-15.md (create memory/ if needed).",
    "Treat workspace bootstrap/reference files such as MEMORY.md, SOUL.md, TOOLS.md, and AGENTS.md as read-only during this flush; never overwrite, replace, or edit them.",
    "If nothing to store, reply with NO_REPLY.",
    "Current time: Sunday, March 15th, 2026 - 9:30 PM (America/Los_Angeles) / 2026-03-16 04:30 UTC",
  ].join("\n");
  const memoryFlushSystemPrompt = buildSystemPrompt({
    workspaceDir,
    extraSystemPrompt: [
      "Pre-compaction memory flush turn.",
      "The session is near auto-compaction; capture durable memories to disk.",
      "Store durable memories only in memory/YYYY-MM-DD.md (create memory/ if needed).",
      "You may reply, but usually NO_REPLY is correct.",
    ].join(" "),
  });
  const postCompaction = [
    "[Post-compaction context refresh]",
    "",
    "Session was just compacted. The conversation summary above is a hint, NOT a substitute for your startup sequence.",
    "",
    "Critical rules from AGENTS.md:",
    "",
    "## Session Startup",
    "Read AGENTS.md and MEMORY.md before responding.",
    "",
    "## Red Lines",
    "Do not delete production data.",
    "",
    "Current time: Sunday, March 15th, 2026 - 9:30 PM (America/Los_Angeles) / 2026-03-16 04:30 UTC",
  ].join("\n");
  const postCompactionSystemPrompt = buildSystemPrompt({
    workspaceDir,
    extraSystemPrompt: buildInboundMetaSystemPrompt({
      Provider: "slack",
      Surface: "slack",
      OriginatingChannel: "slack",
      OriginatingTo: "D123",
      AccountId: "A1",
      ChatType: "direct",
    }),
  });
  return {
    scenario: "maintenance-prompts",
    focus: "Memory flush and post-compaction maintenance prompts",
    expectedStableSystemAfterTurnIds: [],
    turns: [
      {
        id: "t1",
        label: "Pre-compaction memory flush run",
        systemPrompt: memoryFlushSystemPrompt,
        bodyPrompt: memoryFlushPrompt,
        notes: [
          "Writes to memory/2026-03-15.md",
          "Separate maintenance run; expected to differ from normal user turns",
        ],
      },
      {
        id: "t2",
        label: "Post-compaction refresh context run",
        systemPrompt: postCompactionSystemPrompt,
        bodyPrompt: postCompaction,
        notes: [
          "Separate maintenance context payload",
          "Expected to differ from normal user turns",
        ],
      },
    ],
  };
}

export async function createWorkspaceWithPromptCompositionFiles(): Promise<string> {
  const workspaceDir = await makeTempWorkspace("openclaw-prompt-cache-");
  await writeWorkspaceFile({
    dir: workspaceDir,
    name: "AGENTS.md",
    content: [
      "# AGENTS.md",
      "",
      "## Session Startup",
      "Read AGENTS.md and TOOLS.md before making changes.",
      "",
      "## Red Lines",
      "Do not rewrite user commits.",
    ].join("\n"),
  });
  await writeWorkspaceFile({
    dir: workspaceDir,
    name: "TOOLS.md",
    content: "# TOOLS.md\n\nUse rg before grep.\n",
  });
  await writeWorkspaceFile({
    dir: workspaceDir,
    name: "SOUL.md",
    content: "# SOUL.md\n\nBe concise but kind.\n",
  });
  return workspaceDir;
}

export async function createPromptCompositionScenarios(): Promise<{
  workspaceDir: string;
  warningWorkspaceDir: string;
  scenarios: PromptScenario[];
  cleanup: () => Promise<void>;
}> {
  const workspaceDir = await createWorkspaceWithPromptCompositionFiles();
  const warningWorkspaceDir = await makeTempWorkspace("openclaw-prompt-cache-warning-");
  const scenarios = [
    createDirectScenario(workspaceDir),
    createGroupScenario(workspaceDir),
    await createToolRichScenario(workspaceDir),
    await createBootstrapWarningScenario(warningWorkspaceDir),
    await createMaintenanceScenario(workspaceDir),
  ];
  return {
    workspaceDir,
    warningWorkspaceDir,
    scenarios,
    cleanup: async () => {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      await fs.rm(warningWorkspaceDir, { recursive: true, force: true });
    },
  };
}
