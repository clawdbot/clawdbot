import path from "node:path";
import { expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { SessionManager } from "./session-manager.js";

it.each(
  [false, true].flatMap((incognito) =>
    (["append", "rewrite"] as const).map((mutation) => ({ incognito, mutation })),
  ),
)(
  "reads the completed-turn snapshot across later $mutation (incognito=$incognito)",
  async ({ incognito, mutation }) => {
    await withOpenClawTestState({ label: "completed-model-context" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "completed-context",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-completed-context"
          : "agent:main:completed-context",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = SessionManager.open(scope);
      source.appendMessage({ role: "user", content: "completed question", timestamp: 1 });
      await waitForSessionTranscriptProjection(scope);
      const terminal = source.appendMessageWithTranscriptAnchor(
        Object.assign(
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "completed answer" }],
          }),
          { __openclaw: { upstreamUserText: "synthetic-private-native-payload" } },
        ),
      );
      if (!terminal.anchor) {
        throw new Error("Missing completed-turn anchor");
      }
      const expected = SessionManager.openModelContext(scope).buildSessionContext();
      source.appendMessage({ role: "user", content: "later question", timestamp: 2 });
      const mutate = () => {
        if (mutation === "rewrite") {
          source.removeTrailingEntries((entry) => entry.type === "message");
        }
        source.appendMessage({ role: "user", content: "newest question", timestamp: 3 });
      };
      const spy = incognito
        ? undefined
        : vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementationOnce(async function (
            this: WorkerTaskPool<unknown, unknown>,
            ...args
          ) {
            spy!.mockRestore();
            const result = await this.run(...args);
            mutate();
            return result;
          });
      try {
        const pending = SessionManager.openModelContextAsync(scope, { through: terminal.anchor });
        if (incognito) {
          mutate();
        }
        if (mutation === "rewrite") {
          await expect(pending).rejects.toThrow(/transcript|anchor/i);
        } else {
          const context = (await pending).buildSessionContext();
          expect(context).toEqual(expected);
          expect(JSON.stringify(context)).not.toContain("synthetic-private-native-payload");
          expect(source.buildSessionContext().messages.at(-1)).toMatchObject({
            content: "newest question",
          });
        }
      } finally {
        spy?.mockRestore();
      }
    });
  },
);
