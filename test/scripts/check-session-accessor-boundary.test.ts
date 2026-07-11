import { describe, expect, it } from "vitest";
import {
  allowedSessionStoreRuntimeFileBackedCompatExports,
  collectSessionStoreRuntimeFileBackedCompatExports,
  compareSessionAccessorDebt,
  findGatewaySessionCreateLifecycleViolations,
  findEmbeddedAgentSessionTargetViolations,
  findMemoryHostSessionCorpusBoundaryViolations,
  findSessionAccessorBoundaryViolations,
  findSessionCompactManualTrimBoundaryViolations,
  findSessionAccessorWriteBoundaryViolations,
  findSessionLifecycleCleanupBoundaryViolations,
  findSessionStoreRuntimeFileBackedCompatExportViolations,
  findTranscriptWriterBoundaryViolations,
  formatSessionAccessorDebtImprovements,
  migratedBundledPluginSessionAccessorFiles,
  migratedEmbeddedAgentSessionTargetFiles,
  migratedMemoryHostSessionCorpusFiles,
  migratedSessionLifecycleCleanupFiles,
  migratedSessionCompactManualTrimFiles,
  migratedSessionAccessorFiles,
  migratedSessionAccessorWriteFiles,
  migratedTranscriptWriterFiles,
} from "../../scripts/check-session-accessor-boundary.mjs";

describe("session accessor boundary guard", () => {
  it("ratchets only the files migrated by the session accessor slices", () => {
    expect(migratedSessionAccessorFiles).toEqual(
      new Set([
        "packages/memory-host-sdk/src/host/session-files.ts",
        "src/acp/runtime/session-meta.ts",
        "src/agents/acp-spawn.ts",
        "src/agents/auth-profiles/session-override.ts",
        "src/agents/embedded-agent-runner/compaction-successor-transcript.ts",
        "src/agents/embedded-agent-runner/run/attempt.ts",
        "src/agents/embedded-agent-runner/tool-result-truncation.ts",
        "src/agents/embedded-agent-runner/transcript-rewrite.ts",
        "src/agents/embedded-agent-runner/transcript-runtime-state.ts",
        "src/agents/live-model-switch.ts",
        "src/agents/subagent-control.ts",
        "src/agents/subagent-registry-helpers.ts",
        "src/auto-reply/reply/abort.ts",
        "src/auto-reply/reply/agent-runner-helpers.ts",
        "src/auto-reply/reply/agent-runner.ts",
        "src/auto-reply/reply/commands-subagents/action-info.ts",
        "src/auto-reply/reply/followup-runner.ts",
        "src/auto-reply/reply/queue/drain.ts",
        "src/commands/export-trajectory.ts",
        "src/commands/health.ts",
        "src/commands/sandbox-explain.ts",
        "src/commands/sessions-tail.ts",
        "src/commands/sessions.ts",
        "src/commands/status.agent-local.ts",
        "src/commands/status.summary.ts",
        "src/commands/tasks.ts",
        "src/config/sessions/combined-store-gateway.ts",
        "src/config/sessions/delivery-info.ts",
        "src/config/sessions/goals.ts",
        "src/cron/isolated-agent/delivery-target.ts",
        "src/cron/service/timer.ts",
        "src/gateway/session-compaction-checkpoints.ts",
        "src/gateway/session-history-state.ts",
        "src/gateway/sessions-history-http.ts",
        "src/gateway/session-utils.ts",
        "src/gateway/managed-image-attachments.ts",
        "src/gateway/boot.ts",
        "src/gateway/server-methods/artifacts.ts",
        "src/gateway/server-methods/chat.ts",
        "src/gateway/sessions-resolve.ts",
        "src/gateway/server-methods/sessions-files.ts",
        "src/gateway/server-methods/sessions.ts",
        "src/gateway/server-session-events.ts",
        "src/gateway/session-reset-service.ts",
        "src/infra/outbound/message-action-tts.ts",
        "src/agents/tools/embedded-gateway-stub.ts",
        "src/agents/tools/session-status-tool.ts",
        "src/agents/tools/sessions-list-tool.ts",
        "src/plugins/host-hook-state.ts",
        "src/status/status-message.ts",
        "src/tui/embedded-backend.ts",
      ]),
    );
  });

  it("ratchets only the bundled plugin files migrated by this slice", () => {
    expect(migratedBundledPluginSessionAccessorFiles).toEqual(
      new Set([
        "extensions/codex/src/conversation-binding.ts",
        "extensions/discord/src/monitor/native-command-model-picker-ui.ts",
        "extensions/discord/src/monitor/native-command-model-picker-apply.ts",
        "extensions/discord/src/monitor/thread-session-close.ts",
        "extensions/feishu/src/reasoning-preview.ts",
        "extensions/memory-core/src/dreaming-phases.ts",
        "extensions/memory-core/src/dreaming-narrative.ts",
        "extensions/mattermost/src/mattermost/model-picker.ts",
        "extensions/matrix/src/matrix/monitor/handler.ts",
        "extensions/matrix/src/session-route.ts",
        "extensions/slack/src/monitor/slash.ts",
        "extensions/telegram/src/bot-core.ts",
        "extensions/telegram/src/bot-handlers.runtime.ts",
        "extensions/telegram/src/bot.ts",
        "extensions/telegram/src/bot-message-dispatch.ts",
        "extensions/telegram/src/bot-native-commands.ts",
        "extensions/voice-call/src/response-generator.ts",
        "extensions/whatsapp/src/auto-reply/monitor/group-activation.ts",
      ]),
    );
  });

  it("ratchets only files migrated to embedded-agent session targets", () => {
    expect(migratedEmbeddedAgentSessionTargetFiles).toEqual(
      new Set(["extensions/voice-call/src/response-generator.ts"]),
    );
  });

  it("ratchets only files migrated to session accessor writes", () => {
    expect(migratedSessionAccessorWriteFiles).toEqual(
      new Set([
        "src/acp/runtime/session-meta.ts",
        "src/agents/auth-profiles/session-override.ts",
        "src/agents/command/attempt-execution.shared.ts",
        "src/agents/command/session-store.ts",
        "src/agents/embedded-agent-runner/run.ts",
        "src/agents/embedded-agent-runner/run/attempt.ts",
        "src/agents/embedded-agent-subscribe.handlers.compaction.runtime.ts",
        "src/agents/live-model-switch.ts",
        "src/agents/main-session-restart-recovery.ts",
        "src/auto-reply/reply/abort.ts",
        "src/agents/subagent-control.ts",
        "src/agents/subagent-registry-helpers.ts",
        "src/agents/tools/session-status-tool.ts",
        "src/auto-reply/reply/abort-cutoff.runtime.ts",
        "src/auto-reply/reply/agent-runner-cli-dispatch.ts",
        "src/auto-reply/reply/agent-runner-execution.ts",
        "src/auto-reply/reply/agent-runner-memory.ts",
        "src/auto-reply/reply/agent-runner-session-reset.ts",
        "src/auto-reply/reply/agent-runner.ts",
        "src/auto-reply/reply/body.ts",
        "src/auto-reply/reply/commands-acp/lifecycle.ts",
        "src/auto-reply/reply/commands-reset.ts",
        "src/auto-reply/reply/commands-session-store.ts",
        "src/auto-reply/reply/directive-handling.impl.ts",
        "src/auto-reply/reply/directive-handling.persist.ts",
        "src/auto-reply/reply/dispatch-from-config.runtime.ts",
        "src/auto-reply/reply/followup-runner.ts",
        "src/auto-reply/reply/get-reply.ts",
        "src/auto-reply/reply/model-selection.ts",
        "src/auto-reply/reply/session.ts",
        "src/auto-reply/reply/session-reset-model.ts",
        "src/auto-reply/reply/session-updates.ts",
        "src/auto-reply/reply/session-usage.ts",
        "src/commands/tasks.ts",
        "src/config/sessions/cleanup-service.ts",
        "src/config/sessions/goals.ts",
        "src/gateway/boot.ts",
        "src/gateway/server-methods/chat.ts",
        "src/gateway/server-methods/sessions.ts",
        "src/gateway/server-node-events.ts",
        "src/gateway/session-compaction-checkpoints.ts",
        "src/infra/outbound/outbound-session.ts",
        "src/plugins/host-hook-cleanup.ts",
        "src/plugins/host-hook-state.ts",
        "src/plugins/runtime/runtime-channel.ts",
        "src/tui/embedded-backend.ts",
      ]),
    );
  });

  it("ratchets only the files migrated by the transcript writer slice", () => {
    expect(migratedTranscriptWriterFiles).toEqual(
      new Set([
        "src/agents/command/attempt-execution.ts",
        "src/agents/embedded-agent-runner/context-engine-maintenance.ts",
        "src/auto-reply/reply/session-fork.runtime.ts",
        "src/config/sessions/transcript.ts",
        "src/gateway/server-methods/chat.ts",
        "src/gateway/server-methods/chat-transcript-inject.ts",
        "src/sessions/user-turn-transcript.ts",
      ]),
    );
  });

  it("ratchets only compact manual trim gateway files", () => {
    expect(migratedSessionCompactManualTrimFiles).toEqual(
      new Set(["src/gateway/server-methods/sessions.ts"]),
    );
  });

  it("ratchets only the lifecycle cleanup files migrated to backend cleanup", () => {
    expect(migratedSessionLifecycleCleanupFiles).toEqual(
      new Set([
        "src/config/sessions/cleanup-service.ts",
        "src/cron/session-reaper.ts",
        "src/infra/heartbeat-runner.ts",
      ]),
    );
  });

  it("ratchets only memory-host session corpus files migrated to accessor entries", () => {
    expect(migratedMemoryHostSessionCorpusFiles).toEqual(
      new Set([
        "packages/memory-host-sdk/src/host/session-files.ts",
        "packages/memory-host-sdk/src/host/session-transcript-corpus.ts",
      ]),
    );
  });

  it("ratchets only explicit file-backed SDK session compatibility exports", () => {
    expect(allowedSessionStoreRuntimeFileBackedCompatExports).toEqual(new Set([]));
  });

  it("collects file-backed SDK session compatibility exports", () => {
    expect(
      collectSessionStoreRuntimeFileBackedCompatExports(`
        export const loadSessionStore = loadSessionStoreImpl;
        export { resolveSessionFilePath } from "../config/sessions/paths.js";
        export { saveSessionStore, updateSessionStore } from "../config/sessions/store.js";
      `),
    ).toEqual(
      new Map([
        ["loadSessionStore", { line: 2, sourceName: "loadSessionStore" }],
        ["resolveSessionFilePath", { line: 3, sourceName: "resolveSessionFilePath" }],
        ["saveSessionStore", { line: 4, sourceName: "saveSessionStore" }],
        ["updateSessionStore", { line: 4, sourceName: "updateSessionStore" }],
      ]),
    );
  });

  it("flags unratcheted file-backed SDK session compatibility exports", () => {
    expect(
      findSessionStoreRuntimeFileBackedCompatExportViolations(`
        export { readSessionEntries } from "../config/sessions/store-load.js";
        export { resolveSessionFilePath as resolveLegacySessionFilePath } from "../config/sessions/paths.js";
      `),
    ).toEqual([
      {
        line: 2,
        reason: 'exports unratcheted file-backed SDK session helper "readSessionEntries"',
      },
      {
        line: 3,
        reason: 'exports unratcheted file-backed SDK session helper "resolveSessionFilePath"',
      },
    ]);
  });

  it("flags legacy reader imports", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        import { loadSessionStore, readSessionEntries as readEntries } from "../config/sessions.js";
        import { readSessionEntry, readSessionStoreReadOnly } from "../config/sessions/store-load.js";
      `),
    ).toEqual([
      { line: 2, reason: 'imports legacy session store access "loadSessionStore"' },
      { line: 2, reason: 'imports legacy session store access "readSessionEntries"' },
      { line: 3, reason: 'imports legacy session store access "readSessionEntry"' },
      { line: 3, reason: 'imports legacy session store access "readSessionStoreReadOnly"' },
    ]);
  });

  it("flags direct and namespace legacy access calls", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        loadSessionStore(storePath);
        sessions.readSessionEntries(storePath);
        sessions["loadSessionStore"](storePath);
        readSessionStoreReadOnly(storePath);
        resolveSessionStoreEntry({ store, sessionKey });
      `),
    ).toEqual([
      { line: 2, reason: 'calls legacy session store access "loadSessionStore"' },
      { line: 3, reason: 'references legacy session store access "readSessionEntries"' },
      { line: 4, reason: 'references legacy session store access "loadSessionStore"' },
      { line: 5, reason: 'calls legacy session store access "readSessionStoreReadOnly"' },
      { line: 6, reason: 'calls legacy session store access "resolveSessionStoreEntry"' },
    ]);
  });

  it("flags aliased namespace reader references", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        const load = sessions.loadSessionStore;
        const { readSessionEntries: readEntries } = sessions;
        const { loadSessionStore } = sessions;
      `),
    ).toEqual([
      { line: 2, reason: 'references legacy session store access "loadSessionStore"' },
      { line: 3, reason: 'aliases legacy session store access "readSessionEntries"' },
      { line: 4, reason: 'aliases legacy session store access "loadSessionStore"' },
    ]);
  });

  it("flags legacy whole-store writes", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        import { saveSessionStore, updateSessionStore } from "../config/sessions.js";
        saveSessionStore(storePath, store);
        updateSessionStore(storePath, update);
      `),
    ).toEqual([
      { line: 2, reason: 'imports legacy session store access "saveSessionStore"' },
      { line: 2, reason: 'imports legacy session store access "updateSessionStore"' },
      { line: 3, reason: 'calls legacy session store access "saveSessionStore"' },
      { line: 4, reason: 'calls legacy session store access "updateSessionStore"' },
    ]);
  });

  it("allows migrated accessor reads", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        import { listSessionEntries } from "../config/sessions/session-accessor.js";
        listSessionEntries({ storePath });
      `),
    ).toEqual([]);
  });

  it("flags legacy memory-host corpus classification calls in migrated entrypoints", () => {
    expect(
      findMemoryHostSessionCorpusBoundaryViolations(`
        function listSessionTranscriptCorpusEntriesForAgentSync(agentId) {
          return loadSessionTranscriptClassificationForSessionsDir(resolveSessionTranscriptsDirForAgent(agentId));
        }
        export async function listSessionFilesForAgent(agentId) {
          return readSessionTranscriptClassificationStore("sessions.json");
        }
      `),
    ).toEqual([
      {
        line: 3,
        reason:
          'calls legacy memory-host session corpus helper "loadSessionTranscriptClassificationForSessionsDir"',
      },
      {
        line: 6,
        reason:
          'calls legacy memory-host session corpus helper "readSessionTranscriptClassificationStore"',
      },
    ]);
  });

  it("follows memory-host corpus helper calls when checking legacy access", () => {
    expect(
      findMemoryHostSessionCorpusBoundaryViolations(`
        function loadViaHelper() {
          return readSessionTranscriptClassificationStore("sessions.json");
        }
        function listSessionTranscriptCorpusEntriesForAgentSync(agentId) {
          return loadViaHelper(agentId);
        }
      `),
    ).toEqual([
      {
        line: 3,
        reason:
          'calls legacy memory-host session corpus helper "readSessionTranscriptClassificationStore"',
      },
    ]);
  });

  it("allows memory-host corpus entrypoints to use the accessor-backed corpus helper", () => {
    expect(
      findMemoryHostSessionCorpusBoundaryViolations(`
        function listSessionTranscriptCorpusEntriesForAgentSync(agentId) {
          return listSessionEntries({ agentId });
        }
        export async function listSessionFilesForAgent(agentId) {
          return (await listSessionTranscriptCorpusEntriesForAgent(agentId)).map((entry) => entry.sessionFile);
        }
      `),
    ).toEqual([]);
  });

  it("flags legacy writer imports and calls", () => {
    expect(
      findSessionAccessorWriteBoundaryViolations(`
        import { applySessionStoreEntryPatch, saveSessionStore, updateSessionStore, updateSessionStoreEntry as updateEntry } from "../config/sessions.js";
        saveSessionStore(storePath, store);
        updateSessionStore(storePath, () => undefined);
        sessions.updateSessionStoreEntry({ storePath, sessionKey, update });
        applySessionStoreEntryPatch({ storePath, sessionKey, patch });
      `),
    ).toEqual([
      { line: 2, reason: 'imports legacy session store writer "applySessionStoreEntryPatch"' },
      { line: 2, reason: 'imports legacy session store writer "saveSessionStore"' },
      { line: 2, reason: 'imports legacy session store writer "updateSessionStore"' },
      { line: 2, reason: 'imports legacy session store writer "updateSessionStoreEntry"' },
      { line: 3, reason: 'calls legacy session store writer "saveSessionStore"' },
      { line: 4, reason: 'calls legacy session store writer "updateSessionStore"' },
      { line: 5, reason: 'references legacy session store writer "updateSessionStoreEntry"' },
      { line: 6, reason: 'calls legacy session store writer "applySessionStoreEntryPatch"' },
    ]);
  });

  it("allows migrated accessor writes", () => {
    expect(
      findSessionAccessorWriteBoundaryViolations(`
        import { updateSessionEntry } from "../config/sessions/session-accessor.js";
        updateSessionEntry({ storePath, sessionKey }, () => undefined);
      `),
    ).toEqual([]);
  });

  it("flags legacy transcript writer imports", () => {
    expect(
      findTranscriptWriterBoundaryViolations(`
        import { appendSessionTranscriptMessage } from "../config/sessions/transcript-append.test-support.js";
        import { emitSessionTranscriptUpdate as emitUpdate } from "../sessions/transcript-events.js";
      `),
    ).toEqual([
      { line: 2, reason: 'imports legacy transcript writer "appendSessionTranscriptMessage"' },
      { line: 3, reason: 'imports legacy transcript writer "emitSessionTranscriptUpdate"' },
    ]);
  });

  it("flags direct and namespace legacy transcript writer calls", () => {
    expect(
      findTranscriptWriterBoundaryViolations(`
        appendSessionTranscriptMessage({ transcriptPath, message });
        transcriptEvents.emitSessionTranscriptUpdate({ sessionFile });
        transcriptAppend["appendSessionTranscriptMessage"]({ transcriptPath, message });
      `),
    ).toEqual([
      { line: 2, reason: 'calls legacy transcript writer "appendSessionTranscriptMessage"' },
      { line: 3, reason: 'references legacy transcript writer "emitSessionTranscriptUpdate"' },
      { line: 4, reason: 'references legacy transcript writer "appendSessionTranscriptMessage"' },
    ]);
  });

  it("allows migrated transcript writer helpers", () => {
    expect(
      findTranscriptWriterBoundaryViolations(`
        import { appendTranscriptMessage, publishTranscriptUpdate } from "../config/sessions/session-accessor.js";
        appendTranscriptMessage(scope, { message });
        publishTranscriptUpdate(scope, { messageId });
      `),
    ).toEqual([]);
  });

  it("flags legacy writers inside the gateway sessions.create lifecycle", () => {
    expect(
      findGatewaySessionCreateLifecycleViolations(`
        const handlers = {
          "sessions.create": async () => {
            await updateSessionStore(storePath, () => undefined);
            ensureSessionTranscriptFile(params);
          },
          "sessions.patch": async () => {
            await updateSessionStore(storePath, () => undefined);
          },
        };
      `),
    ).toEqual([
      { line: 4, reason: 'calls legacy sessions.create lifecycle writer "updateSessionStore"' },
      {
        line: 5,
        reason: 'calls legacy sessions.create lifecycle writer "ensureSessionTranscriptFile"',
      },
    ]);
  });

  it("allows the gateway sessions.create lifecycle accessor seam", () => {
    expect(
      findGatewaySessionCreateLifecycleViolations(`
        const handlers = {
          "sessions.create": async () => {
            await createSessionEntryWithTranscript(scope, createEntry);
          },
        };
      `),
    ).toEqual([]);
  });

  it("flags gateway manual compact trim file mutations", () => {
    expect(
      findSessionCompactManualTrimBoundaryViolations(`
        import { archiveFileOnDisk } from "../session-utils.js";
        import { readRecentSessionTranscriptLines } from "../session-transcript-readers.js";
        const tail = readRecentSessionTranscriptLines(scope);
        const archived = archiveFileOnDisk(filePath, "bak");
      `),
    ).toEqual([
      { line: 2, reason: 'imports legacy session store manual compact trim "archiveFileOnDisk"' },
      {
        line: 3,
        reason:
          'imports legacy session store manual compact trim "readRecentSessionTranscriptLines"',
      },
      {
        line: 4,
        reason: 'calls legacy session store manual compact trim "readRecentSessionTranscriptLines"',
      },
      { line: 5, reason: 'calls legacy session store manual compact trim "archiveFileOnDisk"' },
    ]);
  });

  it("flags direct lifecycle cleanup helper usage", () => {
    expect(
      findSessionLifecycleCleanupBoundaryViolations(`
        import { archiveRemovedSessionTranscripts } from "../config/sessions/store.js";
        import { cleanupArchivedSessionTranscripts } from "../gateway/session-utils.fs.js";
        archiveRemovedSessionTranscripts({ removedSessionFiles, referencedSessionIds, storePath, reason: "deleted" });
        cleanupArchivedSessionTranscripts({ directories, rules });
      `),
    ).toEqual([
      {
        line: 2,
        reason: 'imports legacy session store lifecycle cleanup "archiveRemovedSessionTranscripts"',
      },
      {
        line: 3,
        reason:
          'imports legacy session store lifecycle cleanup "cleanupArchivedSessionTranscripts"',
      },
      {
        line: 4,
        reason: 'calls legacy session store lifecycle cleanup "archiveRemovedSessionTranscripts"',
      },
      {
        line: 5,
        reason: 'calls legacy session store lifecycle cleanup "cleanupArchivedSessionTranscripts"',
      },
    ]);
  });

  it("ignores comments and strings that describe legacy readers", () => {
    expect(
      findSessionAccessorBoundaryViolations(`
        // loadSessionStore and readSessionEntries used to be called here.
        const description = "loadSessionStore";
      `),
    ).toEqual([]);
  });

  it("flags embedded-agent calls that pass deprecated sessionFile identity", () => {
    expect(
      findEmbeddedAgentSessionTargetViolations(`
        const sessionFile = agentRuntime.session.resolveSessionFilePath(sessionId, entry);
        agentRuntime.runEmbeddedAgent({
          sessionId,
          sessionKey,
          sessionFile,
        });
        runEmbeddedAgent({
          sessionId,
          sessionFile: transcriptPath,
        });
      `),
    ).toEqual([
      {
        line: 2,
        reason: 'references legacy embedded-agent session file resolver "resolveSessionFilePath"',
      },
      {
        line: 6,
        reason:
          'passes deprecated embedded-agent runtime identity field "sessionFile"; use sessionTarget',
      },
      {
        line: 10,
        reason:
          'passes deprecated embedded-agent runtime identity field "sessionFile"; use sessionTarget',
      },
    ]);
  });

  it("allows embedded-agent calls that pass sessionTarget identity", () => {
    expect(
      findEmbeddedAgentSessionTargetViolations(`
        agentRuntime.runEmbeddedAgent({
          sessionId,
          sessionKey,
          sessionTarget: { agentId, sessionId, sessionKey, storePath },
        });
      `),
    ).toEqual([]);
  });
});

describe("session accessor debt ratchet", () => {
  it("flags unmigrated files whose legacy call-site count exceeds the baseline", () => {
    expect(
      compareSessionAccessorDebt(
        {
          sessionAccessorRead: { "src/a.ts": 3 },
          sessionAccessorWrite: { "src/new.ts": 1 },
        },
        {
          sessionAccessorRead: { "src/a.ts": 2 },
          sessionAccessorWrite: {},
        },
      ),
    ).toEqual({
      regressions: [
        { concern: "sessionAccessorRead", path: "src/a.ts", currentCount: 3, baselineCount: 2 },
        { concern: "sessionAccessorWrite", path: "src/new.ts", currentCount: 1, baselineCount: 0 },
      ],
      improvements: [],
    });
  });

  it("passes when counts match the baseline", () => {
    expect(
      compareSessionAccessorDebt(
        { sessionAccessorRead: { "src/a.ts": 2 } },
        { sessionAccessorRead: { "src/a.ts": 2 } },
      ),
    ).toEqual({ regressions: [], improvements: [] });
  });

  it("fails with a regen instruction when counts drop below the baseline", () => {
    const debt = compareSessionAccessorDebt(
      { sessionAccessorRead: { "src/a.ts": 1 } },
      { sessionAccessorRead: { "src/a.ts": 2, "src/gone.ts": 3 } },
    );
    expect(debt).toEqual({
      regressions: [],
      improvements: [
        { concern: "sessionAccessorRead", path: "src/a.ts", currentCount: 1, baselineCount: 2 },
        { concern: "sessionAccessorRead", path: "src/gone.ts", currentCount: 0, baselineCount: 3 },
      ],
    });
    expect(formatSessionAccessorDebtImprovements(debt.improvements)).toEqual([
      "Legacy session accessor debt dropped below scripts/lib/session-accessor-debt-baseline.json:",
      "- src/a.ts [sessionAccessorRead]: 1 legacy call site(s), stale baseline allows 2",
      "- src/gone.ts [sessionAccessorRead]: 0 legacy call site(s), stale baseline allows 3",
      "Run `pnpm lint:tmp:session-accessor-boundary:gen` to ratchet the baseline down and commit it.",
    ]);
  });
});
