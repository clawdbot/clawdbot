/**
 * Claude Code Command Handler
 *
 * Handles the /claude command for starting and managing Claude Code sessions.
 *
 * Usage:
 *   /claude juzi              - Start session in juzi project
 *   /claude juzi @experimental - Start in worktree
 *   /claude status            - Show active sessions
 *   /claude cancel <token>    - Cancel a session
 */

import { logVerbose } from "../../globals.js";
import {
  startSession,
  cancelSessionByToken,
  listSessions,
  getSessionState,
} from "../../agents/claude-code/index.js";
import type { CommandHandler } from "./commands-types.js";

/**
 * Parse /claude command arguments.
 */
function parseClaudeCommand(commandBody: string): {
  hasCommand: boolean;
  action?: "start" | "status" | "cancel" | "list";
  project?: string;
  token?: string;
} {
  const match = commandBody.match(/^\/claude(?:\s+(.*))?$/i);
  if (!match) return { hasCommand: false };

  const args = match[1]?.trim() ?? "";

  // /claude status
  if (args.toLowerCase() === "status" || args.toLowerCase() === "list") {
    return { hasCommand: true, action: "status" };
  }

  // /claude cancel <token>
  const cancelMatch = args.match(/^cancel\s+(\S+)/i);
  if (cancelMatch) {
    return { hasCommand: true, action: "cancel", token: cancelMatch[1] };
  }

  // /claude <project> [@worktree]
  if (args) {
    return { hasCommand: true, action: "start", project: args };
  }

  // /claude with no args shows help
  return { hasCommand: true, action: "status" };
}

/**
 * Format session list for display.
 */
function formatSessionList(): string {
  const sessions = listSessions();
  if (sessions.length === 0) {
    return "No active Claude Code sessions.";
  }

  const lines = ["**Active Claude Code Sessions:**", ""];
  for (const session of sessions) {
    const state = getSessionState(session);
    const tokenPrefix = session.resumeToken.slice(0, 8);
    lines.push(`- **${state.projectName}** (${tokenPrefix})`);
    lines.push(`  ${state.runtimeStr} · ${state.status}`);
  }

  return lines.join("\n");
}

export const handleClaudeCommand: CommandHandler = async (params, allowTextCommands) => {
  const parsed = parseClaudeCommand(params.command.commandBodyNormalized);
  if (!parsed.hasCommand) return null;

  // Only authorized senders can use /claude
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /claude from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }

  // Handle status/list
  if (parsed.action === "status") {
    return {
      shouldContinue: false,
      reply: { text: formatSessionList() },
    };
  }

  // Handle cancel
  if (parsed.action === "cancel" && parsed.token) {
    const success = cancelSessionByToken(parsed.token);
    if (success) {
      return {
        shouldContinue: false,
        reply: { text: `Cancelled session: ${parsed.token}` },
      };
    }
    return {
      shouldContinue: false,
      reply: { text: `Session not found: ${parsed.token}` },
    };
  }

  // Handle start
  if (parsed.action === "start" && parsed.project) {
    const result = await startSession({
      project: parsed.project,
      permissionMode: "bypassPermissions",
      onStateChange: (state) => {
        // State changes will be handled by the bubble manager
        // This is a placeholder for now - bubble integration in Phase 6
        logVerbose(`[claude-code] State change: ${state.status} - ${state.phaseStatus}`);
      },
    });

    if (!result.success) {
      return {
        shouldContinue: false,
        reply: { text: `Failed to start session: ${result.error}` },
      };
    }

    return {
      shouldContinue: false,
      reply: {
        text: `Started Claude Code session for **${parsed.project}**\nSession ID: ${result.sessionId}\nResume token: \`${result.resumeToken}\``,
      },
    };
  }

  // No valid action
  return {
    shouldContinue: false,
    reply: {
      text: [
        "**Claude Code Commands:**",
        "",
        "`/claude <project>` - Start a session",
        "`/claude <project> @<worktree>` - Start in worktree",
        "`/claude status` - Show active sessions",
        "`/claude cancel <token>` - Cancel a session",
      ].join("\n"),
    },
  };
};
