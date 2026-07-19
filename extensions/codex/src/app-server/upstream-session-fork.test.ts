import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import type { CodexThreadForkParams, CodexTurn } from "./protocol.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";

const boundaryMocks = vi.hoisted(() => ({
  listTurns: vi.fn(),
}));
const linkMocks = vi.hoisted(() => ({
  delete: vi.fn(),
  upsert: vi.fn(),
}));
const transcriptMocks = vi.hoisted(() => ({
  importHistory: vi.fn(),
}));

const boundary = {
  beforeTurnId: "turn-2",
  targetTurnId: "turn-2",
  retainedMarker: { turnId: "turn-1", userMessageCount: 1 },
} as const;

vi.mock("openclaw/plugin-sdk/session-catalog", async (importOriginal) => ({
  ...(await importOriginal()),
  deleteSessionUpstreamLink: linkMocks.delete,
  upsertSessionUpstreamLink: linkMocks.upsert,
}));

vi.mock("./transcript-mirror.js", () => ({
  importCodexThreadHistoryToTranscript: transcriptMocks.importHistory,
}));

vi.mock("./upstream-fork-boundary.js", () => ({
  resolveCodexUpstreamForkBoundary: vi.fn(async () => ({
    ok: true,
    boundary,
    editorText: "edit me",
  })),
  listCodexUpstreamTurns: boundaryMocks.listTurns,
  precheckCodexUpstreamForkBoundary: vi.fn(() => ({ ok: true, boundary })),
}));

import { forkCodexUpstreamSession } from "./upstream-session-fork.js";

function turn(id: string, text: string): CodexTurn {
  return {
    id,
    status: "completed",
    items: [
      {
        aggregatedOutput: null,
        changes: [],
        command: null,
        cwd: null,
        id: `${id}-user`,
        name: null,
        query: null,
        server: null,
        status: null,
        text: "",
        title: null,
        tool: null,
        content: [{ type: "text", text, textElements: [] }],
        type: "userMessage",
      },
    ],
  };
}

function forkResponse(threadId = "thread-forked") {
  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: "/tmp",
    model: "gpt-5.4",
    modelProvider: "openai",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      id: threadId,
      sessionId: "session-forked",
      cliVersion: "0.143.0",
      createdAt: 1715299200,
      updatedAt: 1715299200,
      cwd: "/tmp",
      ephemeral: false,
      modelProvider: "openai",
      preview: "forked thread",
      source: "appServer",
      status: { type: "notLoaded" },
      turns: [],
    },
  };
}

function forkParams() {
  return {
    targetKey: "agent:main:dashboard:forked",
    source: {
      agentId: "main",
      sessionId: "session-source",
      sessionKey: "agent:main:source",
      storePath: "/tmp/sessions.db",
      entryId: "entry-2",
    },
    upstream: {
      catalogId: "codex",
      hostId: "gateway:local",
      kind: "codex-app-server" as const,
      threadId: "thread-source",
      ref: { connectionFingerprint: "fingerprint", threadId: "thread-source" },
    },
  };
}

type ForkThreadStub = (params: CodexThreadForkParams) => Promise<unknown>;

function forkControl(forkThread: ForkThreadStub = vi.fn(async () => forkResponse())) {
  const archiveThread = vi.fn(async () => undefined);
  const control = {
    archiveThread,
    connectionFingerprint: "fingerprint",
    forkThread,
  } as unknown as CodexSessionCatalogControl;
  control.withPinnedConnection = async (run) => await run(control);
  return { archiveThread, control, forkThread };
}

beforeEach(() => {
  boundaryMocks.listTurns.mockReset();
  linkMocks.delete.mockReset();
  linkMocks.upsert.mockReset().mockReturnValue(true);
  transcriptMocks.importHistory.mockReset().mockResolvedValue({
    importedMessages: 1,
    omittedMessages: 0,
  });
});

describe("forkCodexUpstreamSession", () => {
  it("verifies the cut, imports the fork history, then links before binding", async () => {
    const retainedTurn = turn("turn-1", "one");
    boundaryMocks.listTurns
      .mockResolvedValueOnce([turn("turn-2", "edit me")])
      .mockResolvedValueOnce([retainedTurn]);
    const { archiveThread, control, forkThread } = forkControl();
    const events: string[] = [];
    linkMocks.upsert.mockImplementation(() => {
      events.push("link");
      return true;
    });
    const mutate = vi.fn(async () => {
      events.push("bind");
      return true;
    });
    const runtime = createPluginRuntimeMock();
    const createSessionEntry = vi.mocked(runtime.agent.session.createSessionEntry);

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: { mutate } as unknown as CodexAppServerBindingStore,
      control,
      harnessRuntimeId: "codex-custom",
      resolveConfig: () => ({}),
      runtime,
    });

    expect(forkThread).toHaveBeenCalledWith({
      threadId: "thread-source",
      beforeTurnId: "turn-2",
      excludeTurns: true,
    });
    expect(boundaryMocks.listTurns).toHaveBeenLastCalledWith(control, "thread-forked");
    expect(transcriptMocks.importHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:dashboard:forked",
        thread: expect.objectContaining({ id: "thread-forked", turns: [retainedTurn] }),
        throughTurnId: "turn-1",
      }),
    );
    expect(linkMocks.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        marker: { turnId: "turn-1", userMessageCount: 1 },
        sessionKey: "agent:main:dashboard:forked",
        threadId: "thread-forked",
      }),
    );
    expect(runtime.agent.session.createSessionEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        initialEntry: expect.objectContaining({ agentHarnessId: "codex-custom" }),
      }),
    );
    expect(createSessionEntry.mock.calls[0]?.[0]).not.toHaveProperty("recoverMatchingInitialEntry");
    expect(events).toEqual(["link", "bind"]);
    expect(result).toEqual({
      status: "created",
      key: "agent:main:dashboard:forked",
      editorText: "edit me",
    });
    expect(archiveThread).not.toHaveBeenCalled();
  });

  it("archives a fork whose read-back history proves beforeTurnId was ignored", async () => {
    boundaryMocks.listTurns
      .mockResolvedValueOnce([turn("turn-2", "edit me")])
      .mockResolvedValueOnce([turn("turn-1", "one"), turn("turn-2", "edit me")]);
    const { archiveThread, control } = forkControl();
    const runtime = createPluginRuntimeMock();

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: { mutate: vi.fn() } as unknown as CodexAppServerBindingStore,
      control,
      harnessRuntimeId: "codex",
      runtime,
    });

    expect(result).toMatchObject({
      status: "failed",
      code: "upstream-unavailable",
      message: expect.stringContaining("Codex version"),
    });
    expect(archiveThread).toHaveBeenCalledWith("thread-forked");
    expect(runtime.agent.session.createSessionEntry).not.toHaveBeenCalled();
    expect(linkMocks.upsert).not.toHaveBeenCalled();
  });

  it("cleans the link and archives the fork when binding materialization fails", async () => {
    boundaryMocks.listTurns
      .mockResolvedValueOnce([turn("turn-2", "edit me")])
      .mockResolvedValueOnce([turn("turn-1", "one")]);
    const { archiveThread, control } = forkControl();
    const mutate = vi.fn(async () => false);

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: { mutate } as unknown as CodexAppServerBindingStore,
      control,
      harnessRuntimeId: "codex",
      runtime: createPluginRuntimeMock(),
    });

    expect(result).toMatchObject({ status: "failed", code: "upstream-unavailable" });
    expect(linkMocks.delete).toHaveBeenCalledWith("agent:main:dashboard:forked", "main");
    expect(mutate).toHaveBeenLastCalledWith(expect.anything(), {
      kind: "clear",
      threadId: "thread-forked",
    });
    expect(archiveThread).toHaveBeenCalledWith("thread-forked");
  });

  it("archives a recoverable orphan id when the fork response is invalid", async () => {
    boundaryMocks.listTurns.mockResolvedValueOnce([turn("turn-2", "edit me")]);
    const { archiveThread, control } = forkControl(
      vi.fn(async () => ({ thread: { id: "thread-orphan" } })),
    );

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: {} as CodexAppServerBindingStore,
      control,
      harnessRuntimeId: "codex",
      runtime: createPluginRuntimeMock(),
    });

    expect(result).toMatchObject({ status: "failed", code: "upstream-unavailable" });
    expect(archiveThread).toHaveBeenCalledWith("thread-orphan");
  });

  it("rejects a fork response that reuses the source thread id", async () => {
    boundaryMocks.listTurns.mockResolvedValueOnce([turn("turn-2", "edit me")]);
    const { archiveThread, control } = forkControl(
      vi.fn(async () => forkResponse("thread-source")),
    );

    const result = await forkCodexUpstreamSession(forkParams(), {
      bindingStore: { mutate: vi.fn() } as unknown as CodexAppServerBindingStore,
      control,
      harnessRuntimeId: "codex",
      runtime: createPluginRuntimeMock(),
    });

    expect(result).toMatchObject({ status: "failed", code: "upstream-unavailable" });
    expect(archiveThread).not.toHaveBeenCalled();
  });
});
