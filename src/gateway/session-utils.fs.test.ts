import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	readFirstUserMessageFromTranscript,
	readLastMessagePreviewFromTranscript,
} from "./session-utils.fs.js";

describe("readFirstUserMessageFromTranscript", () => {
	let tmpDir: string;
	let storePath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-session-fs-test-"));
		storePath = path.join(tmpDir, "sessions.json");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("returns null when transcript file does not exist", () => {
		const result = readFirstUserMessageFromTranscript("nonexistent-session", storePath);
		expect(result).toBeNull();
	});

	test("returns first user message from transcript with string content", () => {
		const sessionId = "test-session-1";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		const lines = [
			JSON.stringify({ type: "session", version: 1, id: sessionId }),
			JSON.stringify({ message: { role: "user", content: "Hello world" } }),
			JSON.stringify({ message: { role: "assistant", content: "Hi there" } }),
		];
		fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

		const result = readFirstUserMessageFromTranscript(sessionId, storePath);
		expect(result).toBe("Hello world");
	});

	test("returns first user message from transcript with array content", () => {
		const sessionId = "test-session-2";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		const lines = [
			JSON.stringify({ type: "session", version: 1, id: sessionId }),
			JSON.stringify({
				message: {
					role: "user",
					content: [{ type: "text", text: "Array message content" }],
				},
			}),
		];
		fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

		const result = readFirstUserMessageFromTranscript(sessionId, storePath);
		expect(result).toBe("Array message content");
	});

	test("skips non-user messages to find first user message", () => {
		const sessionId = "test-session-3";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		const lines = [
			JSON.stringify({ type: "session", version: 1, id: sessionId }),
			JSON.stringify({ message: { role: "system", content: "System prompt" } }),
			JSON.stringify({ message: { role: "assistant", content: "Greeting" } }),
			JSON.stringify({ message: { role: "user", content: "First user question" } }),
		];
		fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

		const result = readFirstUserMessageFromTranscript(sessionId, storePath);
		expect(result).toBe("First user question");
	});

	test("returns null when no user messages exist", () => {
		const sessionId = "test-session-4";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		const lines = [
			JSON.stringify({ type: "session", version: 1, id: sessionId }),
			JSON.stringify({ message: { role: "system", content: "System prompt" } }),
			JSON.stringify({ message: { role: "assistant", content: "Greeting" } }),
		];
		fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

		const result = readFirstUserMessageFromTranscript(sessionId, storePath);
		expect(result).toBeNull();
	});

	test("handles malformed JSON lines gracefully", () => {
		const sessionId = "test-session-5";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		const lines = [
			"not valid json",
			JSON.stringify({ message: { role: "user", content: "Valid message" } }),
		];
		fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

		const result = readFirstUserMessageFromTranscript(sessionId, storePath);
		expect(result).toBe("Valid message");
	});

	test("uses sessionFile parameter when provided", () => {
		const sessionId = "test-session-6";
		const customPath = path.join(tmpDir, "custom-transcript.jsonl");
		const lines = [
			JSON.stringify({ type: "session", version: 1, id: sessionId }),
			JSON.stringify({ message: { role: "user", content: "Custom file message" } }),
		];
		fs.writeFileSync(customPath, lines.join("\n"), "utf-8");

		const result = readFirstUserMessageFromTranscript(sessionId, storePath, customPath);
		expect(result).toBe("Custom file message");
	});

	test("trims whitespace from message content", () => {
		const sessionId = "test-session-7";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		const lines = [JSON.stringify({ message: { role: "user", content: "  Padded message  " } })];
		fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

		const result = readFirstUserMessageFromTranscript(sessionId, storePath);
		expect(result).toBe("Padded message");
	});

	test("returns null for empty content", () => {
		const sessionId = "test-session-8";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		const lines = [
			JSON.stringify({ message: { role: "user", content: "" } }),
			JSON.stringify({ message: { role: "user", content: "Second message" } }),
		];
		fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

		const result = readFirstUserMessageFromTranscript(sessionId, storePath);
		expect(result).toBe("Second message");
	});
});

describe("readLastMessagePreviewFromTranscript", () => {
	let tmpDir: string;
	let storePath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawdbot-session-fs-test-"));
		storePath = path.join(tmpDir, "sessions.json");
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	test("returns null when transcript file does not exist", () => {
		const result = readLastMessagePreviewFromTranscript("nonexistent-session", storePath);
		expect(result).toBeNull();
	});

	test("returns null for empty file", () => {
		const sessionId = "test-last-empty";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		fs.writeFileSync(transcriptPath, "", "utf-8");

		const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
		expect(result).toBeNull();
	});

	test("returns last user message from transcript", () => {
		const sessionId = "test-last-user";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		const lines = [
			JSON.stringify({ message: { role: "user", content: "First user" } }),
			JSON.stringify({ message: { role: "assistant", content: "First assistant" } }),
			JSON.stringify({ message: { role: "user", content: "Last user message" } }),
		];
		fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

		const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
		expect(result).toBe("Last user message");
	});

	test("returns last assistant message from transcript", () => {
		const sessionId = "test-last-assistant";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		const lines = [
			JSON.stringify({ message: { role: "user", content: "User question" } }),
			JSON.stringify({ message: { role: "assistant", content: "Final assistant reply" } }),
		];
		fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

		const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
		expect(result).toBe("Final assistant reply");
	});

	test("skips system messages to find last user/assistant", () => {
		const sessionId = "test-last-skip-system";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		const lines = [
			JSON.stringify({ message: { role: "user", content: "Real last" } }),
			JSON.stringify({ message: { role: "system", content: "System at end" } }),
		];
		fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

		const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
		expect(result).toBe("Real last");
	});

	test("returns null when no user/assistant messages exist", () => {
		const sessionId = "test-last-no-match";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		const lines = [
			JSON.stringify({ type: "session", version: 1, id: sessionId }),
			JSON.stringify({ message: { role: "system", content: "Only system" } }),
		];
		fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

		const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
		expect(result).toBeNull();
	});

	test("handles malformed JSON lines gracefully", () => {
		const sessionId = "test-last-malformed";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		const lines = [
			JSON.stringify({ message: { role: "user", content: "Valid first" } }),
			"not valid json at end",
		];
		fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

		const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
		expect(result).toBe("Valid first");
	});

	test("handles array content format", () => {
		const sessionId = "test-last-array";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		const lines = [
			JSON.stringify({
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Array content response" }],
				},
			}),
		];
		fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

		const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
		expect(result).toBe("Array content response");
	});

	test("uses sessionFile parameter when provided", () => {
		const sessionId = "test-last-custom";
		const customPath = path.join(tmpDir, "custom-last.jsonl");
		const lines = [JSON.stringify({ message: { role: "user", content: "Custom file last" } })];
		fs.writeFileSync(customPath, lines.join("\n"), "utf-8");

		const result = readLastMessagePreviewFromTranscript(sessionId, storePath, customPath);
		expect(result).toBe("Custom file last");
	});

	test("trims whitespace from message content", () => {
		const sessionId = "test-last-trim";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		const lines = [
			JSON.stringify({ message: { role: "assistant", content: "  Padded response  " } }),
		];
		fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

		const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
		expect(result).toBe("Padded response");
	});

	test("skips empty content to find previous message", () => {
		const sessionId = "test-last-skip-empty";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		const lines = [
			JSON.stringify({ message: { role: "assistant", content: "Has content" } }),
			JSON.stringify({ message: { role: "user", content: "" } }),
		];
		fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

		const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
		expect(result).toBe("Has content");
	});

	test("reads from end of large file (16KB window)", () => {
		const sessionId = "test-last-large";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		const padding = JSON.stringify({ message: { role: "user", content: "x".repeat(500) } });
		const lines: string[] = [];
		for (let i = 0; i < 50; i++) {
			lines.push(padding);
		}
		lines.push(JSON.stringify({ message: { role: "assistant", content: "Last in large file" } }));
		fs.writeFileSync(transcriptPath, lines.join("\n"), "utf-8");

		const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
		expect(result).toBe("Last in large file");
	});

	test("handles valid UTF-8 content", () => {
		const sessionId = "test-last-utf8";
		const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
		const validLine = JSON.stringify({
			message: { role: "user", content: "Valid UTF-8: 你好世界 🌍" },
		});
		fs.writeFileSync(transcriptPath, validLine, "utf-8");

		const result = readLastMessagePreviewFromTranscript(sessionId, storePath);
		expect(result).toBe("Valid UTF-8: 你好世界 🌍");
	});
});
