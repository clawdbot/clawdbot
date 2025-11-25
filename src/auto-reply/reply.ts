import crypto from "node:crypto";
import path from "node:path";

import { CLAUDE_BIN, parseClaudeJsonText } from "./claude.js";
import {
	applyTemplate,
	type MsgContext,
	type TemplateContext,
} from "./templating.js";
import {
	DEFAULT_IDLE_MINUTES,
	DEFAULT_RESET_TRIGGER,
	deriveSessionKey,
	loadSessionStore,
	resolveStorePath,
	saveSessionStore,
} from "../config/sessions.js";
import {
	type WarelayConfig,
	loadConfig,
} from "../config/config.js";
import {
	danger,
	info,
	isVerbose,
	logVerbose,
	warn,
} from "../globals.js";
import { normalizeE164, withWhatsAppPrefix } from "../utils.js";
import {
	runCommandWithTimeout,
	type SpawnResult,
} from "../process/exec.js";
import { sendTypingIndicator } from "../twilio/typing.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import type { MessageInstance } from "twilio/lib/rest/api/v2010/account/message.js";

type GetReplyOptions = {
	onReplyStart?: () => Promise<void> | void;
};

export async function getReplyFromConfig(
	ctx: MsgContext,
	opts?: GetReplyOptions,
	configOverride?: WarelayConfig,
	commandRunner: typeof runCommandWithTimeout = runCommandWithTimeout,
): Promise<string | undefined> {
	// Choose reply from config: static text or external command stdout.
	const cfg = configOverride ?? loadConfig();
	const reply = cfg.inbound?.reply;
	const timeoutSeconds = Math.max(reply?.timeoutSeconds ?? 600, 1);
	const timeoutMs = timeoutSeconds * 1000;
	let started = false;
	const onReplyStart = async () => {
		if (started) return;
		started = true;
		await opts?.onReplyStart?.();
	};

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

	let sessionId: string | undefined;
	let isNewSession = false;
	let bodyStripped: string | undefined;

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

		const sessionKey = deriveSessionKey(sessionScope, ctx);
		const store = loadSessionStore(storePath);
		const entry = store[sessionKey];
		const idleMs = idleMinutes * 60_000;
		const freshEntry = entry && Date.now() - entry.updatedAt <= idleMs;

		if (!isNewSession && freshEntry) {
			sessionId = entry.sessionId;
		} else {
			sessionId = crypto.randomUUID();
			isNewSession = true;
		}

		store[sessionKey] = { sessionId, updatedAt: Date.now() };
		await saveSessionStore(storePath, store);
	}

	const sessionCtx: TemplateContext = {
		...ctx,
		BodyStripped: bodyStripped ?? ctx.Body,
		SessionId: sessionId,
		IsNewSession: isNewSession ? "true" : "false",
	};

	// Optional prefix injected before Body for templating/command prompts.
	const bodyPrefix = reply?.bodyPrefix
		? applyTemplate(reply.bodyPrefix, sessionCtx)
		: "";
	const prefixedBody = bodyPrefix
		? `${bodyPrefix}${sessionCtx.BodyStripped ?? sessionCtx.Body ?? ""}`
		: (sessionCtx.BodyStripped ?? sessionCtx.Body);
	const templatingCtx: TemplateContext = {
		...sessionCtx,
		Body: prefixedBody,
		BodyStripped: prefixedBody,
	};

	// Optional allowlist by origin number (E.164 without whatsapp: prefix)
	const allowFrom = cfg.inbound?.allowFrom;
	if (Array.isArray(allowFrom) && allowFrom.length > 0) {
		const from = (ctx.From ?? "").replace(/^whatsapp:/, "");
		if (!allowFrom.includes(from)) {
			logVerbose(
				`Skipping auto-reply: sender ${from || "<unknown>"} not in allowFrom list`,
			);
			return undefined;
		}
	}
	if (!reply) {
		logVerbose("No inbound.reply configured; skipping auto-reply");
		return undefined;
	}

	if (reply.mode === "text" && reply.text) {
		await onReplyStart();
		logVerbose("Using text auto-reply from config");
		return applyTemplate(reply.text, templatingCtx);
	}

	if (reply.mode === "command" && reply.command?.length) {
		await onReplyStart();
		let argv = reply.command.map((part) => applyTemplate(part, templatingCtx));
		const templatePrefix = reply.template
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
		const finalArgv = argv;
		logVerbose(`Running command auto-reply: ${finalArgv.join(" ")}`);
		const started = Date.now();
		try {
			const { stdout, stderr, code, signal, killed } = await commandRunner(
				finalArgv,
				timeoutMs,
			);
			let trimmed = stdout.trim();
			if (stderr?.trim()) {
				logVerbose(`Command auto-reply stderr: ${stderr.trim()}`);
			}
			if (reply.claudeOutputFormat === "json" && trimmed) {
				// Claude JSON mode: extract the human text for both logging and reply.
				const extracted = parseClaudeJsonText(trimmed);
				if (extracted) {
					logVerbose(
						`Claude JSON parsed -> ${extracted.slice(0, 120)}${extracted.length > 120 ? "…" : ""}`,
					);
					trimmed = extracted.trim();
				} else {
					logVerbose("Claude JSON parse failed; returning raw stdout");
				}
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
			return trimmed || undefined;
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
			} else {
				console.error(`Command auto-reply failed after ${elapsed}ms`, err);
			}
			return undefined;
		}
	}

	return undefined;
}

type TwilioLikeClient = {
	messages: {
		create: (opts: { from?: string; to?: string; body: string }) => Promise<unknown>;
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

	const replyText = await getReplyFromConfig(
		ctx,
		{
			onReplyStart: () => sendTypingIndicator(client, message.sid, runtime),
		},
		configOverride,
	);
	if (!replyText) return;

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

	logVerbose(
		`Auto-replying via Twilio: from ${replyFrom} to ${replyTo}, body length ${replyText.length}`,
	);

	try {
		await client.messages.create({
			from: replyFrom,
			to: replyTo,
			body: replyText,
		});
		if (isVerbose()) {
			console.log(
				info(
					`↩️  Auto-replied to ${replyTo} (sid ${message.sid ?? "no-sid"})`,
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
