import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readSessionTranscriptRawDelta } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { formatSqliteSessionFileMarker } from "../../config/sessions/legacy-sqlite-marker.js";
import { upsertSessionEntry } from "../../config/sessions/session-accessor.js";
import { createCliDispatchTranscriptRecorder } from "./cli-backend-dispatch-transcript.js";

const tempPaths: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cli-dispatch-transcript-"));
  tempPaths.push(dir);
  return dir;
}

describe("CLI dispatch transcript attachment persistence", () => {
  afterEach(async () => {
    await Promise.all(
      tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("persists a redacted continue_delegate tool call rather than its inline snapshot bytes", async () => {
    const cwd = await makeTempDir();
    const target = {
      agentId: "main",
      sessionId: "cli-dispatch-redaction",
      sessionKey: "agent:main:cli-dispatch-redaction",
      storePath: path.join(cwd, "sessions.json"),
    };
    const sessionFile = formatSqliteSessionFileMarker(target);
    await upsertSessionEntry(target, {
      sessionFile,
      sessionId: target.sessionId,
      updatedAt: 1,
    });

    const recorder = createCliDispatchTranscriptRecorder({
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      agentId: target.agentId,
      sessionFile,
      runId: "cli-dispatch-redaction-run",
      prompt: "persist this tool call",
      provider: "test-cli",
      cwd,
    });
    const secret = "CLI_DISPATCH_PERSISTED_ATTACHMENT_SECRET";
    recorder.noteToolEvent({
      phase: "start",
      toolName: "continue_delegate",
      args: {
        task: "carry the snapshot",
        attachments: [{ name: "brief.md", content: secret }],
      },
    });
    await recorder.finalize();

    const persisted = await readSessionTranscriptRawDelta({
      ...target,
      maxBytes: 100_000,
      maxEvents: 100,
    });
    expect(persisted.kind).toBe("page");
    if (persisted.kind !== "page") {
      throw new Error(`expected transcript page, got ${persisted.kind}`);
    }
    const persistedBytes = JSON.stringify(persisted.events);
    expect(persistedBytes).not.toContain(secret);
    expect(persistedBytes).toContain("__OPENCLAW_REDACTED__");
  });
});
