import { expect } from "vitest";
import {
  readFixtureLog,
  type StartTuiPtyFixture,
  waitForSynchronizedFrameRows,
} from "./tui-pty-harness-assertion-test-support.js";

export async function exerciseDelayedPeerReplies(
  startFixture: StartTuiPtyFixture,
  startupTimeoutMs: number,
  testTimeoutMs: number,
) {
  const peerFixture = await startFixture();
  const markers = [
    "PTY_PEER_DELAYED_PROMPT",
    "PTY_PEER_NORMAL_REPLY",
    "PTY_PEER_MIRROR_REPLY",
  ] as const;
  try {
    await peerFixture.run.waitForOutput("local ready | idle", startupTimeoutMs);
    await peerFixture.run.write("/session agent:main:delayed-peer-finals\r", { delay: false });
    await waitForSynchronizedFrameRows(
      peerFixture.run,
      (rows) =>
        rows.some((row) => row.includes("session agent:main:delayed-peer-finals")) &&
        rows.some((row) => row.includes("local ready | idle")),
      startupTimeoutMs,
    );
    await peerFixture.run.write("/gateway-status\r", { delay: false });
    await peerFixture.waitForLogEntry((entry) => entry.method === "delayedPeerComplete");
    const rows = await waitForSynchronizedFrameRows(
      peerFixture.run,
      (frame) =>
        markers.every((marker) => frame.some((row) => row.includes(marker))) &&
        frame.some((row) => row.includes("local ready | idle")),
      testTimeoutMs,
    );
    const entries = await readFixtureLog(peerFixture.logPath);
    const events = entries.filter((entry) => entry.method === "delayedPeerEvent");
    const frame = rows.join("\n");
    console.log(
      `[behavior-evidence] tui-delayed-peer-finals ${JSON.stringify({
        rows,
        events,
        terminalOutput: peerFixture.run.output(),
      })}`,
    );
    expect(events).toHaveLength(5);
    expect(entries.some((entry) => entry.method === "sendChat")).toBe(false);
    for (const marker of markers) {
      expect(frame.split(marker)).toHaveLength(2);
    }
    expect(frame.indexOf(markers[0])).toBeLessThan(frame.indexOf(markers[1]));
    expect(frame.indexOf(markers[1])).toBeLessThan(frame.indexOf(markers[2]));
  } finally {
    await peerFixture.cleanup();
  }
}

export async function exerciseLiveReplyRendering(
  startFixture: StartTuiPtyFixture,
  startupTimeoutMs: number,
) {
  const liveFixture = await startFixture({
    env: { OPENCLAW_TUI_PTY_COLS: "220", OPENCLAW_TUI_PTY_ROWS: "50" },
  });
  try {
    await liveFixture.run.waitForOutput("local ready", startupTimeoutMs);
    await liveFixture.run.write("live reply dedupe proof: first\r", { delay: false });
    await liveFixture.run.waitForOutput("TUI_LIVE_FIRST");
    await liveFixture.run.write("live reply dedupe proof: second\r", { delay: false });
    const rows = await waitForSynchronizedFrameRows(
      liveFixture.run,
      (frame) => frame.some((row) => row.includes("TUI_LIVE_SECOND")),
      startupTimeoutMs,
    );
    const assistantRows = rows.filter(
      (row) => row.includes("TUI_LIVE_FIRST") || row.includes("TUI_LIVE_SECOND"),
    );
    expect(assistantRows).toEqual(["TUI_LIVE_FIRST", "TUI_LIVE_SECOND"]);
  } finally {
    await liveFixture.cleanup();
  }
}

/** Generated-script fragment for assistant-specific PTY fixture messages. */
export const TUI_PTY_ASSISTANT_FIXTURE_SCRIPT = `
  let delayedPeerSessionKey: string | undefined;

  function emitDelayedPeerReplies(backend: Pick<TuiBackend, "onEvent">, sessionKey: string) {
    const runId = "peer-delayed-finals";
    const timestamp = Date.now();
    // Match the ID-less normal terminal and source-reply mirror producer shapes.
    const normalFinal = {
      event: "chat",
      payload: {
        runId, sessionKey, seq: 4, state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "PTY_PEER_NORMAL_REPLY" }],
          timestamp,
        },
      },
    };
    const mirrorFinal = {
      event: "chat",
      payload: {
        runId, sessionKey, seq: 1, state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "PTY_PEER_MIRROR_REPLY" }],
          text: "PTY_PEER_MIRROR_REPLY",
          timestamp,
          stopReason: "stop",
          usage: { input: 0, output: 0, totalTokens: 0 },
        },
      },
    };
    const prompt = {
      event: "session.message",
      payload: {
        sessionKey, messageId: "peer-persisted-user", messageSeq: 1,
        message: {
          role: "user",
          content: [{ type: "text", text: "PTY_PEER_DELAYED_PROMPT" }],
          timestamp,
          __openclaw: { id: "peer-persisted-user", seq: 1, idempotencyKey: runId + ":user" },
        },
      },
    };
    for (const event of [normalFinal, mirrorFinal, mirrorFinal, prompt, prompt]) {
      record("delayedPeerEvent", event);
      backend.onEvent?.(event);
    }
    record("delayedPeerComplete", { runId, sessionKey });
  }

  function assistantMessageFromSourceReplyPayloads(
    payloads: ReturnType<typeof buildEmbeddedRunPayloads>,
  ) {
    if (payloads.length === 0) {
      throw new Error("expected source reply payload");
    }
    for (const payload of payloads) {
      const metadata = getReplyPayloadMetadata(payload);
      if (!metadata?.sourceReplyTranscriptMirror) {
        throw new Error("expected source reply transcript mirror metadata");
      }
      record("sourceReplyMetadata", metadata.sourceReplyTranscriptMirror);
    }
    const normalized = normalizeReplyPayloadsForDelivery(payloads);
    const content = normalized.flatMap((payload) => {
      const text = payload.text?.trim();
      return text ? [{ type: "text", text }] : [];
    });
    if (content.length === 0) {
      throw new Error("expected displayable source reply content");
    }
    return { role: "assistant", content, timestamp: Date.now() };
  }

  function buildAttachmentOnlyAssistantMessage(prompt: string, runId: string) {
    if (prompt !== "attachment-only assistant proof") {
      return null;
    }
    record("attachmentOnlyComplete", { runId });
    return {
      role: "assistant",
      content: [
        {
          type: "image",
          data: "SECRET_PTY_IMAGE_BYTES",
          url: "file:///Users/operator/private/image.png",
          artifactId: "SECRET_PTY_ARTIFACT",
        },
      ],
      timestamp: Date.now(),
    };
  }
`;
