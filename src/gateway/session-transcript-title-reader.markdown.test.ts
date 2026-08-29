import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as sessionAccessor from "../config/sessions/session-accessor.js";
import {
  persistSessionTranscriptTurn,
  type SessionTranscriptMessageEvent,
} from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  readSessionTitleFieldsFromTranscript,
  readSessionTitleFieldsFromTranscriptBatch,
} from "./session-transcript-title-reader.js";

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    readSessionTranscriptMessageEventPage: vi.fn(actual.readSessionTranscriptMessageEventPage),
    readSessionTranscriptTitleProbeBatch: vi.fn(actual.readSessionTranscriptTitleProbeBatch),
  };
});

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
            "# Done\n\nLanded [PR #124879](https://github.com/openclaw/openclaw/pull/124879) with **green** CI. Use foo_bar_baz from ~/.openclaw.",
        },
      ]);
      const fields =
        mode === "single"
          ? readSessionTitleFieldsFromTranscript(scope)
          : readSessionTitleFieldsFromTranscriptBatch([scope])[0];

      expect(fields).toEqual({
        firstUserMessage: "Keep **title Markdown** unchanged",
        lastMessagePreview:
          "Done Landed PR #124879 with green CI. Use foo_bar_baz from ~/.openclaw.",
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

  test.each([
    { mode: "single", widen: false },
    { mode: "batch", widen: false },
    { mode: "single", widen: true },
    { mode: "batch", widen: true },
  ] as const)(
    "stops reading older content after the newest visible $mode preview (widen=$widen)",
    async ({ mode, widen }) => {
      const hiddenMessages = [
        { role: "toolResult", content: "tool output" },
        { role: "system", content: "system event" },
        { role: "assistant", content: [{ type: "thinking", thinking: "private thought" }] },
        { role: "assistant", content: "NO_REPLY" },
        { role: "assistant", content: "ANNOUNCE_SKIP" },
        { role: "assistant", content: "REPLY_SKIP" },
        { role: "assistant", content: [{ type: "text", text: "" }] },
        { role: "assistant", content: "```ts\nconst hidden = true;\n```" },
      ];
      const olderText = "Earlier **reply**";
      // Keep the observed row outside the first-user head probe, including after widening.
      const prefix = [
        { role: "user", content: "Keep **title Markdown** unchanged" },
        ...Array.from({ length: 100 }, () => ({ role: "toolResult", content: "tool output" })),
      ];
      const olderSeq = prefix.length + 1;
      const scope = await writeMessages(`reader-title-short-circuit-${mode}-${widen}`, [
        ...prefix,
        { role: "assistant", content: [{ type: "text", text: olderText }] },
        { role: "assistant", content: "# Latest\n\nRead the [guide](https://example.com)." },
        ...(widen ? Array.from({ length: 3 }, () => hiddenMessages).flat() : []),
      ]);
      const actual = await vi.importActual<typeof import("../config/sessions/session-accessor.js")>(
        "../config/sessions/session-accessor.js",
      );
      const readOlderText = vi.fn(() => olderText);
      let observedRows = 0;
      const observeOlderContent = (
        entries: Pick<SessionTranscriptMessageEvent, "event" | "seq">[],
      ) => {
        for (const entry of entries) {
          if (entry.seq !== olderSeq) {
            continue;
          }
          observedRows += 1;
          entry.event = {
            ...asOptionalRecord(entry.event),
            message: {
              role: "assistant",
              // Nested text survives transcript metadata normalization; only projection reads it.
              content: [
                {
                  type: "text",
                  get text() {
                    return readOlderText();
                  },
                },
              ],
            },
          };
        }
      };
      const pageReader = vi.mocked(sessionAccessor.readSessionTranscriptMessageEventPage);
      const batchReader = vi.mocked(sessionAccessor.readSessionTranscriptTitleProbeBatch);
      try {
        pageReader.mockImplementation((readScope, options) => {
          const page = actual.readSessionTranscriptMessageEventPage(readScope, options);
          observeOlderContent(page.events);
          return page;
        });
        batchReader.mockImplementation((readScopes) => {
          const probes = actual.readSessionTranscriptTitleProbeBatch(readScopes);
          for (const probe of probes) {
            if (probe) {
              observeOlderContent(probe.tail);
            }
          }
          return probes;
        });

        const fields =
          mode === "single"
            ? readSessionTitleFieldsFromTranscript(scope)
            : readSessionTitleFieldsFromTranscriptBatch([scope])[0];

        expect(fields).toEqual({
          firstUserMessage: "Keep **title Markdown** unchanged",
          lastMessagePreview: "Latest Read the guide.",
        });
        expect(observedRows).toBe(1);
        expect(readOlderText).not.toHaveBeenCalled();
      } finally {
        pageReader.mockImplementation(actual.readSessionTranscriptMessageEventPage);
        batchReader.mockImplementation(actual.readSessionTranscriptTitleProbeBatch);
      }
    },
  );
});
