import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { createTranscriptUpdateBroadcastHandler } from "./server-session-events.js";

const mocks = vi.hoisted(() => ({
  loadAccessorSessionEntryReadOnly: vi.fn(),
  loadGatewaySessionEntryReadOnly: vi.fn(),
  readSessionMessageCountAsync: vi.fn(),
  loadGatewaySessionRow: vi.fn(),
  resolveTranscriptSessionKeyBySessionId: vi.fn(),
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-accessor.js")>()),
  loadSessionEntryReadOnly: mocks.loadAccessorSessionEntryReadOnly,
  resolveTranscriptSessionKeyBySessionId: mocks.resolveTranscriptSessionKeyBySessionId,
}));
vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadGatewaySessionRow: mocks.loadGatewaySessionRow,
  loadGatewaySessionEntryReadOnly: mocks.loadGatewaySessionEntryReadOnly,
}));
vi.mock("./session-transcript-readers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-transcript-readers.js")>()),
  readSessionMessageCountAsync: mocks.readSessionMessageCountAsync,
}));
vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: () => ({}),
}));

function createContext(loadModelCatalog: (agentId: string) => Promise<ModelCatalogEntry[]>) {
  return {
    broadcastToConnIds: vi.fn(),
    sessionEventSubscribers: { getAll: () => new Set(["conn-1"]) },
    sessionMessageSubscribers: { get: () => new Set<string>() },
    chatAbortControllers: new Map<string, ChatAbortControllerEntry>(),
    loadModelCatalog,
  } as unknown as Parameters<typeof createTranscriptUpdateBroadcastHandler>[0];
}

describe("transcript session-event catalog fencing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadGatewaySessionEntryReadOnly.mockReturnValue({
      entry: { sessionId: "sess-main", lifecycleRevision: "before", updatedAt: 1 },
      storePath: "/tmp/default-sessions.json",
    });
    mocks.loadAccessorSessionEntryReadOnly.mockReturnValue({
      sessionId: "sess-main",
      lifecycleRevision: "before",
      updatedAt: 1,
    });
    mocks.loadGatewaySessionRow.mockReturnValue({
      key: "agent:main:main",
      kind: "direct",
      sessionId: "sess-main",
    });
    mocks.readSessionMessageCountAsync.mockResolvedValue(1);
    mocks.resolveTranscriptSessionKeyBySessionId.mockReturnValue(undefined);
  });

  it("discards a message when its owner changes during catalog loading", async () => {
    let currentEntry = { sessionId: "sess-main", lifecycleRevision: "before", updatedAt: 1 };
    mocks.loadAccessorSessionEntryReadOnly.mockImplementation(() => currentEntry);
    let resolveCatalog!: (value: ModelCatalogEntry[]) => void;
    const loadModelCatalog = vi.fn(
      () =>
        new Promise<ModelCatalogEntry[]>((resolve) => {
          resolveCatalog = resolve;
        }),
    );
    const context = createContext(loadModelCatalog);
    const handler = createTranscriptUpdateBroadcastHandler(context);

    const pending = handler({
      target: {
        agentId: "main",
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/catalog-reset-sessions.json",
      },
      lifecycleRevision: "before",
      message: { role: "user", content: [{ type: "text", text: "stale" }] },
      messageId: "message-before-reset",
    });

    await vi.waitFor(() => expect(loadModelCatalog).toHaveBeenCalledOnce());
    currentEntry = { ...currentEntry, lifecycleRevision: "after" };
    resolveCatalog([]);
    await pending;

    expect(context.broadcastToConnIds).not.toHaveBeenCalled();
  });
});
