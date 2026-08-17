import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  readSessionTitleFieldsFromTranscript,
  readSessionTitleFieldsFromTranscriptBatch,
} from "./session-transcript-title-reader.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session transcript Markdown title previews", () => {
  let stateDir: string;
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
    stateDir = tempDirs.make("openclaw-transcript-title-markdown-");
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
  });

  async function writeMessages(
    sessionId: string,
    messages: Array<{ content: unknown; role: string }>,
  ) {
    const scope = {
      agentId: "main",
      sessionId,
      sessionKey: `agent:main:${sessionId}`,
      storePath: path.join(stateDir, "sessions.json"),
    };
    await persistSessionTranscriptTurn(scope, {
      messages: messages.map((message) => ({ message })),
      touchSessionEntry: false,
    });
    return scope;
  }

  test.each(["single", "batch"] as const)(
    "flattens last-message Markdown in the %s title reader",
    async (mode) => {
      const scope = await writeMessages(`reader-title-markdown-${mode}`, [
        { role: "user", content: "Keep **title Markdown** unchanged" },
        {
          role: "assistant",
          content:
            "# Done\n\nLanded [PR #124879](https://github.com/openclaw/openclaw/pull/124879) with **green** CI.",
        },
      ]);
      const fields =
        mode === "single"
          ? readSessionTitleFieldsFromTranscript(scope)
          : readSessionTitleFieldsFromTranscriptBatch([scope])[0];

      expect(fields).toEqual({
        firstUserMessage: "Keep **title Markdown** unchanged",
        lastMessagePreview: "Done Landed PR #124879 with green CI.",
      });
    },
  );

  test.each(["single", "batch"] as const)(
    "returns no %s title preview when Markdown flattens to empty",
    async (mode) => {
      const scope = await writeMessages(`reader-title-empty-markdown-${mode}`, [
        { role: "assistant", content: "```ts\nconst hidden = true;\n```" },
      ]);
      const fields =
        mode === "single"
          ? readSessionTitleFieldsFromTranscript(scope)
          : readSessionTitleFieldsFromTranscriptBatch([scope])[0];

      expect(fields?.lastMessagePreview).toBeNull();
    },
  );
});
