import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";

export type ReplyMode = "text" | "command";
export type ClaudeOutputFormat = "text" | "json" | "stream-json";
export type SessionScope = "per-sender" | "global";

export type SessionConfig = {
	scope?: SessionScope;
	resetTriggers?: string[];
	idleMinutes?: number;
	store?: string;
	sessionArgNew?: string[];
	sessionArgResume?: string[];
	sessionArgBeforeBody?: boolean;
};

export type WarelayConfig = {
	inbound?: {
		allowFrom?: string[]; // E.164 numbers allowed to trigger auto-reply (without whatsapp:)
		reply?: {
			mode: ReplyMode;
			text?: string; // for mode=text, can contain {{Body}}
			command?: string[]; // for mode=command, argv with templates
			template?: string; // prepend template string when building command/prompt
			timeoutSeconds?: number; // optional command timeout; defaults to 600s
			bodyPrefix?: string; // optional string prepended to Body before templating
			session?: SessionConfig;
			claudeOutputFormat?: ClaudeOutputFormat; // when command starts with `claude`, force an output format
		};
	};
};

export const CONFIG_PATH = path.join(os.homedir(), ".warelay", "warelay.json");

export function loadConfig(): WarelayConfig {
	// Read ~/.warelay/warelay.json (JSON5) if present.
	try {
		if (!fs.existsSync(CONFIG_PATH)) return {};
		const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
		const parsed = JSON5.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return {};
		return parsed as WarelayConfig;
	} catch (err) {
		console.error(`Failed to read config at ${CONFIG_PATH}`, err);
		return {};
	}
}
