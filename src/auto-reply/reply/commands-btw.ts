import { resolveAgentDir, resolveSessionAgentId } from "../../agents/agent-scope.js";
import { runBtwSideQuestion } from "../../agents/btw.js";
import { extractBtwQuestion } from "./btw-command.js";
import { rejectUnauthorizedCommand } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const BTW_USAGE = "Usage: /btw [side question]";

export const handleBtwCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const question = extractBtwQuestion(params.command.commandBodyNormalized);
  if (question === null) {
    return null;
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/btw");
  if (unauthorized) {
    return unauthorized;
  }

  if (!question) {
    return {
      shouldContinue: false,
      reply: { text: BTW_USAGE },
    };
  }

  const targetSessionEntry = params.sessionStore?.[params.sessionKey] ?? params.sessionEntry;

  if (!targetSessionEntry?.sessionId) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ /btw requires an active session with existing context." },
    };
  }

  const sessionAgentId = params.sessionKey
    ? resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg })
    : params.agentId;
  const agentDir =
    (sessionAgentId ? resolveAgentDir(params.cfg, sessionAgentId) : undefined) ?? params.agentDir;

  if (!agentDir) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ /btw is unavailable because the active agent directory could not be resolved.",
      },
    };
  }

  try {
    await params.typing?.startTypingLoop();
    const reply = await runBtwSideQuestion({
      cfg: params.cfg,
      agentDir,
      provider: params.provider,
      model: params.model,
      question,
      sessionEntry: targetSessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      // BTW is intentionally a quick side question, so do not inherit slower
      // session-level think/reasoning settings from the main run.
      resolvedThinkLevel: "off",
      resolvedReasoningLevel: "off",
      blockReplyChunking: params.blockReplyChunking,
      resolvedBlockStreamingBreak: params.resolvedBlockStreamingBreak,
      opts: params.opts,
      isNewSession: false,
    });
    return {
      shouldContinue: false,
      reply: reply ? { ...reply, btw: { question } } : reply,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : "";
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ /btw failed${message ? `: ${message}` : "."}`,
        btw: { question },
        isError: true,
      },
    };
  }
};
