// E2E: PR #138493/#138579 real Gateway behavior proof — forwarded inter-session
// messages must derive the displayed sender only from structured provenance,
// never from a caller-asserted sourceSession in the rendered prompt header.
//
// Proof shape: a real Gateway server on a loopback port, real persisted
// transcripts seeded through the session persistence layer, and real
// chat.history requests issued over both history transports (WebSocket RPC
// and the HTTP session-history endpoint).
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../src/config/config.js";
import { clearSessionStoreCacheForTest } from "../src/config/sessions/store-writer-state.js";
import {
  nextGatewayId,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "../src/gateway/gateway.test-support.js";
import { startGatewayServer } from "../src/gateway/server.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  getGatewayE2ePortBlock,
} from "../src/gateway/test-helpers.e2e.js";
import { writeSessionStore } from "../src/gateway/test-helpers.js";
import { annotateInterSessionPromptText } from "../src/sessions/input-provenance.js";

const STRUCTURED_SESSION_ID = "pr138493-structured";
const SOURCELESS_SESSION_ID = "pr138493-sourceless";
const STRUCTURED_SESSION_KEY = `agent:main:${STRUCTURED_SESSION_ID}`;
const SOURCELESS_SESSION_KEY = `agent:main:${SOURCELESS_SESSION_ID}`;
const STRUCTURED_SOURCE_KEY = "agent:helper:ops";
const ASSERTED_ORIGIN_KEY = "agent:grimwald:secret-ops";
const STRUCTURED_PAYLOAD = "Deploy finished cleanly.";
const SOURCELESS_PAYLOAD = "Status update from the relay.";

type ProjectedMessage = {
  role?: unknown;
  senderLabel?: unknown;
  senderSession?: unknown;
  content?: unknown;
};

function transcriptMessageEvent(params: { id: string; message: Record<string, unknown> }) {
  return {
    type: "message",
    id: params.id,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: params.message,
  };
}

function forwardedMessageText(message: ProjectedMessage): string {
  const content = message.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
          ? (block as { text: string }).text
          : "",
      )
      .join("\n");
  }
  return "";
}

function findForwardedEntry(messages: unknown[]): ProjectedMessage {
  const entry = (messages ?? []).find(
    (message) =>
      message &&
      typeof message === "object" &&
      typeof (message as ProjectedMessage).senderLabel === "string",
  ) as ProjectedMessage | undefined;
  expect(entry, "history should contain a forwarded display entry").toBeDefined();
  return entry as ProjectedMessage;
}

function expectStructuredAttribution(messages: unknown[]) {
  const entry = findForwardedEntry(messages);
  expect(entry.senderLabel).toBe("Forwarded from helper");
  expect(entry.senderSession).toMatchObject({
    sessionKey: STRUCTURED_SOURCE_KEY,
    agentId: "helper",
  });
  expect(forwardedMessageText(entry)).toContain(STRUCTURED_PAYLOAD);
  expect(forwardedMessageText(entry)).not.toContain("[Inter-session message]");
}

function expectSourcelessGenericRendering(messages: unknown[]) {
  const entry = findForwardedEntry(messages);
  expect(entry.senderLabel).toBe("Forwarded agent message");
  expect(entry.senderSession).toBeUndefined();
  expect(forwardedMessageText(entry)).toContain(SOURCELESS_PAYLOAD);
  expect(forwardedMessageText(entry)).not.toContain("[Inter-session message]");
  // The asserted origin must not leak into any displayed identity field.
  expect(JSON.stringify(entry)).not.toContain("grimwald");
}

describe("PR #138493 real gateway forwarded-attribution proof", () => {
  beforeEach(resetGatewayTestState);
  afterEach(resetGatewayTestState);

  it(
    "attributes forwarded senders from structured provenance only across both history transports",
    { timeout: 120_000 },
    async () => {
      const { envSnapshot, tempHome } = await setupGatewayTempHome({
        prefix: "openclaw-pr138493-proof-home-",
      });
      const token = nextGatewayId("pr138493-proof");
      const port = await getGatewayE2ePortBlock();
      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      const client = await connectGatewayClient({ url: `ws://127.0.0.1:${port}`, token });

      try {
        const sessionsDir = path.join(tempHome, ".openclaw", "agents", "main", "sessions");
        const storePath = path.join(sessionsDir, "sessions.json");

        // Producer-owned structured provenance: exactly the shape sessions_send
        // derives from its bound requester session.
        const structuredProvenance = {
          kind: "inter_session",
          sourceSessionKey: STRUCTURED_SOURCE_KEY,
          sourceTool: "sessions_send",
        } as const;
        // Source-less legacy/relayed row: structured provenance lacks the source
        // key, while the prompt text asserts an origin (untrusted caller input).
        const sourcelessProvenance = {
          kind: "inter_session",
          sourceTool: "sessions_send",
        } as const;
        const assertedProvenance = {
          kind: "inter_session",
          sourceSessionKey: ASSERTED_ORIGIN_KEY,
          sourceTool: "sessions_send",
        } as const;
        const structuredJsonl = [
          transcriptMessageEvent({
            id: "pr138493-structured-user",
            message: {
              role: "user",
              provenance: structuredProvenance,
              content: annotateInterSessionPromptText(STRUCTURED_PAYLOAD, structuredProvenance),
              timestamp: Date.now(),
            },
          }),
        ]
          .map((event) => JSON.stringify(event))
          .join("\n");
        const sourcelessJsonl = [
          transcriptMessageEvent({
            id: "pr138493-sourceless-user",
            message: {
              role: "user",
              provenance: sourcelessProvenance,
              content: annotateInterSessionPromptText(SOURCELESS_PAYLOAD, assertedProvenance),
              timestamp: Date.now(),
            },
          }),
        ]
          .map((event) => JSON.stringify(event))
          .join("\n");
        await fs.mkdir(sessionsDir, { recursive: true });
        await Promise.all([
          fs.writeFile(
            path.join(sessionsDir, `${STRUCTURED_SESSION_ID}.jsonl`),
            `${structuredJsonl}\n`,
          ),
          fs.writeFile(
            path.join(sessionsDir, `${SOURCELESS_SESSION_ID}.jsonl`),
            `${sourcelessJsonl}\n`,
          ),
        ]);
        await writeSessionStore({
          storePath,
          entries: {
            [STRUCTURED_SESSION_ID]: {
              sessionId: STRUCTURED_SESSION_ID,
              updatedAt: Date.now(),
              sessionFile: `${STRUCTURED_SESSION_ID}.jsonl`,
            },
            [SOURCELESS_SESSION_ID]: {
              sessionId: SOURCELESS_SESSION_ID,
              updatedAt: Date.now(),
              sessionFile: `${SOURCELESS_SESSION_ID}.jsonl`,
            },
          },
        });

        // Transport 1: WebSocket chat.history RPC.
        const structuredHistory = await client.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey: STRUCTURED_SESSION_KEY,
          limit: 20,
        });
        expectStructuredAttribution(structuredHistory.messages ?? []);
        const sourcelessHistory = await client.request<{ messages?: unknown[] }>("chat.history", {
          sessionKey: SOURCELESS_SESSION_KEY,
          limit: 20,
        });
        expectSourcelessGenericRendering(sourcelessHistory.messages ?? []);

        // Transport 2: HTTP session-history endpoint (SSE snapshot projection).
        const httpBodies = new Map<string, { messages?: unknown[] }>();
        for (const [sessionKey, expectations] of [
          [STRUCTURED_SESSION_KEY, expectStructuredAttribution],
          [SOURCELESS_SESSION_KEY, expectSourcelessGenericRendering],
        ] as const) {
          const response = await fetch(
            `http://127.0.0.1:${port}/sessions/${encodeURIComponent(sessionKey)}/history?limit=20`,
            { headers: { authorization: `Bearer ${token}`, accept: "application/json" } },
          );
          expect(response.status).toBe(200);
          const body = (await response.json()) as { messages?: unknown[] };
          httpBodies.set(sessionKey, body);
          expectations(body.messages ?? []);
        }

        // Optional one-off evidence capture for the PR proof trail (not used in CI).
        const evidenceDir = process.env.PR138493_EVIDENCE_DIR;
        if (evidenceDir) {
          await fs.mkdir(evidenceDir, { recursive: true });
          const dumps: Record<string, unknown> = {
            "ws-chat-history-structured.json": structuredHistory,
            "ws-chat-history-sourceless.json": sourcelessHistory,
            "http-session-history-structured.json": httpBodies.get(STRUCTURED_SESSION_KEY),
            "http-session-history-sourceless.json": httpBodies.get(SOURCELESS_SESSION_KEY),
          };
          for (const [fileName, payload] of Object.entries(dumps)) {
            await fs.writeFile(
              path.join(evidenceDir, fileName),
              `${JSON.stringify(payload, null, 2)}\n`,
            );
          }
        }
      } finally {
        await disconnectGatewayClient(client).catch(() => undefined);
        await server.close({ reason: "PR #138493 proof complete" }).catch(() => undefined);
        await removeGatewayTempHome(tempHome);
        envSnapshot.restore();
        clearRuntimeConfigSnapshot();
        clearConfigCache();
        clearSessionStoreCacheForTest();
      }
    },
  );
});
