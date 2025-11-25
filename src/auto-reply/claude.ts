// Helpers specific to Claude CLI output/argv handling.

export const CLAUDE_BIN = "claude";

function extractClaudeText(payload: unknown): string | undefined {
	// Best-effort walker to find the primary text field in Claude JSON outputs.
	if (payload == null) return undefined;
	if (typeof payload === "string") return payload;
	if (Array.isArray(payload)) {
		for (const item of payload) {
			const found = extractClaudeText(item);
			if (found) return found;
		}
		return undefined;
	}
	if (typeof payload === "object") {
		const obj = payload as Record<string, unknown>;
		if (typeof obj.text === "string") return obj.text;
		if (typeof obj.completion === "string") return obj.completion;
		if (typeof obj.output === "string") return obj.output;
		if (obj.message) {
			const inner = extractClaudeText(obj.message);
			if (inner) return inner;
		}
		if (Array.isArray(obj.messages)) {
			const inner = extractClaudeText(obj.messages);
			if (inner) return inner;
		}
		if (Array.isArray(obj.content)) {
			for (const block of obj.content) {
				if (
					block &&
					typeof block === "object" &&
					(block as { type?: string }).type === "text" &&
					typeof (block as { text?: unknown }).text === "string"
				) {
					return (block as { text: string }).text;
				}
				const inner = extractClaudeText(block);
				if (inner) return inner;
			}
		}
	}
	return undefined;
}

export function parseClaudeJsonText(raw: string): string | undefined {
	// Handle a single JSON blob or newline-delimited JSON; return the first extracted text.
	const candidates = [raw, ...raw.split(/\n+/).map((s) => s.trim()).filter(Boolean)];
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			const text = extractClaudeText(parsed);
			if (text) return text;
		} catch {
			// ignore parse errors; try next candidate
		}
	}
	return undefined;
}
