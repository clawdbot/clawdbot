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

const PROMPT = "Run the deployment script for staging now";

describe("rotateTranscriptAfterCompaction post-compaction duplicate", () => {
  it("keeps a real post-compaction user turn that repeats a kept-tail prompt", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "successor-dup-post-"));
    const manager = SessionManager.create(tmpDir, tmpDir);

    manager.appendMessage({ role: "user", content: "set up the project", timestamp: 1000 });
    manager.appendMessage(makeAssistant("Project ready.", 1001));

    const firstKeptId = manager.appendMessage({
      role: "user",
      content: PROMPT,
      timestamp: 2000,
    });
    manager.appendMessage(makeAssistant("Deploying to staging.", 2001));
    manager.appendCompaction("Summary of project setup.", firstKeptId, 2050);

    manager.appendMessage({ role: "user", content: PROMPT, timestamp: 2080 });
    manager.appendMessage(makeAssistant("Redeploying to staging (second run).", 2081));

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

    const occurrences = userPromptTexts.filter((text) => text.includes(PROMPT)).length;
    expect(occurrences).toBe(2);
  });
});
