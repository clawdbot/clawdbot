import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { MessageInstance } from "twilio/lib/rest/api/v2010/account/message.js";
import { loadConfig, type WarelayConfig } from "../config/config.js";
import {
  DEFAULT_IDLE_MINUTES,
  DEFAULT_RESET_TRIGGER,
  deriveSessionKey,
  loadSessionStore,
  resolveStorePath,
  saveSessionStore,
} from "../config/sessions.js";
import { info, isVerbose, logVerbose } from "../globals.js";
import { logError } from "../logger.js";
import { ensureMediaHosted } from "../media/host.js";
import { splitMediaFromOutput } from "../media/parse.js";
import { enqueueCommand } from "../process/command-queue.js";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { TwilioRequester } from "../twilio/types.js";
import { sendTypingIndicator } from "../twilio/typing.js";
import {
  CLAUDE_BIN,
  CLAUDE_IDENTITY_PREFIX,
  type ClaudeJsonParseResult,
  parseClaudeJson,
} from "./claude.js";
import {
  applyTemplate,
  type MsgContext,
  type TemplateContext,
} from "./templating.js";

type GetReplyOptions = {
  onReplyStart?: () => Promise<void> | void;
};

function summarizeClaudeMetadata(payload: unknown): string | undefined {
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

export type ReplyPayload = {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
};

export async function getReplyFromConfig(
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: WarelayConfig,
  commandRunner: typeof runCommandWithTimeout = runCommandWithTimeout,
): Promise<ReplyPayload | undefined> {
  // Choose reply from config: static text or external command stdout.
  const cfg = configOverride ?? loadConfig();
  const reply = cfg.inbound?.reply;
  const timeoutSeconds = Math.max(reply?.timeoutSeconds ?? 600, 1);
  const timeoutMs = timeoutSeconds * 1000;
  let started = false;
  const triggerTyping = async () => {
    await opts?.onReplyStart?.();
  };
  const onReplyStart = async () => {
    if (started) return;
    started = true;
    await triggerTyping();
  };
  let typingTimer: NodeJS.Timeout | undefined;
  const typingIntervalMs =
    reply?.mode === "command"
      ? (reply.typingIntervalSeconds ??
          reply?.session?.typingIntervalSeconds ??
          8) * 1000
      : 0;
  const cleanupTyping = () => {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = undefined;
    }
  };
  const startTypingLoop = async () => {
    if (!opts?.onReplyStart) return;
    if (typingIntervalMs <= 0) return;
    if (typingTimer) return;
    await triggerTyping();
    typingTimer = setInterval(() => {
      void triggerTyping();
    }, typingIntervalMs);
  };
  let transcribedText: string | undefined;

  // Optional audio transcription before templating/session handling.
  if (cfg.inbound?.transcribeAudio && isAudio(ctx.MediaType)) {
    const transcribed = await transcribeInboundAudio(cfg, ctx, defaultRuntime);
    if (transcribed?.text) {
      transcribedText = transcribed.text;
      ctx.Body = transcribed.text;
      ctx.Transcript = transcribed.text;
      logVerbose("Replaced Body with audio transcript for reply flow");
    }
  }

  // Optional session handling (conversation reuse + /new resets)
  const sessionCfg = reply?.session;
  const resetTriggers = sessionCfg?.resetTriggers?.length
    ? sessionCfg.resetTriggers
    : [DEFAULT_RESET_TRIGGER];
  const idleMinutes = Math.max(
    sessionCfg?.idleMinutes ?? DEFAULT_IDLE_MINUTES,
    1,
  );
  const sessionScope = sessionCfg?.scope ?? "per-sender";
  const storePath = resolveStorePath(sessionCfg?.store);
  let sessionStore: ReturnType<typeof loadSessionStore> | undefined;
  let sessionKey: string | undefined;

  let sessionId: string | undefined;
  let isNewSession = false;
  let bodyStripped: string | undefined;
  let systemSent = false;

  if (sessionCfg) {
    const trimmedBody = (ctx.Body ?? "").trim();
    for (const trigger of resetTriggers) {
      if (!trigger) continue;
      if (trimmedBody === trigger) {
        isNewSession = true;
        bodyStripped = "";
        break;
      }
      const triggerPrefix = `${trigger} `;
      if (trimmedBody.startsWith(triggerPrefix)) {
        isNewSession = true;
        bodyStripped = trimmedBody.slice(trigger.length).trimStart();
        break;
      }
    }

    sessionKey = deriveSessionKey(sessionScope, ctx);
    sessionStore = loadSessionStore(storePath);
    const entry = sessionStore[sessionKey];
    const idleMs = idleMinutes * 60_000;
    const freshEntry = entry && Date.now() - entry.updatedAt <= idleMs;

    if (!isNewSession && freshEntry) {
      sessionId = entry.sessionId;
      systemSent = entry.systemSent ?? false;
    } else {
      sessionId = crypto.randomUUID();
      isNewSession = true;
      systemSent = false;
    }

    sessionStore[sessionKey] = { sessionId, updatedAt: Date.now(), systemSent };
    await saveSessionStore(storePath, sessionStore);
  }

  const sessionCtx: TemplateContext = {
    ...ctx,
    BodyStripped: bodyStripped ?? ctx.Body,
    SessionId: sessionId,
    IsNewSession: isNewSession ? "true" : "false",
  };

  // Optional allowlist by origin number (E.164 without whatsapp: prefix)
  const allowFrom = cfg.inbound?.allowFrom;
  if (Array.isArray(allowFrom) && allowFrom.length > 0) {
    const from = (ctx.From ?? "").replace(/^whatsapp:/, "");
    if (!allowFrom.includes(from)) {
      logVerbose(
        `Skipping auto-reply: sender ${from || "<unknown>"} not in allowFrom list`,
      );
      cleanupTyping();
      return undefined;
    }
  }

  await startTypingLoop();

  // Optional prefix injected before Body for templating/command prompts.
  const sendSystemOnce = sessionCfg?.sendSystemOnce === true;
  const isFirstTurnInSession = isNewSession || !systemSent;
  const sessionIntro =
    isFirstTurnInSession && sessionCfg?.sessionIntro
      ? applyTemplate(sessionCfg.sessionIntro, sessionCtx)
      : "";
  const bodyPrefix = reply?.bodyPrefix
    ? applyTemplate(reply.bodyPrefix, sessionCtx)
    : "";
  const baseBody = sessionCtx.BodyStripped ?? sessionCtx.Body ?? "";
  const prefixedBodyBase = (() => {
    let body = baseBody;
    if (!sendSystemOnce || isFirstTurnInSession) {
      body = bodyPrefix ? `${bodyPrefix}${body}` : body;
    }
    if (sessionIntro) {
      body = `${sessionIntro}\n\n${body}`;
    }
    return body;
  })();
  if (
    sessionCfg &&
    sendSystemOnce &&
    isFirstTurnInSession &&
    sessionStore &&
    sessionKey
  ) {
    sessionStore[sessionKey] = {
      ...(sessionStore[sessionKey] ?? {}),
      sessionId: sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
      systemSent: true,
    };
    await saveSessionStore(storePath, sessionStore);
    systemSent = true;
  }

  const prefixedBody =
    transcribedText && reply?.mode === "command"
      ? [prefixedBodyBase, `Transcript:\n${transcribedText}`]
          .filter(Boolean)
          .join("\n\n")
      : prefixedBodyBase;
  const mediaNote = ctx.MediaPath?.length
    ? `[media attached: ${ctx.MediaPath}${ctx.MediaType ? ` (${ctx.MediaType})` : ""}${ctx.MediaUrl ? ` | ${ctx.MediaUrl}` : ""}]`
    : undefined;
  // For command prompts we prepend the media note so Claude et al. see it; text replies stay clean.
  const mediaReplyHint =
    mediaNote && reply?.mode === "command"
      ? "To send an image back, add a line like: MEDIA:https://example.com/image.jpg (no spaces). Keep caption in the text body."
      : undefined;
  const commandBody = mediaNote
    ? [mediaNote, mediaReplyHint, prefixedBody ?? ""]
        .filter(Boolean)
        .join("\n")
        .trim()
    : prefixedBody;
  const templatingCtx: TemplateContext = {
    ...sessionCtx,
    Body: commandBody,
    BodyStripped: commandBody,
  };
  if (!reply) {
    logVerbose("No inbound.reply configured; skipping auto-reply");
    cleanupTyping();
    return undefined;
  }

  if (reply.mode === "text" && reply.text) {
    await onReplyStart();
    logVerbose("Using text auto-reply from config");
    const result = {
      text: applyTemplate(reply.text, templatingCtx),
      mediaUrl: reply.mediaUrl,
    };
    cleanupTyping();
    return result;
  }

  if (reply.mode === "command" && reply.command?.length) {
    await onReplyStart();
    let argv = reply.command.map((part) => applyTemplate(part, templatingCtx));
    const templatePrefix =
      reply.template && (!sendSystemOnce || isFirstTurnInSession || !systemSent)
        ? applyTemplate(reply.template, templatingCtx)
        : "";
    if (templatePrefix && argv.length > 0) {
      argv = [argv[0], templatePrefix, ...argv.slice(1)];
    }

    // Ensure Claude commands can emit plain text by forcing --output-format when configured.
    // We inject the flags only when the user points at the `claude` binary and has opted in via config,
    // so existing custom argv or non-Claude commands remain untouched.
    if (
      reply.claudeOutputFormat &&
      argv.length > 0 &&
      path.basename(argv[0]) === CLAUDE_BIN
    ) {
      const hasOutputFormat = argv.some(
        (part) =>
          part === "--output-format" || part.startsWith("--output-format="),
      );
      // Keep the final argument as the prompt/body; insert options just before it.
      const insertBeforeBody = Math.max(argv.length - 1, 0);
      if (!hasOutputFormat) {
        argv = [
          ...argv.slice(0, insertBeforeBody),
          "--output-format",
          reply.claudeOutputFormat,
          ...argv.slice(insertBeforeBody),
        ];
      }
      const hasPrintFlag = argv.some(
        (part) => part === "-p" || part === "--print",
      );
      if (!hasPrintFlag) {
        const insertIdx = Math.max(argv.length - 1, 0);
        argv = [...argv.slice(0, insertIdx), "-p", ...argv.slice(insertIdx)];
      }
    }

    // Inject session args if configured (use resume for existing, session-id for new)
    if (reply.session) {
      const sessionArgList = (
        isNewSession
          ? (reply.session.sessionArgNew ?? ["--session-id", "{{SessionId}}"])
          : (reply.session.sessionArgResume ?? ["--resume", "{{SessionId}}"])
      ).map((part) => applyTemplate(part, templatingCtx));
      if (sessionArgList.length) {
        const insertBeforeBody = reply.session.sessionArgBeforeBody ?? true;
        const insertAt =
          insertBeforeBody && argv.length > 1 ? argv.length - 1 : argv.length;
        argv = [
          ...argv.slice(0, insertAt),
          ...sessionArgList,
          ...argv.slice(insertAt),
        ];
      }
    }
    let finalArgv = argv;
    const isClaudeInvocation =
      finalArgv.length > 0 && path.basename(finalArgv[0]) === CLAUDE_BIN;
    if (isClaudeInvocation && finalArgv.length > 0) {
      const bodyIdx = finalArgv.length - 1;
      const existingBody = finalArgv[bodyIdx] ?? "";
      finalArgv = [
        ...finalArgv.slice(0, bodyIdx),
        [CLAUDE_IDENTITY_PREFIX, existingBody].filter(Boolean).join("\n\n"),
      ];
    }
    logVerbose(
      `Running command auto-reply: ${finalArgv.join(" ")}${reply.cwd ? ` (cwd: ${reply.cwd})` : ""}`,
    );
    const started = Date.now();
    try {
      const { stdout, stderr, code, signal, killed } = await enqueueCommand(
        () => commandRunner(finalArgv, { timeoutMs, cwd: reply.cwd }),
        {
          onWait: (waitMs, queuedAhead) => {
            if (isVerbose()) {
              logVerbose(
                `Command auto-reply queued for ${waitMs}ms (${queuedAhead} ahead)`,
              );
            }
          },
        },
      );
      const rawStdout = stdout.trim();
      let mediaFromCommand: string[] | undefined;
      let trimmed = rawStdout;
      if (stderr?.trim()) {
        logVerbose(`Command auto-reply stderr: ${stderr.trim()}`);
      }
      let parsed: ClaudeJsonParseResult | undefined;
      if (
        trimmed &&
        (reply.claudeOutputFormat === "json" || isClaudeInvocation)
      ) {
        // Claude JSON mode: extract the human text for both logging and reply while keeping metadata.
        parsed = parseClaudeJson(trimmed);
        if (parsed?.parsed && isVerbose()) {
          const summary = summarizeClaudeMetadata(parsed.parsed);
          if (summary) logVerbose(`Claude JSON meta: ${summary}`);
          logVerbose(
            `Claude JSON raw: ${JSON.stringify(parsed.parsed, null, 2)}`,
          );
        }
        if (parsed?.text) {
          logVerbose(
            `Claude JSON parsed -> ${parsed.text.slice(0, 120)}${parsed.text.length > 120 ? "…" : ""}`,
          );
          trimmed = parsed.text.trim();
        } else {
          logVerbose("Claude JSON parse failed; returning raw stdout");
        }
      }
      // Run media extraction once on the final human text (post-JSON parse if available).
      const { text: cleanedText, mediaUrls: mediaFound } =
        splitMediaFromOutput(trimmed);
      trimmed = cleanedText;
      if (mediaFound?.length) {
        mediaFromCommand = mediaFound;
        if (isVerbose()) logVerbose(`MEDIA token extracted: ${mediaFound}`);
      } else if (isVerbose()) {
        logVerbose("No MEDIA token extracted from final text");
      }
      if (!trimmed && !mediaFromCommand) {
        const meta = parsed
          ? summarizeClaudeMetadata(parsed.parsed)
          : undefined;
        trimmed = `(command produced no output${meta ? `; ${meta}` : ""})`;
        logVerbose("No text/media produced; injecting fallback notice to user");
      }
      logVerbose(
        `Command auto-reply stdout (trimmed): ${trimmed || "<empty>"}`,
      );
      logVerbose(`Command auto-reply finished in ${Date.now() - started}ms`);
      if ((code ?? 0) !== 0) {
        console.error(
          `Command auto-reply exited with code ${code ?? "unknown"} (signal: ${signal ?? "none"})`,
        );
        return undefined;
      }
      if (killed && !signal) {
        console.error(
          `Command auto-reply process killed before completion (exit code ${code ?? "unknown"})`,
        );
        return undefined;
      }
      const mediaUrls =
        mediaFromCommand ?? (reply.mediaUrl ? [reply.mediaUrl] : undefined);
      const result =
        trimmed || mediaUrls?.length
          ? {
              text: trimmed || undefined,
              mediaUrl: mediaUrls?.[0],
              mediaUrls,
            }
          : undefined;
      cleanupTyping();
      return result;
    } catch (err) {
      const elapsed = Date.now() - started;
      const anyErr = err as { killed?: boolean; signal?: string };
      const timeoutHit = anyErr.killed === true || anyErr.signal === "SIGKILL";
      const errorObj = err as {
        stdout?: string;
        stderr?: string;
      };
      if (errorObj.stderr?.trim()) {
        logVerbose(`Command auto-reply stderr: ${errorObj.stderr.trim()}`);
      }
      if (timeoutHit) {
        console.error(
          `Command auto-reply timed out after ${elapsed}ms (limit ${timeoutMs}ms)`,
        );
        const baseMsg = `Command timed out after ${timeoutSeconds}s. Try a shorter prompt or split the request.`;
        const partial = errorObj.stdout?.trim();
        const partialSnippet =
          partial && partial.length > 800
            ? `${partial.slice(0, 800)}...`
            : partial;
        const text = partialSnippet
          ? `${baseMsg}\n\nPartial output before timeout:\n${partialSnippet}`
          : baseMsg;
        const result = { text };
        cleanupTyping();
        return result;
      } else {
        logError(
          `Command auto-reply failed after ${elapsed}ms: ${String(err)}`,
        );
      }
      cleanupTyping();
      return undefined;
    }
  }

  cleanupTyping();
  return undefined;
}

type TwilioLikeClient = TwilioRequester & {
  messages: {
    create: (opts: {
      from?: string;
      to?: string;
      body: string;
    }) => Promise<unknown>;
  };
};

export async function autoReplyIfConfigured(
  client: TwilioLikeClient,
  message: MessageInstance,
  configOverride?: WarelayConfig,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  // Fire a config-driven reply (text or command) for the inbound message, if configured.
  const ctx: MsgContext = {
    Body: message.body ?? undefined,
    From: message.from ?? undefined,
    To: message.to ?? undefined,
    MessageSid: message.sid,
  };
  const cfg = configOverride ?? loadConfig();
  // Attach media hints for transcription/templates if present on Twilio payloads.
  const mediaUrl = (message as { mediaUrl?: string }).mediaUrl;
  if (mediaUrl) ctx.MediaUrl = mediaUrl;

  // Optional audio transcription before building reply.
  const mediaField = (message as { media?: unknown }).media;
  const mediaItems = Array.isArray(mediaField) ? mediaField : [];
  if (cfg.inbound?.transcribeAudio && mediaItems.length) {
    const media = mediaItems[0];
    const contentType = (media as { contentType?: string }).contentType;
    if (contentType?.startsWith("audio")) {
      const transcribed = await transcribeInboundAudio(cfg, ctx, runtime);
      if (transcribed?.text) {
        ctx.Body = transcribed.text;
        ctx.MediaType = contentType;
        logVerbose("Replaced Body with audio transcript for reply flow");
      }
    }
  }

  const replyResult = await getReplyFromConfig(
    ctx,
    {
      onReplyStart: () => sendTypingIndicator(client, runtime, message.sid),
    },
    cfg,
  );
  if (
    !replyResult ||
    (!replyResult.text &&
      !replyResult.mediaUrl &&
      !replyResult.mediaUrls?.length)
  )
    return;

  const replyFrom = message.to;
  const replyTo = message.from;
  if (!replyFrom || !replyTo) {
    if (isVerbose())
      console.error(
        "Skipping auto-reply: missing to/from on inbound message",
        ctx,
      );
    return;
  }

  if (replyResult.text) {
    logVerbose(
      `Auto-replying via Twilio: from ${replyFrom} to ${replyTo}, body length ${replyResult.text.length}`,
    );
  } else {
    logVerbose(
      `Auto-replying via Twilio: from ${replyFrom} to ${replyTo} (media)`,
    );
  }

  try {
    const mediaList = replyResult.mediaUrls?.length
      ? replyResult.mediaUrls
      : replyResult.mediaUrl
        ? [replyResult.mediaUrl]
        : [];

    const sendTwilio = async (body: string, media?: string) => {
      let resolvedMedia = media;
      if (resolvedMedia && !/^https?:\/\//i.test(resolvedMedia)) {
        const hosted = await ensureMediaHosted(resolvedMedia);
        resolvedMedia = hosted.url;
      }
      await client.messages.create({
        from: replyFrom,
        to: replyTo,
        body,
        ...(resolvedMedia ? { mediaUrl: [resolvedMedia] } : {}),
      });
    };

    if (mediaList.length === 0) {
      await sendTwilio(replyResult.text ?? "");
    } else {
      // First media with body (if any), then remaining as separate media-only sends.
      await sendTwilio(replyResult.text ?? "", mediaList[0]);
      for (const extra of mediaList.slice(1)) {
        await sendTwilio("", extra);
      }
    }
    if (isVerbose()) {
      console.log(
        info(
          `↩️  Auto-replied to ${replyTo} (sid ${message.sid ?? "no-sid"}${replyResult.mediaUrl ? ", media" : ""})`,
        ),
      );
    }
  } catch (err) {
    const anyErr = err as {
      code?: string | number;
      message?: unknown;
      moreInfo?: unknown;
      status?: string | number;
      response?: { body?: unknown };
    };
    const { code, status } = anyErr;
    const msg =
      typeof anyErr?.message === "string"
        ? anyErr.message
        : (anyErr?.message ?? err);
    runtime.error(
      `❌ Twilio send failed${code ? ` (code ${code})` : ""}${status ? ` status ${status}` : ""}: ${msg}`,
    );
    if (anyErr?.moreInfo) runtime.error(`More info: ${anyErr.moreInfo}`);
    const responseBody = anyErr?.response?.body;
    if (responseBody) {
      runtime.error("Response body:");
      runtime.error(JSON.stringify(responseBody, null, 2));
    }
  }
}

function isAudio(mediaType?: string | null) {
  return Boolean(mediaType?.startsWith("audio"));
}

async function transcribeInboundAudio(
  cfg: WarelayConfig,
  ctx: MsgContext,
  runtime: RuntimeEnv,
): Promise<{ text: string } | undefined> {
  const transcriber = cfg.inbound?.transcribeAudio;
  if (!transcriber?.command?.length) return undefined;

  const timeoutMs = Math.max((transcriber.timeoutSeconds ?? 45) * 1000, 1_000);
  let tmpPath: string | undefined;
  let mediaPath = ctx.MediaPath;
  try {
    if (!mediaPath && ctx.MediaUrl) {
      const res = await fetch(ctx.MediaUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const arrayBuf = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      tmpPath = path.join(
        os.tmpdir(),
        `warelay-audio-${crypto.randomUUID()}.ogg`,
      );
      await fs.writeFile(tmpPath, buffer);
      mediaPath = tmpPath;
      if (isVerbose()) {
        logVerbose(
          `Downloaded audio for transcription (${(buffer.length / (1024 * 1024)).toFixed(2)}MB) -> ${tmpPath}`,
        );
      }
    }
    if (!mediaPath) return undefined;

    const templCtx: MsgContext = { ...ctx, MediaPath: mediaPath };
    const argv = transcriber.command.map((part) =>
      applyTemplate(part, templCtx),
    );
    if (isVerbose()) {
      logVerbose(`Transcribing audio via command: ${argv.join(" ")}`);
    }
    const { stdout } = await runExec(argv[0], argv.slice(1), {
      timeoutMs,
      maxBuffer: 5 * 1024 * 1024,
    });
    const text = stdout.trim();
    if (!text) return undefined;
    return { text };
  } catch (err) {
    runtime.error?.(`Audio transcription failed: ${String(err)}`);
    return undefined;
  } finally {
    if (tmpPath) {
      void fs.unlink(tmpPath).catch(() => {});
    }
  }
}
