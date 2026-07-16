import { describe, expect, it } from "vitest";
import {
  findSessionTranscriptReaderBoundaryViolations,
  migratedSessionTranscriptReaderFiles,
} from "../../scripts/check-session-transcript-reader-boundary.mjs";

describe("session transcript reader boundary guard", () => {
  it("ratchets only the files migrated by the transcript reader slice", () => {
    expect(migratedSessionTranscriptReaderFiles).toEqual(
      new Set([
        "src/agents/main-session-restart-recovery.ts",
        "src/agents/subagent-announce-output.test.ts",
        "src/agents/subagent-announce-output.ts",
        "src/agents/subagent-announce.runtime.ts",
        "src/agents/subagent-orphan-recovery.test.ts",
        "src/agents/subagent-orphan-recovery.ts",
        "src/agents/tools/embedded-gateway-stub.runtime.ts",
        "src/agents/tools/embedded-gateway-stub.test.ts",
        "src/agents/tools/embedded-gateway-stub.ts",
        "src/agents/tools/sessions-history-tool.ts",
        "src/agents/tools/sessions-list-tool.ts",
        "src/gateway/cli-session-history.claude.ts",
        "src/gateway/gateway-models.profiles.live.test.ts",
        "src/gateway/managed-image-attachments.test.ts",
        "src/gateway/managed-image-attachments.ts",
        "src/gateway/mcp-app-reconstruction.ts",
        "src/gateway/server-methods/artifacts.test.ts",
        "src/gateway/server-methods/artifacts.ts",
        "src/gateway/server-methods/chat.ts",
        "src/gateway/server-methods/sessions-files.test.ts",
        "src/gateway/server-methods/sessions-files.ts",
        "src/gateway/server-methods/sessions-abort.ts",
        "src/gateway/server-methods/sessions-compact.ts",
        "src/gateway/server-methods/sessions-compaction-checkpoints.ts",
        "src/gateway/server-methods/sessions-compaction-queries.ts",
        "src/gateway/server-methods/sessions-compaction-runner.ts",
        "src/gateway/server-methods/sessions-create.ts",
        "src/gateway/server-methods/sessions-delete.ts",
        "src/gateway/server-methods/sessions-dispatch.ts",
        "src/gateway/server-methods/sessions-groups.ts",
        "src/gateway/server-methods/sessions-messaging.ts",
        "src/gateway/server-methods/sessions-mutations.ts",
        "src/gateway/server-methods/sessions-read.ts",
        "src/gateway/server-methods/sessions-shared.ts",
        "src/gateway/server-methods/sessions-subscriptions.ts",
        "src/gateway/server-methods/sessions.ts",
        "src/gateway/server-session-events.ts",
        "src/gateway/session-history-state.test.ts",
        "src/gateway/session-history-state.ts",
        "src/gateway/session-reset-service.ts",
        "src/gateway/session-utils.ts",
        "src/gateway/sessions-history-http.revocation.test.ts",
        "src/gateway/sessions-history-http.ts",
        "src/status/status-message.ts",
        "src/tui/embedded-backend.test.ts",
        "src/tui/embedded-backend.ts",
      ]),
    );
  });

  it("flags legacy transcript reader imports", () => {
    expect(
      findSessionTranscriptReaderBoundaryViolations(`
        import { readSessionMessagesAsync, loadSessionEntry } from "./session-utils.js";
        import { readRecentSessionMessages as readRecent } from "./session-utils.fs.js";
      `),
    ).toEqual([
      {
        line: 2,
        reason:
          'imports transcript reader "readSessionMessagesAsync" from legacy module "./session-utils.js"',
      },
      {
        line: 3,
        reason:
          'imports transcript reader "readRecentSessionMessages" from legacy module "./session-utils.fs.js"',
      },
    ]);
  });

  it("flags namespace legacy transcript reader references", () => {
    expect(
      findSessionTranscriptReaderBoundaryViolations(`
        import * as sessionUtils from "./session-utils.js";
        sessionUtils.readSessionMessagesAsync();
        sessionUtils["readRecentSessionMessages"]();
        const { readSessionMessages } = sessionUtils;
      `),
    ).toEqual([
      { line: 3, reason: 'references legacy transcript reader "readSessionMessagesAsync"' },
      { line: 4, reason: 'references legacy transcript reader "readRecentSessionMessages"' },
      { line: 5, reason: 'aliases legacy transcript reader "readSessionMessages"' },
    ]);
  });

  it("flags legacy transcript reader re-exports", () => {
    expect(
      findSessionTranscriptReaderBoundaryViolations(`
        export { readSessionMessagesAsync } from "./session-utils.js";
        export { readRecentSessionMessages as readRecent } from "./session-utils.fs.js";
        export * as sessionUtils from "./session-utils.js";
        export * from "./session-utils.fs.js";
      `),
    ).toEqual([
      {
        line: 2,
        reason:
          're-exports transcript reader "readSessionMessagesAsync" from legacy module "./session-utils.js"',
      },
      {
        line: 3,
        reason:
          're-exports transcript reader "readRecentSessionMessages" from legacy module "./session-utils.fs.js"',
      },
      {
        line: 4,
        reason: 're-exports transcript reader namespace from legacy module "./session-utils.js"',
      },
      {
        line: 5,
        reason: 're-exports transcript readers from legacy module "./session-utils.fs.js"',
      },
    ]);
  });

  it("allows migrated reader facade imports and non-reader session utilities", () => {
    expect(
      findSessionTranscriptReaderBoundaryViolations(`
        import { readSessionMessagesAsync } from "./session-transcript-readers.js";
        import { loadSessionEntry } from "./session-utils.js";
        export { readSessionMessagesAsync };
        await readSessionMessagesAsync(scope, opts);
        loadSessionEntry("agent:main");
      `),
    ).toEqual([]);
  });

  it("allows reader-named destructuring from non-legacy objects", () => {
    expect(
      findSessionTranscriptReaderBoundaryViolations(`
        const { readSessionMessagesAsync } = deps;
        const { readSessionMessages: readMessages } = mockReaders;
      `),
    ).toEqual([]);
  });

  it("flags storage-specific reader aliases in migrated files", () => {
    expect(
      findSessionTranscriptReaderBoundaryViolations(`
        import { readSessionMessagesAsync as readSessionMessagesFromFileAsync } from "./session-transcript-readers.js";
        await readSessionMessagesFromFileAsync(scope, opts);
      `),
    ).toEqual([
      {
        line: 2,
        reason: 'uses storage-specific transcript reader alias "readSessionMessagesFromFileAsync"',
      },
      {
        line: 3,
        reason: 'uses storage-specific transcript reader alias "readSessionMessagesFromFileAsync"',
      },
    ]);
  });
});
