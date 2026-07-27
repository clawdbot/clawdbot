import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it } from "vitest";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { rotateTranscriptAfterCompaction } from "./compaction-successor-transcript.js";
import { readTranscriptFileState } from "./transcript-file-state.js";

let tmpDir: string | undefined;
afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    tmpDir = undefined;
  }
});

function makeAssistant(text: string, timestamp: number) {
  return makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp });
}

function readUserTexts(entries: { type: string; message?: unknown }[]): string[] {
  return entries
    .filter(
      (entry) =>
        entry.type === "message" &&
        (entry.message as { role?: unknown } | undefined)?.role === "user",
    )
    .map((entry) => {
      const content = (entry.message as { content?: unknown } | undefined)?.content;
      if (typeof content === "string") {
        return content;
      }
      if (Array.isArray(content)) {
        return content.map((block) => (block as { text?: string })?.text ?? "").join("");
      }
      return "";
    });
}

const PROMPT = "Please refactor the authentication module right now";

describe("rotateTranscriptAfterCompaction duplicate-prompt preservation", () => {
  it("keeps a kept-tail prompt whose earlier copy was summarized away", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "successor-dup-loss-"));
    const manager = SessionManager.create(tmpDir, tmpDir);

    manager.appendMessage({ role: "user", content: PROMPT, timestamp: 1000 });
    manager.appendMessage(makeAssistant("Working on it.", 1001));
    const firstKeptId = manager.appendMessage({
      role: "user",
      content: "go on",
      timestamp: 1002,
    });
    manager.appendMessage(makeAssistant("Continuing.", 1003));
    manager.appendCompaction("Summary of earlier turns.", firstKeptId, 5000);
    manager.appendMessage({ role: "user", content: PROMPT, timestamp: 40000 });
    manager.appendMessage(makeAssistant("On it again.", 40001));

    const sessionFile = manager.getSessionFile();
    if (!sessionFile) {
      throw new Error("no session file");
    }

    const result = await rotateTranscriptAfterCompaction({ sessionManager: manager, sessionFile });
    expect(result.rotated).toBe(true);
    const successorFile = result.sessionFile;
    if (!successorFile) {
      throw new Error("no successor file");
    }

    const successor = await readTranscriptFileState(successorFile);
    const userPromptTexts = readUserTexts(
      successor.getEntries() as { type: string; message?: unknown }[],
    );

    expect(userPromptTexts.some((text) => text.includes(PROMPT))).toBe(true);
  });
});
