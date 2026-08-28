import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, test } from "vitest";
import type { WebSocket } from "ws";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { appendTranscriptMessageSync } from "../../config/sessions/session-accessor.js";
import { installGatewayTestHooks, rpcReq, testState, writeSessionStore } from "../test-helpers.js";
import { installConnectedControlUiServerSuite } from "../test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

const DATA_URL = "DATA:image/png;BASE64,cG5n";
const SESSION_ID = "sess-inline-media-proof";
const SESSION_KEY = "agent:main:main";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function expectRedactedInlineMediaBlock(content: unknown): void {
  expect(content).toEqual([
    {
      type: "input_image",
      omitted: true,
      bytes: Buffer.byteLength(DATA_URL, "utf8"),
    },
  ]);
}

describe("chat history inline media redaction (real WS gateway)", () => {
  test("stored history endpoints redact Responses inline images", async () => {
    const dir = tempDirs.make("openclaw-chat-history-redact-");
    testState.sessionStorePath = path.join(dir, "sessions.json");
    try {
      await writeSessionStore({
        entries: {
          [SESSION_KEY]: { sessionId: SESSION_ID, updatedAt: Date.now() },
        },
      });
      const appended = expectDefined(
        appendTranscriptMessageSync(
          {
            agentId: "main",
            sessionId: SESSION_ID,
            sessionKey: SESSION_KEY,
            storePath: testState.sessionStorePath,
          },
          {
            message: {
              role: "assistant",
              content: [{ type: "input_image", image_url: DATA_URL }],
              timestamp: Date.now(),
            },
            now: Date.now(),
          },
        ),
        "inline-media transcript append",
      );

      const history = await rpcReq<{ messages?: Array<Record<string, unknown>> }>(
        ws,
        "chat.history",
        { sessionKey: SESSION_KEY, limit: 10 },
      );
      expect(history.ok).toBe(true);
      const historyMessages = history.payload?.messages ?? [];
      const assistantMessage = historyMessages.find((message) => message.role === "assistant");
      expect(assistantMessage).toBeDefined();
      expectRedactedInlineMediaBlock(assistantMessage?.content);
      expect(JSON.stringify(historyMessages)).not.toContain(DATA_URL);

      const full = await rpcReq<{ ok?: boolean; message?: Record<string, unknown> }>(
        ws,
        "chat.message.get",
        { sessionKey: SESSION_KEY, messageId: appended.messageId },
      );
      expect(full.ok).toBe(true);
      expect(full.payload?.ok).toBe(true);
      expectRedactedInlineMediaBlock(full.payload?.message?.content);
      expect(JSON.stringify(full.payload)).not.toContain(DATA_URL);

      console.log(
        `chat.history real-request redaction: ${JSON.stringify(assistantMessage?.content ?? null)}`,
      );
      console.log(
        `chat.message.get real-request redaction: ${JSON.stringify(full.payload?.message?.content ?? null)}`,
      );
    } finally {
      testState.sessionStorePath = undefined;
    }
  });
});
