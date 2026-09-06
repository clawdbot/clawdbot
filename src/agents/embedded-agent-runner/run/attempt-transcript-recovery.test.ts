import path from "node:path";
import { expect, it } from "vitest";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { AgentMessage } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { stripSessionsYieldArtifacts } from "./attempt-sessions-yield.js";
import {
  normalizeCompactionRecoveryTranscriptTail,
  removeTrailingMidTurnPrecheckAssistantError,
} from "./attempt-transcript-helpers.js";
import { MidTurnPrecheckSignal } from "./midturn-precheck.js";

const MID_TURN_PRECHECK_ERROR_MESSAGE = new MidTurnPrecheckSignal({
  route: "compact_only",
  estimatedPromptTokens: 1100,
  promptBudgetBeforeReserve: 1000,
  overflowTokens: 100,
  toolResultReducibleChars: 0,
  effectiveReserveTokens: 100,
}).message;

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
        usage: createZeroUsageFixture(),
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

it("keeps a mid-turn routing error out of durable history and resumes without a rewrite", async () => {
  await withOpenClawTestState({ label: "precheck-no-rewrite" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "precheck-no-rewrite",
      sessionKey: "agent:main:precheck-no-rewrite",
      storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
    };
    const sessionManager = guardSessionManager(SessionManager.open(target, state.workspaceDir));
    const user: AgentMessage = { role: "user", content: "continue", timestamp: 1 };
    sessionManager.appendMessage(user);
    const before = SessionManager.open(target).getEntries();
    const error: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      stopReason: "error",
      errorMessage: MID_TURN_PRECHECK_ERROR_MESSAGE,
      timestamp: 2,
      usage: createZeroUsageFixture(),
    };
    sessionManager.appendMessage(error);
    expect(SessionManager.open(target).getEntries()).toEqual(before);
    const database = openOpenClawAgentDatabase({ agentId: "main", path: target.storePath });
    database.db.exec(`CREATE TRIGGER reject_recovery BEFORE INSERT ON transcript_events
      BEGIN SELECT RAISE(ABORT, 'unexpected recovery write'); END;`);
    const activeSession = { agent: { state: { messages: [user, error] } } };
    removeTrailingMidTurnPrecheckAssistantError({ activeSession, sessionManager });
    expect(activeSession.agent.state.messages).toEqual([user]);
    expect(SessionManager.open(target).getEntries()).toEqual(before);
    database.db.exec("DROP TRIGGER reject_recovery");
    sessionManager.appendMessage({ ...error, errorMessage: "provider unavailable" });
    expect(SessionManager.open(target).buildSessionContext().messages.at(-1)).toMatchObject({
      role: "assistant",
      errorMessage: "provider unavailable",
    });
  });
});
