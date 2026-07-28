import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { resolveStorePath } from "./paths.js";
import { createSessionEntryWithTranscript, loadSessionEntry } from "./session-accessor.js";

const sessionKey = "agent:main:dashboard:incognito-round-trip";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("incognito transcript access", () => {
  it("round-trips two turns through the normal marker-backed SessionManager", async () => {
    const cwd = fs.realpathSync(
      fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "incognito-turns-")),
    );
    try {
      const created = await createSessionEntryWithTranscript(
        { agentId: "main", sessionKey },
        () => ({
          ok: true as const,
          entry: {
            incognito: true as const,
            sessionId: "incognito-session",
            updatedAt: 1,
          },
        }),
      );
      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }
      const durableStorePath = path.join(cwd, "sessions.json");
      expect(
        loadSessionEntry({
          agentId: "main",
          sessionKey,
          storePath: durableStorePath,
        })?.incognito,
      ).toBe(true);
      expect(fs.existsSync(durableStorePath)).toBe(false);

      const target = {
        agentId: "main",
        sessionId: created.entry.sessionId,
        sessionKey,
        storePath: resolveStorePath(undefined, { agentId: "main" }),
      };
      const firstTurn = SessionManager.open(target, cwd);
      firstTurn.appendMessage({ role: "user", content: "first question", timestamp: 1 });
      firstTurn.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "first answer" }],
        api: "openai-responses",
        provider: "openai",
        model: "gpt-test",
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 2,
      });

      const secondTurn = SessionManager.open(target, cwd);
      secondTurn.appendMessage({ role: "user", content: "second question", timestamp: 3 });
      const messages = secondTurn.buildSessionContext().messages;

      expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
      expect(messages[0]).toMatchObject({ content: "first question" });
      expect(messages[2]).toMatchObject({ content: "second question" });
    } finally {
      fs.rmSync(cwd, { force: true, recursive: true });
    }
  });
});
