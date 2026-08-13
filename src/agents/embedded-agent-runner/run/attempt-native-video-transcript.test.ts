import fs from "node:fs/promises";
import path from "node:path";
import { readSessionTranscriptRawDelta } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import {
  appendTranscriptMessage,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { buildPersistedUserTurnMessage } from "../../../sessions/user-turn-transcript.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { convertToLlm } from "../../sessions/messages.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { materializeProviderContext } from "./images.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const MP4 = Buffer.from("0000001c6674797069736f6d0000000069736f6d0000000000000000", "hex");

describe("native video transcript replay", () => {
  it("replays native video after reopening the canonical transcript", async () => {
    const stateDir = tempDirs.make("openclaw-video-transcript-replay-");
    const inboundDir = path.join(stateDir, "media", "inbound");
    await fs.mkdir(inboundDir, { recursive: true });
    await fs.writeFile(path.join(inboundDir, "history.mp4"), MP4);
    const env = captureEnv(["OPENCLAW_STATE_DIR"]);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    const target = {
      agentId: "main",
      sessionId: "video-replay",
      sessionKey: "agent:main:video-replay",
      storePath: path.join(stateDir, "sessions.json"),
    };
    const persisted = buildPersistedUserTurnMessage({
      text: "inspect historical video",
      media: [
        {
          kind: "video",
          contentType: "video/mp4",
          sizeBytes: MP4.length,
          url: "media://inbound/history.mp4",
          hydrationSuppressed: true,
        },
      ],
    });
    const serialized = JSON.stringify(persisted);
    expect(serialized).toContain("media://inbound/history.mp4");
    expect(serialized).not.toContain(MP4.toString("base64"));
    expect(serialized).not.toContain(stateDir);

    try {
      await upsertSessionEntryCore(target, {
        sessionId: target.sessionId,
        updatedAt: 1,
      });
      await appendTranscriptMessage(target, {
        cwd: stateDir,
        eventId: "historical-user",
        message: persisted,
        now: 1,
      });

      const reopened = SessionManager.open(target, stateDir).buildSessionContext();
      const provider = await materializeProviderContext({
        context: { systemPrompt: "system", messages: convertToLlm(reopened.messages), tools: [] },
        workspaceDir: stateDir,
      });
      expect(provider.messages[0]?.content).toEqual([
        { type: "text", text: "inspect historical video" },
        { type: "video", data: MP4.toString("base64"), mimeType: "video/mp4" },
      ]);

      const raw = await readSessionTranscriptRawDelta({
        ...target,
        maxBytes: 100_000,
        maxEvents: 100,
      });
      expect(JSON.stringify(raw)).toContain("media://inbound/history.mp4");
      expect(JSON.stringify(raw)).not.toContain(MP4.toString("base64"));
    } finally {
      env.restore();
    }
  });
});
