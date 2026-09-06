import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { createUpdateRun, getUpdateRun } from "../infra/update-run-ledger.js";
import { renderUpdateRunNotice } from "../infra/update-run-report.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createUpdateRunNotifier } from "./update-run-notice.runtime.js";

describe("host-owned update notices", () => {
  let state: OpenClawTestState;
  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-update-notice-" });
  });
  afterEach(async () => {
    await state.cleanup();
  });

  it.each([false, true])(
    "outlives the requesting attempt while honoring session replacement (%s)",
    async (replaced) => {
      const target = {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "update-session",
        storePath: state.statePath("agents", "main", "sessions", "sessions.json"),
      };
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        lifecycleRevision: "admitted-session",
        updatedAt: 1,
      });
      const run = createUpdateRun({ trigger: "chat", origin: { sessionKey: target.sessionKey } });
      const notify = createUpdateRunNotifier(run, {}, {});
      if (replaced) {
        await upsertSessionEntryCore(target, {
          sessionId: target.sessionId,
          lifecycleRevision: "replacement-session",
          updatedAt: 2,
        });
      }
      const result = await withOwnedSessionTranscriptWrites(
        {
          sessionTarget: target,
          withTranscriptWrite: async () => {
            throw new Error("attempt disposed before transcript write");
          },
        },
        () => notify(run, "parking"),
      );
      expect(result).toEqual({ delivered: !replaced, owned: !replaced });
      const events = await loadTranscriptEvents(target);
      const messages = events.filter((event) => asOptionalRecord(event)?.type === "message");
      expect(messages).toHaveLength(replaced ? 0 : 1);
      if (!replaced) {
        expect(messages[0]).toMatchObject({
          message: {
            role: "assistant",
            content: [{ type: "text", text: renderUpdateRunNotice(run, "parking") }],
          },
        });
        expect(getUpdateRun(run.runId)?.steps).toContainEqual(
          expect.objectContaining({ step: "notice:activating", status: "completed" }),
        );
      }
      expect(getUpdateRun(run.runId)?.phase).toBe("requested");
    },
  );
});
