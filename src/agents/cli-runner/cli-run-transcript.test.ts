import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { applyAssistantDeliveryDirectives } from "../../config/sessions/transcript-assistant-delivery.js";
import type { AssistantMessage } from "../../llm/types.js";
import { upsertSessionEntry } from "../../plugin-sdk/session-store-runtime.js";
import {
  onInternalSessionTranscriptUpdate,
  type InternalSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { persistCliAssistantTranscript } from "./cli-run-transcript.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawAgentDatabasesForTest());

it("prepares the exact CLI assistant before its first transcript publication", async () => {
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
      stopReason: "stop",
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
  } finally {
    unsubscribe();
  }
});
