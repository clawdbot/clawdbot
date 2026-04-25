import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { onSessionTranscriptUpdate } from "../../../sessions/transcript-events.js";
import { rewriteSubmittedPromptTranscript } from "./transcript-prompt-rewrite.js";

type AppendMessage = Parameters<SessionManager["appendMessage"]>[0];

let tmpDir: string | undefined;

async function createTmpDir(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "transcript-prompt-rewrite-"));
  return tmpDir;
}

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    tmpDir = undefined;
  }
});

function getUserTextMessages(sessionManager: SessionManager): string[] {
  const messages: string[] = [];
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "user") {
      continue;
    }
    const content = (entry.message as { content?: unknown }).content;
    if (typeof content === "string") {
      messages.push(content);
      continue;
    }
    if (!Array.isArray(content)) {
      messages.push("");
      continue;
    }
    messages.push(
      content
        .map((block) =>
          block &&
          typeof block === "object" &&
          typeof (block as { text?: unknown }).text === "string"
            ? (block as { text: string }).text
            : "",
        )
        .join(""),
    );
  }
  return messages;
}

describe("rewriteSubmittedPromptTranscript", () => {
  it("rewrites only the submitted embedded Pi prompt in a real session file", async () => {
    const sessionDir = await createTmpDir();
    const sessionManager = SessionManager.create(sessionDir, sessionDir);
    const submittedPrompt =
      "visible ask\n\n<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\nsecret runtime context\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    const transcriptPrompt = "visible ask";

    sessionManager.appendMessage({
      role: "user",
      content: submittedPrompt,
      timestamp: 1,
    });
    const previousLeafId = sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
      timestamp: 2,
    } as AppendMessage);
    sessionManager.appendMessage({
      role: "user",
      content: submittedPrompt,
      timestamp: 3,
    });
    const sessionFile = sessionManager.getSessionFile();
    expect(sessionFile).toBeTruthy();

    const listener = vi.fn();
    const cleanup = onSessionTranscriptUpdate(listener);
    try {
      rewriteSubmittedPromptTranscript({
        sessionManager,
        sessionFile: sessionFile!,
        previousLeafId,
        submittedPrompt,
        transcriptPrompt,
      });
    } finally {
      cleanup();
    }

    expect(listener).toHaveBeenCalledWith({ sessionFile });

    const reopenedSession = SessionManager.open(sessionFile!);
    expect(getUserTextMessages(reopenedSession)).toEqual([submittedPrompt, transcriptPrompt]);
  });
});
