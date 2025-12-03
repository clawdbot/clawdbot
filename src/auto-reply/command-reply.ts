import fs from "node:fs/promises";
import path from "node:path";

import { type AgentKind, getAgentSpec } from "../agents/index.js";
import type { AgentMeta } from "../agents/types.js";
import type { WarelayConfig } from "../config/config.js";
import { isVerbose, logVerbose } from "../globals.js";
import { logError } from "../logger.js";
import { getChildLogger } from "../logging.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { enqueueCommand } from "../process/command-queue.js";
import type { runCommandWithTimeout } from "../process/exec.js";
import { runPiRpc } from "../process/tau-rpc.js";
import { applyTemplate, type TemplateContext } from "./templating.js";
import type { ReplyPayload } from "./types.js";

type CommandReplyConfig = NonNullable<WarelayConfig["inbound"]>["reply"] & {
  mode: "command";
};

type EnqueueRunner = typeof enqueueCommand;

type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high";

type CommandReplyParams = {
  reply: CommandReplyConfig;
  templatingCtx: TemplateContext;
  sendSystemOnce: boolean;
  isNewSession: boolean;
  isFirstTurnInSession: boolean;
  systemSent: boolean;
  timeoutMs: number;
  timeoutSeconds: number;
  commandRunner: typeof runCommandWithTimeout;
  enqueue?: EnqueueRunner;
  thinkLevel?: ThinkLevel;
};

export type CommandReplyMeta = {
  durationMs: number;
  queuedMs?: number;
  queuedAhead?: number;
  exitCode?: number | null;
  signal?: string | null;
  killed?: boolean;
  agentMeta?: AgentMeta;
};

export type CommandReplyResult = {
  payloads?: ReplyPayload[];
  meta: CommandReplyMeta;
};

export function summarizeClaudeMetadata(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const obj = payload as Record<string, unknown>;
  const parts: string[] = [];

  if (typeof obj.duration_ms === "number") {
    parts.push(`duration=${obj.duration_ms}ms`);
  }
  if (typeof obj.duration_api_ms === "number") {
    parts.push(`api=${obj.duration_api_ms}ms`);
  }
  if (typeof obj.num_turns === "number") {
    parts.push(`turns=${obj.num_turns}`);
  }
  if (typeof obj.total_cost_usd === "number") {
    parts.push(`cost=$${obj.total_cost_usd.toFixed(4)}`);
  }

  const usage = obj.usage;
  if (usage && typeof usage === "object") {
    const serverToolUse = (
      usage as { server_tool_use?: Record<string, unknown> }
    ).server_tool_use;
    if (serverToolUse && typeof serverToolUse === "object") {
      const toolCalls = Object.values(serverToolUse).reduce<number>(
        (sum, val) => {
          if (typeof val === "number") return sum + val;
          return sum;
        },
        0,
      );
      if (toolCalls > 0) parts.push(`tool_calls=${toolCalls}`);
    }
  }

  const modelUsage = obj.modelUsage;
  if (modelUsage && typeof modelUsage === "object") {
    const models = Object.keys(modelUsage as Record<string, unknown>);
    if (models.length) {
      const display =
        models.length > 2
          ? `${models.slice(0, 2).join(",")}+${models.length - 2}`
          : models.join(",");
      parts.push(`models=${display}`);
    }
  }

  return parts.length ? parts.join(", ") : undefined;
}

function appendThinkingCue(body: string, level?: ThinkLevel): string {
  if (!level || level === "off") return body;
  const cue = (() => {
    switch (level) {
      case "high":
        return "ultrathink";
      case "medium":
        return "think harder";
      case "low":
        return "think hard";
      case "minimal":
        return "think";
      default:
        return "";
    }
  })();
  return [body.trim(), cue].filter(Boolean).join(" ");
}

export async function runCommandReply(
  params: CommandReplyParams,
): Promise<CommandReplyResult> {
  const logger = getChildLogger({ module: "command-reply" });
  const verboseLog = (msg: string) => {
    logger.debug(msg);
    if (isVerbose()) logVerbose(msg);
  };

  const {
    reply,
    templatingCtx,
    sendSystemOnce,
    isNewSession,
    isFirstTurnInSession,
    systemSent,
    timeoutMs,
    timeoutSeconds,
    commandRunner,
    enqueue = enqueueCommand,
    thinkLevel,
  } = params;

  if (!reply.command?.length) {
    throw new Error("reply.command is required for mode=command");
  }
  const agentCfg = reply.agent ?? { kind: "claude" };
  const agentKind: AgentKind = agentCfg.kind ?? "claude";
  const agent = getAgentSpec(agentKind);

  let argv = reply.command.map((part) => applyTemplate(part, templatingCtx));
  const templatePrefix =
    reply.template && (!sendSystemOnce || isFirstTurnInSession || !systemSent)
      ? applyTemplate(reply.template, templatingCtx)
      : "";
  if (templatePrefix && argv.length > 0) {
    argv = [argv[0], templatePrefix, ...argv.slice(1)];
  }

  // Default body index is last arg
  let bodyIndex = Math.max(argv.length - 1, 0);

  // Session args prepared (templated) and injected generically
  if (reply.session) {
    const defaultSessionArgs = (() => {
      switch (agentCfg.kind) {
        case "claude":
          return {
            newArgs: ["--session-id", "{{SessionId}}"],
            resumeArgs: ["--resume", "{{SessionId}}"],
          };
        case "gemini":
          // Gemini CLI supports --resume <id>; starting a new session needs no flag.
          return { newArgs: [], resumeArgs: ["--resume", "{{SessionId}}"] };
        default:
          return {
            newArgs: ["--session", "{{SessionId}}"],
            resumeArgs: ["--session", "{{SessionId}}"],
          };
      }
    })();
    const defaultNew = defaultSessionArgs.newArgs;
    const defaultResume = defaultSessionArgs.resumeArgs;
    const sessionArgList = (
      isNewSession
        ? (reply.session.sessionArgNew ?? defaultNew)
        : (reply.session.sessionArgResume ?? defaultResume)
    ).map((p) => applyTemplate(p, templatingCtx));
    if (sessionArgList.length) {
      const insertBeforeBody = reply.session.sessionArgBeforeBody ?? true;
      const insertAt =
        insertBeforeBody && argv.length > 1 ? argv.length - 1 : argv.length;
      argv = [
        ...argv.slice(0, insertAt),
        ...sessionArgList,
        ...argv.slice(insertAt),
      ];
      bodyIndex = Math.max(argv.length - 1, 0);
    }
  }

  if (thinkLevel && thinkLevel !== "off") {
    if (agentKind === "pi") {
      const hasThinkingFlag = argv.some(
        (p, i) =>
          p === "--thinking" ||
          (i > 0 && argv[i - 1] === "--thinking") ||
          p.startsWith("--thinking="),
      );
      if (!hasThinkingFlag) {
        argv.splice(bodyIndex, 0, "--thinking", thinkLevel);
        bodyIndex += 2;
      }
    } else if (argv[bodyIndex]) {
      argv[bodyIndex] = appendThinkingCue(argv[bodyIndex] ?? "", thinkLevel);
    }
  }

  const shouldApplyAgent = agent.isInvocation(argv);
  const finalArgv = shouldApplyAgent
    ? agent.buildArgs({
        argv,
        bodyIndex,
        isNewSession,
        sessionId: templatingCtx.SessionId,
        sendSystemOnce,
        systemSent,
        identityPrefix: agentCfg.identityPrefix,
        format: agentCfg.format,
      })
    : argv;

  logVerbose(
    `Running command auto-reply: ${finalArgv.join(" ")}${reply.cwd ? ` (cwd: ${reply.cwd})` : ""}`,
  );
  logger.info(
    {
      agent: agentKind,
      sessionId: templatingCtx.SessionId,
      newSession: isNewSession,
      cwd: reply.cwd,
      command: finalArgv.slice(0, -1), // omit body to reduce noise
    },
    "command auto-reply start",
  );

  const started = Date.now();
  let queuedMs: number | undefined;
  let queuedAhead: number | undefined;
  try {
    const run = async () => {
      // Prefer long-lived tau RPC for pi agent to avoid cold starts.
      if (agentKind === "pi") {
        const promptIndex = finalArgv.length - 1;
        const body = finalArgv[promptIndex] ?? "";
        // Build rpc args without the prompt body; force --mode rpc.
        const rpcArgv = (() => {
          const copy = [...finalArgv];
          copy.splice(promptIndex, 1);
          const modeIdx = copy.indexOf("--mode");
          if (modeIdx >= 0 && copy[modeIdx + 1]) {
            copy.splice(modeIdx, 2, "--mode", "rpc");
          } else if (!copy.includes("--mode")) {
            copy.splice(copy.length - 1, 0, "--mode", "rpc");
          }
          return copy;
        })();
        return await runPiRpc({
          argv: rpcArgv,
          cwd: reply.cwd,
          prompt: body,
          timeoutMs,
        });
      }
      return await commandRunner(finalArgv, { timeoutMs, cwd: reply.cwd });
    };

    const { stdout, stderr, code, signal, killed } = await enqueue(run, {
      onWait: (waitMs, ahead) => {
        queuedMs = waitMs;
        queuedAhead = ahead;
        if (isVerbose()) {
          logVerbose(
            `Command auto-reply queued for ${waitMs}ms (${queuedAhead} ahead)`,
          );
        }
      },
    });
    const rawStdout = stdout.trim();
    let mediaFromCommand: string[] | undefined;
    const trimmed = rawStdout;
    if (stderr?.trim()) {
      logVerbose(`Command auto-reply stderr: ${stderr.trim()}`);
    }

    const parsed = trimmed ? agent.parseOutput(trimmed) : undefined;
    const parserProvided = !!parsed;

    // Collect one message per assistant text from parseOutput (tau RPC can emit many).
    const parsedTexts =
      parsed?.texts?.map((t) => t.trim()).filter(Boolean) ?? [];

    type ReplyItem = { text: string; media?: string[] };
    const replyItems: ReplyItem[] = [];

    for (const t of parsedTexts) {
      const { text: cleanedText, mediaUrls: mediaFound } =
        splitMediaFromOutput(t);
      replyItems.push({
        text: cleanedText,
        media: mediaFound?.length ? mediaFound : undefined,
      });
    }

    // If parser gave nothing, fall back to raw stdout as a single message.
    if (replyItems.length === 0 && trimmed && !parserProvided) {
      const { text: cleanedText, mediaUrls: mediaFound } =
        splitMediaFromOutput(trimmed);
      if (cleanedText || mediaFound?.length) {
        replyItems.push({
          text: cleanedText,
          media: mediaFound?.length ? mediaFound : undefined,
        });
      }
    }

    // No content at all → fallback notice.
    if (replyItems.length === 0) {
      const meta = parsed?.meta?.extra?.summary ?? undefined;
      replyItems.push({
        text: `(command produced no output${meta ? `; ${meta}` : ""})`,
      });
      verboseLog("No text/media produced; injecting fallback notice to user");
    }

    verboseLog(
      `Command auto-reply stdout produced ${replyItems.length} message(s)`,
    );
    const elapsed = Date.now() - started;
    verboseLog(`Command auto-reply finished in ${elapsed}ms`);
    logger.info(
      { durationMs: elapsed, agent: agentKind, cwd: reply.cwd },
      "command auto-reply finished",
    );
    if ((code ?? 0) !== 0) {
      console.error(
        `Command auto-reply exited with code ${code ?? "unknown"} (signal: ${signal ?? "none"})`,
      );
      // Include any partial output or stderr in error message
      const partialOut = trimmed
        ? `\n\nOutput: ${trimmed.slice(0, 500)}${trimmed.length > 500 ? "..." : ""}`
        : "";
      const errorText = `⚠️ Command exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}${partialOut}`;
      return {
        payloads: [{ text: errorText }],
        meta: {
          durationMs: Date.now() - started,
          queuedMs,
          queuedAhead,
          exitCode: code,
          signal,
          killed,
          agentMeta: parsed?.meta,
        },
      };
    }
    if (killed && !signal) {
      console.error(
        `Command auto-reply process killed before completion (exit code ${code ?? "unknown"})`,
      );
      const errorText = `⚠️ Command was killed before completion (exit code ${code ?? "unknown"})`;
      return {
        payloads: [{ text: errorText }],
        meta: {
          durationMs: Date.now() - started,
          queuedMs,
          queuedAhead,
          exitCode: code,
          signal,
          killed,
          agentMeta: parsed?.meta,
        },
      };
    }
    const meta: CommandReplyMeta = {
      durationMs: Date.now() - started,
      queuedMs,
      queuedAhead,
      exitCode: code,
      signal,
      killed,
      agentMeta: parsed?.meta,
    };

    const payloads: ReplyPayload[] = [];

    // Build each reply item sequentially (delivery handled by caller).
    for (const item of replyItems) {
      let mediaUrls =
        item.media ??
        mediaFromCommand ??
        (reply.mediaUrl ? [reply.mediaUrl] : undefined);

      // If mediaMaxMb is set, skip local media paths larger than the cap.
      if (mediaUrls?.length && reply.mediaMaxMb) {
        const maxBytes = reply.mediaMaxMb * 1024 * 1024;
        const filtered: string[] = [];
        for (const url of mediaUrls) {
          if (/^https?:\/\//i.test(url)) {
            filtered.push(url);
            continue;
          }
          const abs = path.isAbsolute(url) ? url : path.resolve(url);
          try {
            const stats = await fs.stat(abs);
            if (stats.size <= maxBytes) {
              filtered.push(url);
            } else if (isVerbose()) {
              logVerbose(
                `Skipping media ${url} (${(stats.size / (1024 * 1024)).toFixed(2)}MB) over cap ${reply.mediaMaxMb}MB`,
              );
            }
          } catch {
            filtered.push(url);
          }
        }
        mediaUrls = filtered;
      }

      const payload =
        item.text || mediaUrls?.length
          ? {
              text: item.text || undefined,
              mediaUrl: mediaUrls?.[0],
              mediaUrls,
            }
          : undefined;

      if (payload) payloads.push(payload);
    }

    verboseLog(`Command auto-reply meta: ${JSON.stringify(meta)}`);
    return { payloads, meta };
  } catch (err) {
    const elapsed = Date.now() - started;
    logger.info(
      { durationMs: elapsed, agent: agentKind, cwd: reply.cwd },
      "command auto-reply failed",
    );
    const anyErr = err as { killed?: boolean; signal?: string };
    const timeoutHit = anyErr.killed === true || anyErr.signal === "SIGKILL";
    const errorObj = err as { stdout?: string; stderr?: string };
    if (errorObj.stderr?.trim()) {
      verboseLog(`Command auto-reply stderr: ${errorObj.stderr.trim()}`);
    }
    if (timeoutHit) {
      console.error(
        `Command auto-reply timed out after ${elapsed}ms (limit ${timeoutMs}ms)`,
      );
      const baseMsg =
        "Command timed out after " +
        `${timeoutSeconds}s${reply.cwd ? ` (cwd: ${reply.cwd})` : ""}. Try a shorter prompt or split the request.`;
      const partial = errorObj.stdout?.trim();
      const partialSnippet =
        partial && partial.length > 800
          ? `${partial.slice(0, 800)}...`
          : partial;
      const text = partialSnippet
        ? `${baseMsg}\n\nPartial output before timeout:\n${partialSnippet}`
        : baseMsg;
      return {
        payloads: [{ text }],
        meta: {
          durationMs: elapsed,
          queuedMs,
          queuedAhead,
          exitCode: undefined,
          signal: anyErr.signal,
          killed: anyErr.killed,
        },
      };
    }
    logError(`Command auto-reply failed after ${elapsed}ms: ${String(err)}`);
    // Send error message to user so they know the command failed
    const errMsg = err instanceof Error ? err.message : String(err);
    const errorText = `⚠️ Command failed: ${errMsg}`;
    return {
      payloads: [{ text: errorText }],
      meta: {
        durationMs: elapsed,
        queuedMs,
        queuedAhead,
        exitCode: undefined,
        signal: anyErr.signal,
        killed: anyErr.killed,
      },
    };
  }
}
