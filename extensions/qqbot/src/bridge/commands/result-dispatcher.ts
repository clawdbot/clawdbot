/**
 * Dispatch a slash command result produced on the framework command surface.
 *
 * Slash command handlers return one of:
 *   1. a plain string (text reply),
 *   2. a `SlashCommandFileResult` (text plus a local file to upload), or
 *   3. null / unexpected value (we surface a generic warning).
 *
 * This module isolates the text/file branching so the framework registration
 * layer stays declarative and so the file-send side effect has a single
 * location where logging and error handling live.
 */

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import type { SlashCommandResult } from "../../engine/commands/slash-commands.js";
import { sendDocument, type MediaTargetContext } from "../../engine/messaging/outbound.js";
import type { ResolvedQQBotAccount } from "../../types.js";
import type { QQBotFromParseResult } from "./from-parser.js";

const UNEXPECTED_RESULT_TEXT = "⚠️ 命令返回了意外结果。";

export interface FrameworkSlashReply {
  text: string;
}

export interface DispatchFrameworkSlashResultInput {
  result: SlashCommandResult;
  account: ResolvedQQBotAccount;
  from: QQBotFromParseResult;
  logger?: PluginLogger;
}

function hasFilePath(value: unknown): value is { text: string; filePath: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "filePath" in value &&
    typeof (value as { filePath: unknown }).filePath === "string"
  );
}

function buildMediaTarget(
  account: ResolvedQQBotAccount,
  from: QQBotFromParseResult,
): MediaTargetContext {
  return {
    targetType: from.targetType,
    targetId: from.targetId,
    account: account as unknown as MediaTargetContext["account"],
  };
}

export async function dispatchFrameworkSlashResult({
  result,
  account,
  from,
  logger,
}: DispatchFrameworkSlashResultInput): Promise<FrameworkSlashReply> {
  if (typeof result === "string") {
    return { text: result };
  }

  if (hasFilePath(result)) {
    const mediaCtx = buildMediaTarget(account, from);
    try {
      await sendDocument(mediaCtx, result.filePath, {
        allowQQBotDataDownloads: true,
      });
    } catch (err) {
      logger?.warn(`framework slash file send failed: ${String(err)}`);
    }
    return { text: result.text };
  }

  return { text: UNEXPECTED_RESULT_TEXT };
}
