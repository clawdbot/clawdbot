import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAbortControllerEntry } from "./chat-abort.js";

const sessionRow = vi.hoisted(() => ({
  key: "agent:main:main",
  kind: "direct",
  status: "done",
  updatedAt: 1,
}));

vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("./chat-display-projection.js", () => ({
  projectChatDisplayMessage: (message: unknown) => message,
}));
vi.mock("./session-utils.js", () => ({
  attachOpenClawTranscriptMeta: (message: unknown) => message,
  loadGatewaySessionRow: () => sessionRow,
  loadSessionEntry: () => ({ entry: undefined, storePath: "" }),
  readSessionMessageCountAsync: vi.fn(),
}));

const { createTranscriptUpdateBroadcastHandler } = await import("./server-session-events.js");

function createActiveRun(projectSessionActive: boolean): ChatAbortControllerEntry {
  return {
    controller: new AbortController(),
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    startedAtMs: Date.now(),
    expiresAtMs: Date.now() + 60_000,
    projectSessionActive,
  };
}

function createHandler(projectSessionActive: boolean) {
  const broadcastToConnIds = vi.fn();
  const handler = createTranscriptUpdateBroadcastHandler({
    broadcastToConnIds,
    sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
    sessionMessageSubscribers: { get: () => new Set<string>() },
    chatAbortControllers: new Map([["run-before-finalize", createActiveRun(projectSessionActive)]]),
  });
  return { broadcastToConnIds, handler };
}

async function emitAssistantTranscriptUpdate(
  projectSessionActive: boolean,
  message: Record<string, unknown> = {
    role: "assistant",
    content: [{ type: "text", text: "Final answer" }],
  },
) {
  const { broadcastToConnIds, handler } = createHandler(projectSessionActive);
  handler({
    sessionFile: "/tmp/sess-main.jsonl",
    sessionKey: "agent:main:main",
    message,
    messageId: "message-1",
    messageSeq: 1,
  });
  await vi.waitFor(() => expect(broadcastToConnIds).toHaveBeenCalledTimes(1));
  return broadcastToConnIds.mock.calls[0]?.[1];
}

describe("createTranscriptUpdateBroadcastHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps transcript snapshots active while plugin finalization delays the terminal event", async () => {
    // before_agent_finalize hooks run after the assistant transcript write but
    // before terminal delivery. The active-run registry remains authoritative
    // during that interval even when the persisted session row says done.
    await expect(emitAssistantTranscriptUpdate(true)).resolves.toMatchObject({
      sessionKey: "agent:main:main",
      hasActiveRun: true,
      session: { key: "agent:main:main", status: "done", hasActiveRun: true },
    });
  });

  it("keeps stale-run recovery when terminal lifecycle has cleared active projection", async () => {
    await expect(emitAssistantTranscriptUpdate(false)).resolves.toMatchObject({
      sessionKey: "agent:main:main",
      hasActiveRun: false,
      session: { hasActiveRun: false },
    });
  });
  it("broadcasts the authenticated sender ownership decision", async () => {
    await expect(
      emitAssistantTranscriptUpdate(false, {
        role: "user",
        content: [{ type: "text", text: "Owner turn" }],
        __openclaw: { senderIsOwner: true },
      }),
    ).resolves.toMatchObject({
      senderIsOwner: true,
    });
  });
});
