import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import JSON5 from "json5";

import { CONFIG_DIR, normalizeE164 } from "../utils.js";
import type { MsgContext } from "../auto-reply/templating.js";

export type SessionScope = "per-sender" | "global";

export type SessionEntry = { sessionId: string; updatedAt: number };

export const SESSION_STORE_DEFAULT = path.join(CONFIG_DIR, "sessions.json");
export const DEFAULT_RESET_TRIGGER = "/new";
export const DEFAULT_IDLE_MINUTES = 60;

export function resolveStorePath(store?: string) {
	if (!store) return SESSION_STORE_DEFAULT;
	if (store.startsWith("~"))
		return path.resolve(store.replace("~", os.homedir()));
	return path.resolve(store);
}

export function loadSessionStore(storePath: string): Record<string, SessionEntry> {
	try {
		const raw = fs.readFileSync(storePath, "utf-8");
		const parsed = JSON5.parse(raw);
		if (parsed && typeof parsed === "object") {
			return parsed as Record<string, SessionEntry>;
		}
	} catch {
		// ignore missing/invalid store; we'll recreate it
	}
	return {};
}

export async function saveSessionStore(
	storePath: string,
	store: Record<string, SessionEntry>,
) {
	await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
	await fs.promises.writeFile(
		storePath,
		JSON.stringify(store, null, 2),
		"utf-8",
	);
}

export function deriveSessionKey(scope: SessionScope, ctx: MsgContext) {
	if (scope === "global") return "global";
	const from = ctx.From ? normalizeE164(ctx.From) : "";
	return from || "unknown";
}
