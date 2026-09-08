import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { persistSubagentSessionTiming } from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

describe("subagent session failures", () => {
  it.each(["error", "timeout"] as const)(
    "persists a bounded %s reason and one durable child notice, then clears only on success",
    async (outcomeStatus) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const target = {
          agentId: "main",
          sessionKey: "agent:main:subagent:setup-failure",
          sessionId: "sess-setup-failure",
          storePath: path.join(state.sessionsDir(), "sessions.json"),
        };
        await upsertSessionEntryCore(target, {
          sessionId: target.sessionId,
          updatedAt: Date.now(),
        });
        const reason = `Repository base ref is missing. ${"details ".repeat(80)}`.trim();
        const record: SubagentRunRecord = {
          runId: "run-setup-failure",
          childSessionKey: target.sessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "prepare child worktree",
          cleanup: "keep",
          createdAt: 1_000,
          execution: {
            status: "terminal",
            startedAt: 1_001,
            endedAt: 2_000,
            outcome: {
              status: outcomeStatus,
              error: `[tool calls omitted]\n<final>${reason}</final>`,
            },
          },
        };
        await persistSubagentSessionTiming(record);
        expect(loadSessionEntry(target)).toMatchObject({
          status: outcomeStatus === "error" ? "failed" : "timeout",
          lastRunError: reason.slice(0, 160),
        });
        await persistSubagentSessionTiming(record);
        expect(
          (await loadTranscriptEvents(target)).filter(
            (event) => isRecord(event) && event.type === "custom_message",
          ),
        ).toMatchObject([
          {
            customType: "run-failed-before-reply",
            display: true,
            details: { runId: record.runId, error: reason.slice(0, 512) },
          },
        ]);

        for (const executionStatus of ["running", "queued"] as const) {
          await persistSubagentSessionTiming({
            ...record,
            execution: { status: executionStatus },
          });
          expect(loadSessionEntry(target)?.lastRunError).toBe(reason.slice(0, 160));
        }
        await persistSubagentSessionTiming({ ...record, endedReason: "subagent-killed" });
        expect(loadSessionEntry(target)?.lastRunError).toBe(reason.slice(0, 160));
        await persistSubagentSessionTiming({
          ...record,
          execution: { ...record.execution, outcome: { status: "ok" } },
        });
        expect(loadSessionEntry(target)?.lastRunError).toBeUndefined();
      });
    },
  );
});
