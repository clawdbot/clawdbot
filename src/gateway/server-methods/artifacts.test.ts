import { beforeEach, describe, expect, it, vi } from "vitest";
import { artifactsHandlers, collectArtifactsFromMessages } from "./artifacts.js";

const hoisted = vi.hoisted(() => ({
  getTaskSessionLookupByIdForStatus: vi.fn(),
  loadSessionEntry: vi.fn(),
  visitSessionMessagesAsync: vi.fn(),
  resolveSessionKeyForRun: vi.fn(),
}));

vi.mock("../../tasks/task-status-access.js", () => ({
  getTaskSessionLookupByIdForStatus: hoisted.getTaskSessionLookupByIdForStatus,
}));

vi.mock("../session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../session-utils.js")>("../session-utils.js");
  return {
    ...actual,
    loadSessionEntry: hoisted.loadSessionEntry,
    visitSessionMessagesAsync: hoisted.visitSessionMessagesAsync,
  };
});

vi.mock("../server-session-key.js", async () => {
  const actual = await vi.importActual<typeof import("../server-session-key.js")>(
    "../server-session-key.js",
  );
  return {
    ...actual,
    resolveSessionKeyForRun: hoisted.resolveSessionKeyForRun,
  };
});

function createResponder() {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  return {
    calls,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      calls.push({ ok, payload, error });
    },
  };
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

describe("artifacts RPC handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getTaskSessionLookupByIdForStatus.mockReturnValue(undefined);
    hoisted.loadSessionEntry.mockReturnValue({
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-main", sessionFile: "/tmp/sess-main.jsonl" },
    });
    mockedMessages([
      {
        role: "assistant",
        content: [
          { type: "text", text: "see attached" },
          {
            type: "image",
            data: "aGVsbG8=",
            mimeType: "image/png",
            alt: "result.png",
          },
        ],
        __openclaw: { seq: 2 },
      },
    ]);
  });

  function mockedMessages(messages: unknown[]) {
    hoisted.visitSessionMessagesAsync.mockImplementation(
      async (_sessionId, _storePath, _sessionFile, visit) => {
        messages.forEach((message, index) => visit(message, index + 1));
        return messages.length;
      },
    );
  }

  it("lists stable transcript artifact summaries by sessionKey", async () => {
    const { calls, respond } = createResponder();

    await artifactsHandlers["artifacts.list"]?.({
      req: { type: "req", id: "1", method: "artifacts.list", params: {} },
      params: { sessionKey: "agent:main:main" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.ok).toBe(true);
    const payload = calls[0]?.payload as { artifacts?: Array<Record<string, unknown>> };
    expect(payload.artifacts).toHaveLength(1);
    const artifact = payload.artifacts?.[0];
    expectFields(artifact, {
      type: "image",
      title: "result.png",
      mimeType: "image/png",
      sizeBytes: 5,
      sessionKey: "agent:main:main",
      messageSeq: 2,
      source: "session-transcript",
    });
    expectFields(artifact?.download, { mode: "bytes" });
    expect(artifact?.id).toMatch(/^artifact_/);
    expect(artifact).not.toHaveProperty("data");
  });

  it("gets and downloads an inline artifact", async () => {
    const listed = collectArtifactsFromMessages({
      sessionKey: "agent:main:main",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "see attached" },
            {
              type: "image",
              data: "aGVsbG8=",
              mimeType: "image/png",
              alt: "result.png",
            },
          ],
          __openclaw: { seq: 2 },
        },
      ],
    });
    const artifactId = listed[0]?.id;
    const artifactIdString = requireNonEmptyString(artifactId, "expected listed artifact id");

    const get = createResponder();
    await artifactsHandlers["artifacts.get"]?.({
      req: { type: "req", id: "2", method: "artifacts.get", params: {} },
      params: { sessionKey: "agent:main:main", artifactId: artifactIdString },
      client: null,
      isWebchatConnect: () => false,
      respond: get.respond,
      context: {} as never,
    });
    expect(get.calls[0]?.ok).toBe(true);
    const getPayload = get.calls[0]?.payload as { artifact?: Record<string, unknown> };
    expectFields(getPayload.artifact, { id: artifactId });
    expectFields(getPayload.artifact?.download, { mode: "bytes" });

    const download = createResponder();
    await artifactsHandlers["artifacts.download"]?.({
      req: { type: "req", id: "3", method: "artifacts.download", params: {} },
      params: { sessionKey: "agent:main:main", artifactId },
      client: null,
      isWebchatConnect: () => false,
      respond: download.respond,
      context: {} as never,
    });
    expect(download.calls[0]?.ok).toBe(true);
    const downloadPayload = download.calls[0]?.payload as {
      artifact?: Record<string, unknown>;
    };
    expectFields(downloadPayload, {
      encoding: "base64",
      data: "aGVsbG8=",
    });
    expectFields(downloadPayload.artifact, { id: artifactId });
  });

  it("resolves runId queries through the gateway run-to-session lookup", async () => {
    hoisted.resolveSessionKeyForRun.mockReturnValue("agent:main:main");
    mockedMessages([
      {
        role: "assistant",
        content: [{ type: "image", data: "aGVsbG8=", alt: "run-result.png" }],
        __openclaw: { seq: 2, runId: "run-1" },
      },
    ]);
    const { calls, respond } = createResponder();

    await artifactsHandlers["artifacts.list"]?.({
      req: { type: "req", id: "4", method: "artifacts.list", params: {} },
      params: { runId: "run-1" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(calls[0]?.ok).toBe(true);
    expect(hoisted.resolveSessionKeyForRun).toHaveBeenCalledWith("run-1");
    const payload = calls[0]?.payload as { artifacts?: Array<Record<string, unknown>> };
    expectFields(payload.artifacts?.[0], { runId: "run-1" });
  });

  it("resolves taskId queries through task status access and filters artifacts by messageTaskId", async () => {
    hoisted.getTaskSessionLookupByIdForStatus.mockReturnValue({
      requesterSessionKey: "agent:main:main",
      runId: "run-for-task-1",
    });
    mockedMessages([
      {
        role: "assistant",
        content: [{ type: "image", data: "dGFyZ2V0", alt: "task-result.png" }],
        __openclaw: { seq: 2, messageTaskId: "task-1" },
      },
      {
        role: "assistant",
        content: [{ type: "image", data: "b3RoZXI=", alt: "other-task.png" }],
        __openclaw: { seq: 3, messageTaskId: "task-2" },
      },
      {
        role: "assistant",
        content: [{ type: "image", data: "dW50YWdnZWQ=", alt: "untagged.png" }],
        __openclaw: { seq: 4 },
      },
    ]);

    const list = createResponder();
    await artifactsHandlers["artifacts.list"]?.({
      req: { type: "req", id: "task-list", method: "artifacts.list", params: {} },
      params: { taskId: "task-1" },
      client: null,
      isWebchatConnect: () => false,
      respond: list.respond,
      context: {} as never,
    });

    expect(list.calls[0]?.ok).toBe(true);
    expect(hoisted.getTaskSessionLookupByIdForStatus).toHaveBeenCalledWith("task-1");
    expect(hoisted.resolveSessionKeyForRun).not.toHaveBeenCalled();
    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("agent:main:main");
    const listPayload = list.calls[0]?.payload as { artifacts?: Array<Record<string, unknown>> };
    expect(listPayload.artifacts).toHaveLength(1);
    expectFields(listPayload.artifacts?.[0], {
      taskId: "task-1",
      title: "task-result.png",
    });

    const artifactId = listPayload.artifacts?.[0]?.id as string | undefined;
    const artifactIdString = requireNonEmptyString(artifactId, "expected task artifact id");

    const get = createResponder();
    await artifactsHandlers["artifacts.get"]?.({
      req: { type: "req", id: "task-get", method: "artifacts.get", params: {} },
      params: { taskId: "task-1", artifactId: artifactIdString },
      client: null,
      isWebchatConnect: () => false,
      respond: get.respond,
      context: {} as never,
    });
    expect(get.calls[0]?.ok).toBe(true);
    const getPayload = get.calls[0]?.payload as { artifact?: Record<string, unknown> };
    expectFields(getPayload.artifact, {
      id: artifactId,
      taskId: "task-1",
      title: "task-result.png",
    });

    const download = createResponder();
    await artifactsHandlers["artifacts.download"]?.({
      req: { type: "req", id: "task-download", method: "artifacts.download", params: {} },
      params: { taskId: "task-1", artifactId },
      client: null,
      isWebchatConnect: () => false,
      respond: download.respond,
      context: {} as never,
    });
    expect(download.calls[0]?.ok).toBe(true);
    const downloadPayload = download.calls[0]?.payload as {
      artifact?: Record<string, unknown>;
    };
    expectFields(downloadPayload, {
      encoding: "base64",
      data: "dGFyZ2V0",
    });
    expectFields(downloadPayload.artifact, {
      id: artifactId,
      taskId: "task-1",
      title: "task-result.png",
    });
  });

  it("does not return untagged session artifacts for scoped runId queries", async () => {
    hoisted.resolveSessionKeyForRun.mockReturnValue("agent:main:main");
    const { calls, respond } = createResponder();

    await artifactsHandlers["artifacts.list"]?.({
      req: { type: "req", id: "run-scope", method: "artifacts.list", params: {} },
      params: { runId: "run-1" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(calls[0]?.ok).toBe(true);
    expect(calls[0]?.payload).toEqual({ artifacts: [] });
  });

  it("discovers transcript image_url data blocks", async () => {
    mockedMessages([
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "data:image/png;base64,aGVsbG8=",
            alt: "uploaded.png",
          },
        ],
        __openclaw: { seq: 3 },
      },
    ]);
    const { calls, respond } = createResponder();

    await artifactsHandlers["artifacts.list"]?.({
      req: { type: "req", id: "image-url", method: "artifacts.list", params: {} },
      params: { sessionKey: "agent:main:main" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(calls[0]?.ok).toBe(true);
    const payload = calls[0]?.payload as { artifacts?: Array<Record<string, unknown>> };
    expect(payload.artifacts).toHaveLength(1);
    const artifact = payload.artifacts?.[0];
    expectFields(artifact, {
      type: "image",
      title: "uploaded.png",
      mimeType: "image/png",
      sizeBytes: 5,
    });
    expectFields(artifact?.download, { mode: "bytes" });
  });

  it("treats transcript non-base64 data URLs as unsupported downloads", () => {
    const artifacts = collectArtifactsFromMessages({
      sessionKey: "agent:main:main",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: "data:text/plain,hello",
              alt: "uploaded.txt",
            },
          ],
          __openclaw: { seq: 4 },
        },
      ],
    });

    expect(artifacts).toHaveLength(1);
    expectFields(artifacts[0], {
      type: "image",
      title: "uploaded.txt",
    });
    expectFields(artifacts[0]?.download, { mode: "unsupported" });
    expect(artifacts[0]?.download).not.toHaveProperty("encoding", "base64");
  });

  it("treats non-base64 data URLs in the content field as unsupported downloads", () => {
    const artifacts = collectArtifactsFromMessages({
      sessionKey: "agent:main:main",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "file",
              content: "data:text/plain,hello",
              title: "plain.txt",
            },
          ],
          __openclaw: { seq: 5 },
        },
      ],
    });

    expect(artifacts).toHaveLength(1);
    expectFields(artifacts[0], {
      title: "plain.txt",
    });
    expectFields(artifacts[0]?.download, { mode: "unsupported" });
    expect(artifacts[0]).not.toHaveProperty("data");
  });

  it("treats unsafe artifact URLs as unsupported downloads", () => {
    const artifacts = collectArtifactsFromMessages({
      sessionKey: "agent:main:main",
      messages: [
        {
          role: "assistant",
          content: [{ type: "file", title: "secret.txt", url: "file:///etc/passwd" }],
          __openclaw: { seq: 4 },
        },
      ],
    });

    expectFields(artifacts[0], {
      title: "secret.txt",
    });
    expectFields(artifacts[0]?.download, { mode: "unsupported" });
    expect(artifacts[0]).not.toHaveProperty("url");
  });

  it("returns typed errors for missing query scope and missing artifacts", async () => {
    const missingScope = createResponder();
    await artifactsHandlers["artifacts.list"]?.({
      req: { type: "req", id: "5", method: "artifacts.list", params: {} },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond: missingScope.respond,
      context: {} as never,
    });
    expect(missingScope.calls[0]?.ok).toBe(false);
    const missingScopeError = missingScope.calls[0]?.error as {
      details?: Record<string, unknown>;
    };
    expectFields(missingScopeError.details, { type: "artifact_query_unsupported" });

    const notFound = createResponder();
    await artifactsHandlers["artifacts.get"]?.({
      req: { type: "req", id: "6", method: "artifacts.get", params: {} },
      params: { sessionKey: "agent:main:main", artifactId: "artifact_missing" },
      client: null,
      isWebchatConnect: () => false,
      respond: notFound.respond,
      context: {} as never,
    });
    expect(notFound.calls[0]?.ok).toBe(false);
    const notFoundError = notFound.calls[0]?.error as { details?: Record<string, unknown> };
    expectFields(notFoundError.details, {
      type: "artifact_not_found",
      artifactId: "artifact_missing",
    });
  });
});
