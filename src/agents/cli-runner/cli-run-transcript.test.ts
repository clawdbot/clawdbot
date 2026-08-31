import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import { sanitizeChatHistoryMessages } from "../../gateway/chat-display-projection.sanitize.js";
import type { AssistantMessage } from "../../llm/types.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import {
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { isIntermediateAssistantTranscriptMessage } from "../embedded-agent-runner/message-visibility.js";
import { persistCliAssistantTranscript } from "./cli-run-transcript.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawAgentDatabasesForTest());

it.each([
  { kind: "completed", yielded: undefined, stopReason: "stop" },
  { kind: "yielded", yielded: true, stopReason: "stop" },
  { kind: "interrupted", yielded: undefined, stopReason: "aborted" },
  { kind: "interrupted after yielding", yielded: true, stopReason: "aborted" },
] as const)(
  "prepares the $kind CLI assistant before its first transcript publication",
  async ({ yielded, stopReason }) => {
    const root = tempDirs.make("openclaw-cli-media-transcript-");
    const target = {
      agentId: "main",
      sessionId: "cli-media-session",
      sessionKey: "agent:main:cli-media",
      storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
    };
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: target.sessionId, updatedAt: Date.now() },
    });
    const sourceText = "Artifacts ready\nMEDIA:./artifact.json";
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) =>
      applyAssistantDeliveryDirectives(message, { managedMediaUrls: ["./artifact.json"] }),
    );
    const updates: InternalSessionTranscriptUpdate[] = [];
    const unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
    try {
      const result = await persistCliAssistantTranscript({
        runParams: {
          ...target,
          sessionFile: `sqlite://agents/main/${target.sessionId}`,
          workspaceDir: root,
          prompt: "make an artifact",
          provider: "claude-cli",
          runId: "cli-media-run",
          timeoutMs: 1_000,
          persistAssistantTranscript: true,
          prepareAssistantTranscriptMessage,
        },
        text: sourceText,
        modelId: "claude-sonnet-4-6",
        stopReason,
        yielded,
      });
      expect(result.owned).toBe(true);
      expect(prepareAssistantTranscriptMessage).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ content: [{ type: "text", text: sourceText }] }),
        sourceText,
      );
      expect(updates).toHaveLength(1);
      expect(updates[0]?.message).toMatchObject({
        content: [{ type: "text", text: sourceText }],
        idempotencyKey: result.idempotencyKey,
        openclawDelivery: { mediaUrls: ["./artifact.json"] },
      });
      const messages = (await loadTranscriptEvents(target)).flatMap((event) =>
        typeof event === "object" && event !== null && "message" in event ? [event.message] : [],
      );
      expect(messages).toHaveLength(1);
      expect(isIntermediateAssistantTranscriptMessage(messages[0])).toBe(
        yielded === true && stopReason === "stop",
      );
      expect(messages[0]).toMatchObject({ stopReason });
      if (yielded && stopReason === "stop") {
        expect(messages[0]).toMatchObject({
          openclawStreamFallback: {
            replacementText: sourceText,
            source: "segment",
            itemId: "cli-media-run",
          },
        });
      } else {
        expect(messages[0]).not.toHaveProperty("openclawStreamFallback");
      }
      expect(sanitizeChatHistoryMessages(messages)).toMatchObject([
        { content: [{ type: "text", text: "Artifacts ready" }] },
      ]);
    } finally {
      unsubscribe();
    }
  },
);

type NativeTurnCase = {
  nativeTurn?: { cliSessionId: string; terminalRecordId: string };
  expected?: { cliSessionId: string; terminalRecordId: string };
};

it.each<[string, NativeTurnCase]>([
  [
    "records the native turn a CLI aggregate flattens",
    {
      nativeTurn: { cliSessionId: "native-session-1", terminalRecordId: "native-record-9" },
      expected: { cliSessionId: "native-session-1", terminalRecordId: "native-record-9" },
    },
  ],
  ["omits the link when the run reported no native turn", {}],
])("%s", async (_label, testCase) => {
  // The aggregate is the only record written at the point where both the
  // flattened text and the native records that produced it are known, so the
  // link has to be stamped here or readers are left inferring it.
  const root = tempDirs.make("openclaw-cli-native-turn-");
  const target = {
    agentId: "main",
    sessionId: "cli-native-turn-session",
    sessionKey: "agent:main:cli-native-turn",
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: target.sessionId, updatedAt: Date.now() },
  });
  const updates: InternalSessionTranscriptUpdate[] = [];
  const unsubscribe = onInternalSessionTranscriptUpdate((update) => updates.push(update));
  try {
    const result = await persistCliAssistantTranscript({
      runParams: {
        ...target,
        sessionFile: `sqlite://agents/main/${target.sessionId}`,
        workspaceDir: root,
        prompt: "run it",
        provider: "claude-cli",
        runId: "cli-native-turn-run",
        timeoutMs: 1_000,
        persistAssistantTranscript: true,
      },
      text: "part one\n\npart two",
      modelId: "claude-sonnet-4-6",
      stopReason: "stop",
      ...(testCase.nativeTurn ? { nativeTurn: testCase.nativeTurn } : {}),
    });

    expect(result.owned).toBe(true);
    expect(updates).toHaveLength(1);
    const persisted = updates[0]?.message as Record<string, unknown> | undefined;
    expect(persisted?.idempotencyKey).toBe(result.idempotencyKey);
    expect(persisted?.cliNativeTurn).toEqual(testCase.expected);
  } finally {
    unsubscribe();
  }
});
