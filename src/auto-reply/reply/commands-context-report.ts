// Builds structured context reports for context command responses.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionAgentIds } from "../../agents/agent-scope.js";
import { analyzeBootstrapBudget } from "../../agents/bootstrap-budget.js";
import { isRealConversationMessage } from "../../agents/compaction-real-conversation.js";
import {
  resolveBootstrapMaxChars,
  resolveBootstrapTotalMaxChars,
} from "../../agents/embedded-agent-helpers/bootstrap.js";
import {
  createMessageCharEstimateCache,
  estimateMessageCharsCached,
} from "../../agents/embedded-agent-runner/tool-result-char-estimator.js";
import type { AgentMessage } from "../../agents/runtime/index.js";
import { buildSystemPromptReport } from "../../agents/system-prompt-report.js";
import {
  resolveFreshSessionTotalTokens,
  type SessionEntry,
  type SessionSystemPromptReport,
} from "../../config/sessions/types.js";
import { readSessionMessages } from "../../gateway/session-utils.fs.js";
import { estimateTokensFromChars } from "../../utils/cjk-chars.js";
import type { ReplyPayload } from "../types.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { renderContextTreemapPng } from "./context-treemap.js";

function formatInt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

function formatCharsAndTokens(chars: number): string {
  return `${formatInt(chars)} chars (~${formatInt(estimateTokensFromChars(chars))} tok)`;
}

function parseContextArgs(commandBodyNormalized: string): string {
  if (commandBodyNormalized === "/context") {
    return "";
  }
  if (commandBodyNormalized.startsWith("/context ")) {
    return commandBodyNormalized.slice(8).trim();
  }
  return "";
}

function formatListTop(
  entries: Array<{ name: string; value: number }>,
  cap: number,
): { lines: string[]; omitted: number } {
  const sorted = [...entries].toSorted((a, b) => b.value - a.value);
  const top = sorted.slice(0, cap);
  const omitted = Math.max(0, sorted.length - top.length);
  const lines = top.map((e) => `- ${e.name}: ${formatCharsAndTokens(e.value)}`);
  return { lines, omitted };
}

function resolveRunContextReport(params: HandleCommandsParams): SessionSystemPromptReport | null {
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  const existing = targetSessionEntry?.systemPromptReport;
  return existing?.source === "run" ? existing : null;
}

function resolveContextReportAgentId(params: HandleCommandsParams): string {
  return resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.cfg,
    agentId: params.agentId,
  }).sessionAgentId;
}

type TranscriptCompactabilityReport =
  | {
      available: true;
      totalMessages: number;
      realConversationMessages: number;
    }
  | {
      available: false;
      reason: string;
    };

function resolveTranscriptCompactabilityReport(
  params: HandleCommandsParams,
  targetSessionEntry: SessionEntry | undefined,
): TranscriptCompactabilityReport {
  const sessionId = targetSessionEntry?.sessionId?.trim();
  if (!sessionId) {
    return { available: false, reason: "no active transcript session" };
  }

  const messages = readSessionMessages(
    sessionId,
    params.storePath,
    targetSessionEntry?.sessionFile,
  ) as AgentMessage[];
  if (!messages.length) {
    return { available: false, reason: "no transcript messages found" };
  }

  const realConversationMessages = messages.reduce(
    (count, message, index) =>
      count + (isRealConversationMessage(message, messages, index) ? 1 : 0),
    0,
  );
  return {
    available: true,
    totalMessages: messages.length,
    realConversationMessages,
  };
}

async function resolveContextReport(
  params: HandleCommandsParams,
): Promise<SessionSystemPromptReport> {
  const runReport = resolveRunContextReport(params);
  if (runReport) {
    return runReport;
  }

  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  const sessionAgentId = resolveContextReportAgentId(params);
  const bootstrapMaxChars = resolveBootstrapMaxChars(params.cfg, sessionAgentId);
  const bootstrapTotalMaxChars = resolveBootstrapTotalMaxChars(params.cfg, sessionAgentId);
  const { resolveCommandsSystemPromptBundle } = await import("./commands-system-prompt.js");
  const { systemPrompt, tools, skillsPrompt, bootstrapFiles, injectedFiles, sandboxRuntime } =
    await resolveCommandsSystemPromptBundle(params);

  return buildSystemPromptReport({
    source: "estimate",
    generatedAt: Date.now(),
    sessionId: targetSessionEntry?.sessionId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    model: params.model,
    workspaceDir: params.workspaceDir,
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
    sandbox: { mode: sandboxRuntime.mode, sandboxed: sandboxRuntime.sandboxed },
    systemPrompt,
    bootstrapFiles,
    injectedFiles,
    skillsPrompt,
    tools,
  });
}

export async function buildContextReply(params: HandleCommandsParams): Promise<ReplyPayload> {
  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;
  const args = parseContextArgs(params.command.commandBodyNormalized);
  const sub = normalizeLowercaseStringOrEmpty(args.split(/\s+/).find(Boolean));

  if (!sub || sub === "help") {
    return {
      text: [
        "🧠 /context",
        "",
        "What counts as context (high-level), plus a breakdown mode.",
        "",
        "Try:",
        "- /context list   (short breakdown)",
        "- /context detail (per-file + per-tool + per-skill + system prompt size + compactable transcript counts)",
        "- /context map    (WinDirStat-style treemap image)",
        "- /context json   (same, machine-readable)",
        "",
        "Inline shortcut = a command token inside a normal message (e.g. “hey /status”). It runs immediately (allowlisted senders only) and is stripped before the model sees the remaining text.",
      ].join("\n"),
    };
  }

  const cachedContextUsageTokens = resolveFreshSessionTotalTokens(targetSessionEntry);
  const session = {
    totalTokens: targetSessionEntry?.totalTokens ?? null,
    totalTokensFresh: targetSessionEntry?.totalTokensFresh ?? null,
    inputTokens: targetSessionEntry?.inputTokens ?? null,
    outputTokens: targetSessionEntry?.outputTokens ?? null,
    contextTokens: params.contextTokens ?? null,
  } as const;

  if (sub === "map") {
    const report = resolveRunContextReport(params);
    if (!report) {
      return {
        text: [
          "Context treemap unavailable.",
          "No actual run context is cached for this session yet.",
          "Send a normal message, then run /context map again.",
        ].join("\n"),
      };
    }
    const sessionId = targetSessionEntry?.sessionId?.trim();
    const messages = sessionId
      ? (readSessionMessages(
          sessionId,
          params.storePath,
          targetSessionEntry?.sessionFile,
        ) as AgentMessage[])
      : [];
    const estimateCache = createMessageCharEstimateCache();
    const conversationTotals = messages.reduce(
      (totals, message) => {
        const chars = estimateMessageCharsCached(message, estimateCache);
        if (chars === 0) {
          return totals;
        }
        if (message.role === "user") {
          totals.user += chars;
        } else if (message.role === "assistant") {
          totals.assistant += chars;
        } else if (message.role === "toolResult") {
          totals.toolResults += chars;
        } else if (message.role === "branchSummary" || message.role === "compactionSummary") {
          totals.summaries += chars;
        } else {
          totals.other += chars;
        }
        return totals;
      },
      { user: 0, assistant: 0, toolResults: 0, summaries: 0, other: 0 },
    );
    const conversation = [
      { name: "User", value: conversationTotals.user },
      { name: "Assistant", value: conversationTotals.assistant },
      { name: "Tool results", value: conversationTotals.toolResults },
      { name: "Summaries", value: conversationTotals.summaries },
      { name: "Other", value: conversationTotals.other },
      // Runtime context and hook prompt additions reach only the model, never
      // the transcript; without these leaves the map undercounts model-visible
      // context. The persisted turn prompt is already counted above.
      { name: "Runtime context", value: report.currentTurn?.runtimeContextChars ?? 0 },
      { name: "Model-only prompt", value: report.currentTurn?.modelOnlyPromptChars ?? 0 },
    ].filter((leaf) => leaf.value > 0);
    const treemap = await renderContextTreemapPng({
      report,
      session: {
        cachedContextTokens: cachedContextUsageTokens ?? null,
        contextWindowTokens: session.contextTokens,
      },
      conversation,
    });
    return {
      text: treemap.caption,
      mediaUrl: treemap.path,
      trustedLocalMedia: true,
      sensitiveMedia: true,
    };
  }

  const report = await resolveContextReport(params);

  if (sub === "json") {
    return { text: JSON.stringify({ report, session }, null, 2) };
  }

  if (sub !== "list" && sub !== "show" && sub !== "detail" && sub !== "deep") {
    return {
      text: [
        "Unknown /context mode.",
        "Use: /context, /context list, /context detail, /context map, or /context json",
      ].join("\n"),
    };
  }

  const fileLines = report.injectedWorkspaceFiles.map((f) => {
    const status = f.missing ? "MISSING" : f.truncated ? "TRUNCATED" : "OK";
    const raw = f.missing ? "0" : formatCharsAndTokens(f.rawChars);
    const injected = f.missing ? "0" : formatCharsAndTokens(f.injectedChars);
    return `- ${f.name}: ${status} | raw ${raw} | injected ${injected}`;
  });

  const sandboxLine = `Sandbox: mode=${report.sandbox?.mode ?? "unknown"} sandboxed=${report.sandbox?.sandboxed ?? false}`;
  const toolSchemaLine = `Tool schemas (JSON): ${formatCharsAndTokens(report.tools.schemaChars)} (counts toward context; not shown as text)`;
  const toolListLine = `Tool list (system prompt text): ${formatCharsAndTokens(report.tools.listChars)}`;
  const skillNameSet = new Set(report.skills.entries.map((s) => s.name));
  const skillNames = Array.from(skillNameSet);
  const toolNames = report.tools.entries.map((t) => t.name);
  const formatNameList = (names: string[], cap: number) =>
    names.length <= cap
      ? names.join(", ")
      : `${names.slice(0, cap).join(", ")}, … (+${names.length - cap} more)`;
  const skillsLine = `Skills list (system prompt text): ${formatCharsAndTokens(report.skills.promptChars)} (${skillNameSet.size} skills)`;
  const skillsNamesLine = skillNameSet.size
    ? `Skills: ${formatNameList(skillNames, 20)}`
    : "Skills: (none)";
  const toolsNamesLine = toolNames.length
    ? `Tools: ${formatNameList(toolNames, 30)}`
    : "Tools: (none)";
  const systemPromptLine = `System prompt (${report.source}): ${formatCharsAndTokens(report.systemPrompt.chars)} (Project Context ${formatCharsAndTokens(report.systemPrompt.projectContextChars)})`;
  const workspaceLabel = report.workspaceDir ?? params.workspaceDir;
  const sessionAgentId = resolveContextReportAgentId(params);
  const bootstrapMaxChars =
    typeof report.bootstrapMaxChars === "number" &&
    Number.isFinite(report.bootstrapMaxChars) &&
    report.bootstrapMaxChars > 0
      ? report.bootstrapMaxChars
      : resolveBootstrapMaxChars(params.cfg, sessionAgentId);
  const bootstrapTotalMaxChars =
    typeof report.bootstrapTotalMaxChars === "number" &&
    Number.isFinite(report.bootstrapTotalMaxChars) &&
    report.bootstrapTotalMaxChars > 0
      ? report.bootstrapTotalMaxChars
      : resolveBootstrapTotalMaxChars(params.cfg, sessionAgentId);
  const bootstrapMaxLabel = `${formatInt(bootstrapMaxChars)} chars`;
  const bootstrapTotalLabel = `${formatInt(bootstrapTotalMaxChars)} chars`;
  const bootstrapAnalysis = analyzeBootstrapBudget({
    files: report.injectedWorkspaceFiles,
    bootstrapMaxChars,
    bootstrapTotalMaxChars,
  });
  const truncatedBootstrapFiles = bootstrapAnalysis.truncatedFiles;
  const truncationCauseCounts = truncatedBootstrapFiles.reduce(
    (acc, file) => {
      for (const cause of file.causes) {
        if (cause === "per-file-limit") {
          acc.perFile += 1;
        } else if (cause === "total-limit") {
          acc.total += 1;
        }
      }
      return acc;
    },
    { perFile: 0, total: 0 },
  );
  const truncationCauseParts = [
    truncationCauseCounts.perFile > 0
      ? `${truncationCauseCounts.perFile} file(s) exceeded max/file`
      : null,
    truncationCauseCounts.total > 0 ? `${truncationCauseCounts.total} file(s) hit max/total` : null,
  ].filter(Boolean);
  const bootstrapWarningLines =
    truncatedBootstrapFiles.length > 0
      ? [
          `⚠ Bootstrap context is over configured limits: ${truncatedBootstrapFiles.length} file(s) truncated (${formatInt(bootstrapAnalysis.totals.rawChars)} raw chars -> ${formatInt(bootstrapAnalysis.totals.injectedChars)} injected chars).`,
          ...(truncationCauseParts.length ? [`Causes: ${truncationCauseParts.join("; ")}.`] : []),
          "Tip: increase this agent's `agents.entries.*.bootstrapMaxChars` / `agents.entries.*.bootstrapTotalMaxChars` override, or the matching `agents.defaults.*` fallback, if this truncation is not intentional.",
        ]
      : [];

  const contextWindowLabel = session.contextTokens != null ? formatInt(session.contextTokens) : "?";
  const totalsLine =
    cachedContextUsageTokens != null
      ? `Session tokens (cached): ${formatInt(cachedContextUsageTokens)} total / ctx=${contextWindowLabel}`
      : `Session tokens (cached): unknown / ctx=${contextWindowLabel}`;
  const sharedContextLines = [
    `Workspace: ${workspaceLabel}`,
    `Bootstrap max/file: ${bootstrapMaxLabel}`,
    `Bootstrap max/total: ${bootstrapTotalLabel}`,
    sandboxLine,
    systemPromptLine,
    ...(bootstrapWarningLines.length ? ["", ...bootstrapWarningLines] : []),
    "",
    "Injected workspace files:",
    ...fileLines,
    "",
    skillsLine,
    skillsNamesLine,
  ];

  if (sub === "detail" || sub === "deep") {
    const perSkill = formatListTop(
      report.skills.entries.map((s) => ({ name: s.name, value: s.blockChars })),
      30,
    );
    const perToolSchema = formatListTop(
      report.tools.entries.map((t) => ({ name: t.name, value: t.schemaChars })),
      30,
    );
    const perToolSummary = formatListTop(
      report.tools.entries.map((t) => ({ name: t.name, value: t.summaryChars })),
      30,
    );
    const toolPropsLines = report.tools.entries
      .filter((t) => t.propertiesCount != null)
      .toSorted((a, b) => (b.propertiesCount ?? 0) - (a.propertiesCount ?? 0))
      .slice(0, 30)
      .map((t) => `- ${t.name}: ${t.propertiesCount} params`);

    // `systemPrompt.chars` already includes injected files, skills, and tool-list text.
    // Add only tool schemas here so the tracked estimate stays disjoint.
    const currentTurnChars = report.currentTurn
      ? report.currentTurn.promptChars + report.currentTurn.runtimeContextChars
      : 0;
    const trackedPromptChars =
      report.systemPrompt.chars + report.tools.schemaChars + currentTurnChars;
    const trackedPromptLine = `Tracked prompt estimate: ${formatCharsAndTokens(trackedPromptChars)}`;
    const actualContextLine =
      cachedContextUsageTokens != null
        ? `Actual context usage (cached): ${formatInt(cachedContextUsageTokens)} tok`
        : "Actual context usage (cached): unavailable";
    const overheadTokens =
      cachedContextUsageTokens != null
        ? cachedContextUsageTokens - estimateTokensFromChars(trackedPromptChars)
        : null;
    const overheadLine =
      overheadTokens == null
        ? null
        : overheadTokens > 0
          ? `Untracked provider/runtime overhead: ~${formatInt(overheadTokens)} tok`
          : "Untracked provider/runtime overhead: not observed in cached usage";
    const transcriptCompactability = resolveTranscriptCompactabilityReport(
      params,
      targetSessionEntry,
    );
    const transcriptCompactabilityLines = transcriptCompactability.available
      ? [
          `Compactable transcript: ${formatInt(transcriptCompactability.realConversationMessages)} real conversation message(s) / ${formatInt(transcriptCompactability.totalMessages)} transcript message(s)`,
          ...(transcriptCompactability.realConversationMessages === 0
            ? [
                "Compaction note: prompt/cache usage may be high even when there are no compactable conversation messages.",
              ]
            : []),
        ]
      : [`Compactable transcript: unavailable (${transcriptCompactability.reason})`];

    return {
      text: [
        "🧠 Context breakdown (detailed)",
        ...sharedContextLines,
        ...(perSkill.lines.length ? ["Top skills (prompt entry size):", ...perSkill.lines] : []),
        ...(perSkill.omitted ? [`… (+${perSkill.omitted} more skills)`] : []),
        "",
        toolListLine,
        toolSchemaLine,
        toolsNamesLine,
        "Top tools (schema size):",
        ...perToolSchema.lines,
        ...(perToolSchema.omitted ? [`… (+${perToolSchema.omitted} more tools)`] : []),
        "",
        "Top tools (summary text size):",
        ...perToolSummary.lines,
        ...(perToolSummary.omitted ? [`… (+${perToolSummary.omitted} more tools)`] : []),
        ...(toolPropsLines.length ? ["", "Tools (param count):", ...toolPropsLines] : []),
        "",
        trackedPromptLine,
        actualContextLine,
        ...(overheadLine ? [overheadLine] : []),
        ...transcriptCompactabilityLines,
        "",
        totalsLine,
        "",
        "Inline shortcut: a command token inside normal text (e.g. “hey /status”) that runs immediately (allowlisted senders only) and is stripped before the model sees the remaining message.",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  }

  return {
    text: [
      "🧠 Context breakdown",
      ...sharedContextLines,
      toolListLine,
      toolSchemaLine,
      toolsNamesLine,
      "",
      totalsLine,
      "",
      "Inline shortcut: a command token inside normal text (e.g. “hey /status”) that runs immediately (allowlisted senders only) and is stripped before the model sees the remaining message.",
    ].join("\n"),
  };
}
