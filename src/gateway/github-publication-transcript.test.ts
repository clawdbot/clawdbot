import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionGitHubPublicationResult } from "../../packages/gateway-protocol/src/index.js";
import {
  loadTranscriptEvents,
  replaceTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGitHubPublicationTranscriptReporter } from "./github-publication-transcript.js";

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("GitHub publication transcript reporting", () => {
  it.each([
    {
      label: "unreadable message",
      tail: {
        type: "message",
        id: "tail",
        parentId: null,
        message: { role: "assistant", content: null },
      },
      count: 1,
    },
    {
      label: "missing parent",
      tail: {
        type: "message",
        id: "tail",
        parentId: "absent",
        message: { role: "user", content: "A separate branch" },
      },
      count: 2,
    },
    {
      label: "parentless row",
      tail: { type: "message", id: "tail", message: { role: "user", content: "Continued" } },
      count: 1,
    },
    {
      label: "unattached label",
      tail: { type: "label", id: "tail", parentId: null, targetId: "absent", label: "Unknown" },
      count: 1,
    },
    {
      label: "invalid leaf control",
      tail: { type: "leaf", id: "tail", parentId: "report", targetId: "absent" },
      count: 1,
    },
    {
      label: "side append",
      tail: {
        type: "message",
        id: "tail",
        parentId: null,
        appendMode: "side",
        message: { role: "user", content: "Side" },
      },
      count: 1,
    },
  ])("preserves canonical report visibility after $label", async ({ tail, count }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const identity = {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "publication-codec",
      };
      const result = {
        requestId: "codec-publication",
        status: "failed",
        code: "push_rejected",
        message: "Publication failed.",
        nextAction: "Retry.",
      } satisfies SessionGitHubPublicationResult;
      await upsertSessionEntryCore(identity, { sessionId: identity.sessionId, updatedAt: 1 });
      await replaceTranscriptEvents(identity, [
        { type: "session", id: identity.sessionId, version: CURRENT_SESSION_VERSION },
        {
          type: "message",
          id: "root",
          parentId: null,
          message: { role: "user", content: "Start" },
        },
        {
          type: "message",
          id: "report",
          parentId: "root",
          message: {
            role: "assistant",
            responseId: `github-publication:${result.requestId}`,
            content: "Reported",
          },
        },
        tail,
      ]);
      const reporter = createGitHubPublicationTranscriptReporter(
        () => import("./session-utils.js"),
        { markReported: vi.fn() },
      );
      await reporter({ ...identity, result });
      const reports = (await loadTranscriptEvents(identity)).filter(
        (event) =>
          isRecord(event) &&
          event.type === "message" &&
          isRecord(event.message) &&
          event.message.responseId === `github-publication:${result.requestId}`,
      );
      expect(reports).toHaveLength(count);
    });
  });

  it.each(["missing", "legacy"])(
    "keeps the %s header migration boundary before reporting",
    async (header) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const identity = {
          agentId: "main",
          sessionKey: "agent:main:main",
          sessionId: "publication-header",
        };
        await upsertSessionEntryCore(identity, { sessionId: identity.sessionId, updatedAt: 1 });
        const events = [
          ...(header === "legacy" ? [{ type: "session", id: identity.sessionId, version: 1 }] : []),
          { type: "provider_event", id: "opaque", parentId: null },
        ];
        await replaceTranscriptEvents(identity, events);
        const markReported = vi.fn();
        const reporter = createGitHubPublicationTranscriptReporter(
          () => import("./session-utils.js"),
          { markReported },
        );
        await expect(
          reporter({
            ...identity,
            result: {
              requestId: "header-publication",
              status: "failed",
              code: "push_rejected",
              message: "Failed",
              nextAction: "Retry",
            },
          }),
        ).rejects.toThrow("doctor/import migration");
        expect(markReported).not.toHaveBeenCalled();
        expect(await loadTranscriptEvents(identity)).toEqual(events);
      });
    },
  );
  it("marks a publication reported only after the transcript commits and allows retry after failure", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const identity = {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "publication-failure",
      };
      await upsertSessionEntryCore(identity, { sessionId: identity.sessionId, updatedAt: 1 });
      const result = {
        requestId: "retry-publication",
        status: "failed",
        code: "push_rejected",
        message: "Publication failed.",
        nextAction: "Retry.",
      } satisfies SessionGitHubPublicationResult;
      const database = openOpenClawAgentDatabase({ agentId: identity.agentId });
      database.db.exec(
        "CREATE TEMP TRIGGER reject_report BEFORE INSERT ON transcript_events WHEN json_extract(NEW.event_json, '$.type') = 'message' BEGIN SELECT RAISE(ABORT, 'report insert failed'); END",
      );
      const markReported = vi.fn(() => {
        const reader = new DatabaseSync(database.path, { readOnly: true });
        try {
          expect(
            reader
              .prepare("SELECT count(*) AS count FROM transcript_events WHERE session_id = ?")
              .get(identity.sessionId),
          ).toMatchObject({ count: 2 });
        } finally {
          reader.close();
        }
      });
      const reporter = createGitHubPublicationTranscriptReporter(
        () => import("./session-utils.js"),
        { markReported },
      );
      await expect(reporter({ ...identity, result })).rejects.toThrow("report insert failed");
      expect(markReported).not.toHaveBeenCalled();
      expect(await loadTranscriptEvents(identity)).toEqual([]);
      database.db.exec("DROP TRIGGER reject_report");
      await reporter({ ...identity, result });
      expect(markReported).toHaveBeenCalledOnce();
    });
  });
  it("reports on the active branch while preserving large unrelated evidence", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const identity = {
        agentId: "main",
        sessionKey: "agent:main:main",
        sessionId: "publication-branch",
      };
      await upsertSessionEntryCore(identity, { sessionId: identity.sessionId, updatedAt: 1 });
      const result = {
        requestId: "inactive-publication",
        status: "failed",
        code: "push_rejected",
        message: "Publication failed.",
        nextAction: "Retry.",
      } satisfies SessionGitHubPublicationResult;
      await replaceTranscriptEvents(identity, [
        { type: "session", id: identity.sessionId, version: CURRENT_SESSION_VERSION },
        {
          type: "message",
          id: "root",
          parentId: null,
          message: { role: "user", content: "Start" },
        },
        {
          type: "message",
          id: "old-report",
          parentId: "root",
          message: {
            role: "assistant",
            responseId: `github-publication:${result.requestId}`,
            content: [{ type: "text", text: "Previous report" }],
          },
        },
        {
          type: "provider_event",
          id: "opaque",
          parentId: "old-report",
          payload: "large-evidence".repeat(350_000),
        },
        {
          type: "leaf",
          id: "selected",
          parentId: "opaque",
          targetId: "root",
          appendParentId: "opaque",
        },
      ]);
      const database = openOpenClawAgentDatabase({ agentId: identity.agentId });
      const readEvidence = () =>
        database.db
          .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
          .all(identity.sessionId);
      const before = readEvidence();
      const markReported = vi.fn();
      const reporter = createGitHubPublicationTranscriptReporter(
        () => import("./session-utils.js"),
        { markReported },
      );
      await reporter({ ...identity, result });
      await reporter({ ...identity, result });
      expect(readEvidence().slice(0, before.length)).toEqual(before);
      const reports = (await loadTranscriptEvents(identity)).filter(
        (event) =>
          isRecord(event) &&
          event.type === "message" &&
          isRecord(event.message) &&
          event.message.responseId === `github-publication:${result.requestId}`,
      );
      expect(reports).toHaveLength(2);
      expect(reports[1]).toMatchObject({ parentId: "opaque" });
      expect(markReported).toHaveBeenCalledTimes(2);
    });
  });
  it.each([
    {
      label: "published",
      result: {
        requestId: "publication-success",
        status: "published",
        url: "https://github.com/openclaw/openclaw/pull/1",
        repository: "openclaw/openclaw",
        branch: "openclaw/task",
        headCommit: "a".repeat(40),
      } satisfies SessionGitHubPublicationResult,
      visibleText: "https://github.com/openclaw/openclaw/pull/1",
    },
    {
      label: "failed",
      result: {
        requestId: "publication-failure",
        status: "failed",
        code: "push_rejected",
        message: "GitHub publication failed.",
        nextAction: "Check repository write access and retry.",
      } satisfies SessionGitHubPublicationResult,
      visibleText: "Check repository write access and retry.",
    },
  ])(
    "appends one projected assistant message for a $label result",
    async ({ result, visibleText }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const sessionKey = "agent:main:main";
        const sessionId = "publication-transcript";
        await upsertSessionEntryCore({ agentId: "main", sessionKey }, { sessionId, updatedAt: 1 });
        const markReported = vi.fn();
        const reporter = createGitHubPublicationTranscriptReporter(
          async () => {
            const runtime = await import("./session-utils.js");
            return {
              resolveCanonicalSessionEntryFromStoreKeys:
                runtime.resolveCanonicalSessionEntryFromStoreKeys,
              resolveGatewaySessionStoreTargetWithStore:
                runtime.resolveGatewaySessionStoreTargetWithStore,
            };
          },
          { markReported },
        );

        await reporter({ sessionId, sessionKey, agentId: "main", result });
        await reporter({ sessionId, sessionKey, agentId: "main", result });

        const events = await loadTranscriptEvents({ agentId: "main", sessionId, sessionKey });
        const messages = events.filter(
          (event) =>
            isRecord(event) &&
            event.type === "message" &&
            isRecord(event.message) &&
            event.message.role === "assistant" &&
            event.message.responseId === `github-publication:${result.requestId}`,
        );
        expect(messages).toHaveLength(1);
        expect(JSON.stringify(messages[0])).toContain(visibleText);
        expect(markReported).toHaveBeenCalledWith(result.requestId);
      });
    },
  );
});
