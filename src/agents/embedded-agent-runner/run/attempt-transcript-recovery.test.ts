import path from "node:path";
import { expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { AgentMessage } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { stripSessionsYieldArtifacts } from "./attempt-sessions-yield.js";
import {
  normalizeCompactionRecoveryTranscriptTail,
  removeTrailingMidTurnPrecheckAssistantError,
} from "./attempt-transcript-helpers.js";
import { MID_TURN_PRECHECK_ERROR_MESSAGE } from "./midturn-precheck.js";

it.each(["yield", "precheck", "compaction"])(
  "publishes %s recovery only after the transcript rewrite commits",
  async (recovery) => {
    await withOpenClawTestState({ label: "transcript-recovery" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "recovery",
        sessionKey: "agent:main:recovery",
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      const sessionManager = SessionManager.open(target, state.workspaceDir);
      const user: AgentMessage = { role: "user", content: "continue", timestamp: 1 };
      const error: AgentMessage = {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "openai",
        model: "test-model",
        stopReason: "error",
        errorMessage: MID_TURN_PRECHECK_ERROR_MESSAGE,
        timestamp: 2,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      sessionManager.appendMessage(user);
      sessionManager.appendMessage(error);
      sessionManager.appendCustomEntry("preserved-state", { retained: true });
      const messages = [user, error];
      const activeSession = { messages, agent: { state: { messages } }, sessionManager };
      const cleanup = () => {
        if (recovery === "yield") {
          stripSessionsYieldArtifacts(activeSession);
        } else if (recovery === "precheck") {
          removeTrailingMidTurnPrecheckAssistantError({ activeSession, sessionManager });
        } else {
          normalizeCompactionRecoveryTranscriptTail({ activeSession, sessionManager });
        }
      };
      const database = openOpenClawAgentDatabase({ agentId: "main", path: target.storePath });
      database.db.exec(`CREATE TRIGGER reject_recovery BEFORE INSERT ON transcript_events
        BEGIN SELECT RAISE(ABORT, 'recovery write failed'); END;`);

      expect(cleanup).toThrow("recovery write failed");
      expect(activeSession.agent.state.messages).toEqual(messages);
      expect(sessionManager.buildSessionContext().messages).toEqual(messages);

      database.db.exec("DROP TRIGGER reject_recovery");
      cleanup();
      expect(activeSession.agent.state.messages).toEqual([user]);
      expect(SessionManager.open(target).buildSessionContext().messages).toEqual([user]);
      expect(sessionManager.getEntries()).toEqual(
        expect.arrayContaining([expect.objectContaining({ customType: "preserved-state" })]),
      );
    });
  },
);
