import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../../../../src/config/sessions/session-accessor.js";
import {
  disconnectGatewayClient,
  startGatewayWithClient,
} from "../../../../src/gateway/test-helpers.e2e.js";
import { installGatewayTestHooks } from "../../../../src/gateway/test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const TOKEN = "qa-incognito-fork-proof-token";

describe("Gateway incognito fork product proof", () => {
  it("returns a readable incognito child over the live Gateway RPC", async () => {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required");
    }
    const sourceKey = "agent:main:dashboard:incognito-proof-source";
    const sourceSessionId = "incognito-proof-source";
    const sourceScope = {
      agentId: "main",
      sessionKey: sourceKey,
      sessionId: sourceSessionId,
    };
    await upsertSessionEntryCore(sourceScope, {
      incognito: true,
      sessionId: sourceSessionId,
      updatedAt: Date.now(),
    });
    await appendTranscriptEvent(sourceScope, {
      type: "session",
      id: sourceSessionId,
      version: 3,
    });
    await appendTranscriptMessage(sourceScope, {
      eventId: "incognito-proof-prefix",
      message: { role: "user", content: "prefix" },
      parentId: null,
    });
    await appendTranscriptMessage(sourceScope, {
      eventId: "incognito-proof-user",
      message: { role: "user", content: "proof" },
      parentId: "incognito-proof-prefix",
    });

    const started = await startGatewayWithClient({
      cfg: {
        agents: { list: [{ id: "main", default: true }] },
        gateway: { auth: { mode: "token", token: TOKEN } },
      },
      configPath: path.join(stateDir, "openclaw.json"),
      token: TOKEN,
      clientDisplayName: "incognito-fork-proof",
      scopes: ["operator.read", "operator.write"],
    });
    try {
      const response = await started.client.request<{
        sessionKey: string;
        editorText?: string;
      }>("sessions.fork", { sessionKey: sourceKey, entryId: "incognito-proof-user" });
      const childKey = response.sessionKey;
      const childEntry = loadSessionEntry({ agentId: "main", sessionKey: childKey });
      const childEvents = await loadTranscriptEvents({
        agentId: "main",
        sessionKey: childKey,
        sessionId: childEntry?.sessionId ?? "",
      });
      const childEventIds = childEvents.flatMap((event) =>
        event && typeof event === "object" && "id" in event && typeof event.id === "string"
          ? [event.id]
          : [],
      );
      console.log(
        JSON.stringify({
          gatewayRpc: "sessions.fork",
          ok: true,
          sourceKey,
          childKey,
          childReadable: childEntry?.sessionId !== undefined,
          childIncognito: childEntry?.incognito === true,
          childEventIds,
        }),
      );
      expect(childKey).toMatch(/^agent:main:dashboard:incognito-/u);
      expect(childEntry).toMatchObject({ incognito: true });
      expect(childEventIds).toEqual([childEntry?.sessionId, "incognito-proof-prefix"]);
    } finally {
      await disconnectGatewayClient(started.client);
      await started.server.close({ reason: "incognito fork proof complete" });
    }
  });
});
