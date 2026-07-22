// Artifact method tests cover collection from transcript messages, run/task
// session lookup, list/get/download responses, and validation errors.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { expectRecordFields } from "../test-helpers.assertions.js";
import { artifactsHandlers } from "./artifacts.js";

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
    loadSessionEntryReadOnly: hoisted.loadSessionEntry,
  };
});

vi.mock("../session-transcript-readers.js", async () => {
  const actual = await vi.importActual<typeof import("../session-transcript-readers.js")>(
    "../session-transcript-readers.js",
  );
  return {
    ...actual,
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

type ArtifactMethod = "artifacts.list" | "artifacts.get" | "artifacts.download";
type ResponderCalls = ReturnType<typeof createResponder>["calls"];
type ArtifactListPayload = { artifacts?: Array<Record<string, unknown>> };

async function invokeArtifactHandler(
  method: ArtifactMethod,
  params: Record<string, unknown>,
  options: { id?: string; context?: unknown } = {},
) {
  const responder = createResponder();
  await artifactsHandlers[method]?.({
    req: { type: "req", id: options.id ?? method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: responder.respond,
    context: (options.context ?? {}) as never,
  });
  return responder;
}

async function listArtifacts(
  params: Record<string, unknown>,
  options: { id?: string; context?: unknown } = {},
) {
  return await invokeArtifactHandler("artifacts.list", params, options);
}

async function getArtifact(
  params: Record<string, unknown>,
  options: { id?: string; context?: unknown } = {},
) {
  return await invokeArtifactHandler("artifacts.get", params, options);
}

async function downloadArtifact(
  params: Record<string, unknown>,
  options: { id?: string; context?: unknown } = {},
) {
  return await invokeArtifactHandler("artifacts.download", params, options);
}

function runtimeContext(config: Record<string, unknown>) {
  return { getRuntimeConfig: () => config };
}

function expectOkPayload(calls: ResponderCalls): unknown {
  expect(calls[0]?.ok).toBe(true);
  return calls[0]?.payload;
}

function expectArtifactList(calls: ResponderCalls): ArtifactListPayload {
  return expectOkPayload(calls) as ArtifactListPayload;
}

function expectFirstArtifact(calls: ResponderCalls): Record<string, unknown> | undefined {
  const payload = expectArtifactList(calls);
  return payload.artifacts?.[0];
}

function expectErrorDetails(calls: ResponderCalls): Record<string, unknown> | undefined {
  expect(calls[0]?.ok).toBe(false);
  const error = calls[0]?.error as { details?: Record<string, unknown> };
  return error.details;
}

function assistantImageMessage(params: {
  data?: string;
  alt: string;
  seq?: number;
  runId?: string;
  taskId?: string;
}) {
  return {
    role: "assistant",
    content: [{ type: "image", data: params.data ?? "aGVsbG8=", alt: params.alt }],
    __openclaw: {
      seq: params.seq ?? 2,
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.taskId ? { messageTaskId: params.taskId } : {}),
    },
  };
}

function assistantFileMessage(params: {
  data?: string;
  title: string;
  seq?: number;
  runId?: string;
  taskId?: string;
}) {
  return {
    role: "assistant",
    content: [
      {
        type: "file",
        data: params.data ?? "aGVsbG8=",
        mimeType: "text/plain",
        title: params.title,
      },
    ],
    __openclaw: {
      seq: params.seq ?? 2,
      ...(params.runId ? { runId: params.runId } : {}),
      ...(params.taskId ? { taskId: params.taskId } : {}),
    },
  };
}

function resultImageMessage() {
  return {
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
  };
}

function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  expectRecordFields(value, "fields", expected);
}

function expectArtifactScopeNotFound(
  calls: ResponderCalls,
  params: { message?: string } = {},
): void {
  expect(calls[0]?.ok).toBe(false);
  expect(hoisted.getTaskSessionLookupByIdForStatus).toHaveBeenCalledWith("task-1");
  expect(hoisted.loadSessionEntry).not.toHaveBeenCalled();
  expect(hoisted.resolveSessionKeyForRun).not.toHaveBeenCalled();
  if (params.message) {
    expectFields(calls[0]?.error, { message: params.message });
  }
  expectFields(expectErrorDetails(calls), { type: "artifact_scope_not_found" });
}

describe("artifacts RPC handlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.resolveSessionKeyForRun.mockReset();
    hoisted.getTaskSessionLookupByIdForStatus.mockReturnValue(undefined);
    hoisted.loadSessionEntry.mockReturnValue({
      storePath: "/tmp/sessions.json",
      entry: { sessionId: "sess-main", sessionFile: "/tmp/sess-main.jsonl" },
    });
    mockedMessages([resultImageMessage()]);
  });

  function mockedMessages(messages: unknown[]) {
    hoisted.visitSessionMessagesAsync.mockImplementation(async (_scope, visit) => {
      messages.forEach((message, index) => visit(message, index + 1));
      return messages.length;
    });
  }

  it("lists stable transcript artifact summaries by sessionKey", async () => {
    const { calls } = await listArtifacts({ sessionKey: "agent:main:main" }, { id: "1" });

    expect(calls).toHaveLength(1);
    const payload = expectArtifactList(calls);
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
    expect(hoisted.visitSessionMessagesAsync).toHaveBeenCalledWith(
      {
        agentId: "main",
        sessionEntry: {
          sessionFile: "/tmp/sess-main.jsonl",
          sessionId: "sess-main",
        },
        sessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath: "/tmp/sessions.json",
      },
      expect.any(Function),
      expect.objectContaining({ cache: "skip" }),
    );
  });

  it("applies agentId to direct sessionKey aliases", async () => {
    const { calls } = await listArtifacts(
      { sessionKey: "main", agentId: "work" },
      { id: "session-alias-agent-scope" },
    );

    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("agent:work:main");
    expectFields(expectFirstArtifact(calls), { sessionKey: "agent:work:main" });
  });

  it("canonicalizes scoped sessionKey aliases with runtime config", async () => {
    const { calls } = await listArtifacts(
      { sessionKey: "main", agentId: "work" },
      {
        id: "session-alias-main-key",
        context: runtimeContext({
          session: { mainKey: "primary" },
          agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        }),
      },
    );

    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("agent:work:primary");
    expectFields(expectFirstArtifact(calls), { sessionKey: "agent:work:primary" });
  });

  it("preserves agent scope when loading global-scope run artifacts", async () => {
    hoisted.resolveSessionKeyForRun.mockReturnValue("global");
    mockedMessages([assistantFileMessage({ title: "out.txt", runId: "run-global" })]);

    const { calls } = await listArtifacts(
      { runId: "run-global", agentId: "work" },
      {
        id: "global-run-agent-scope",
        context: runtimeContext({
          session: { scope: "global" },
          agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        }),
      },
    );

    expect(hoisted.resolveSessionKeyForRun).toHaveBeenCalledWith("run-global", {
      agentId: "work",
    });
    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("global", { agentId: "work" });
    expectFields(expectFirstArtifact(calls), { sessionKey: "global", runId: "run-global" });
  });

  it("preserves inferred task agent scope when loading global-scope task artifacts", async () => {
    hoisted.getTaskSessionLookupByIdForStatus.mockReturnValue({
      agentId: "work",
      requesterSessionKey: "global",
      ownerKey: "global",
    });
    mockedMessages([assistantFileMessage({ title: "task.txt", taskId: "task-global" })]);

    const { calls } = await listArtifacts(
      { taskId: "task-global" },
      {
        id: "global-task-agent-scope",
        context: runtimeContext({
          session: { scope: "global" },
          agents: { list: [{ id: "main", default: true }, { id: "work" }] },
        }),
      },
    );

    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("global", { agentId: "work" });
    expectFields(expectFirstArtifact(calls), { sessionKey: "global", taskId: "task-global" });
  });

  it("gets and downloads an inline artifact", async () => {
    const listed = await listArtifacts({ sessionKey: "agent:main:main" }, { id: "list-inline" });
    const listedPayload = expectArtifactList(listed.calls);
    const artifactId = listedPayload.artifacts?.[0]?.id;
    const artifactIdString = requireNonEmptyString(artifactId, "expected listed artifact id");

    const get = await getArtifact(
      { sessionKey: "agent:main:main", artifactId: artifactIdString },
      { id: "2" },
    );
    const getPayload = expectOkPayload(get.calls) as { artifact?: Record<string, unknown> };
    expectFields(getPayload.artifact, { id: artifactId });
    expectFields(getPayload.artifact?.download, { mode: "bytes" });

    const download = await downloadArtifact(
      { sessionKey: "agent:main:main", artifactId },
      { id: "3" },
    );
    const downloadPayload = expectOkPayload(download.calls) as {
      artifact?: Record<string, unknown>;
    };
    expectFields(downloadPayload, {
      encoding: "base64",
      data: "aGVsbG8=",
    });
    expectFields(downloadPayload.artifact, { id: artifactId });
  });

  it("can scan artifact summaries without retaining inline data", async () => {
    mockedMessages([
      {
        role: "assistant",
        content: [
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

    const { calls } = await listArtifacts({ sessionKey: "agent:main:main" });
    const artifacts = expectArtifactList(calls).artifacts;
    expect(artifacts).toHaveLength(1);
    expectFields(artifacts?.[0], {
      title: "result.png",
      mimeType: "image/png",
      sizeBytes: 5,
    });
    expectFields(artifacts?.[0]?.download, { mode: "bytes" });
    expect(artifacts?.[0]).not.toHaveProperty("data");
  });

  it("hydrates inline data only for the requested download artifact", async () => {
    const messages = [
      {
        role: "assistant",
        content: [
          {
            type: "image",
            data: "Zmlyc3Q=",
            mimeType: "image/png",
            alt: "first.png",
          },
          {
            type: "image",
            data: "c2Vjb25k",
            mimeType: "image/png",
            alt: "second.png",
          },
        ],
        __openclaw: { seq: 2 },
      },
    ];
    mockedMessages(messages);

    const summaries = await listArtifacts({ sessionKey: "agent:main:main" });
    const summaryArtifacts = expectArtifactList(summaries.calls).artifacts;
    const secondArtifactId = requireNonEmptyString(
      summaryArtifacts?.[1]?.id,
      "expected second artifact id",
    );
    expect(summaryArtifacts?.[0]).not.toHaveProperty("data");
    expect(summaryArtifacts?.[1]).not.toHaveProperty("data");

    const download = await downloadArtifact({
      sessionKey: "agent:main:main",
      artifactId: secondArtifactId,
    });
    const downloadPayload = expectOkPayload(download.calls) as {
      artifact?: Record<string, unknown>;
      data?: string;
    };

    expectFields(downloadPayload.artifact, { title: "second.png" });
    expectFields(downloadPayload, { data: "c2Vjb25k" });
  });

  it("resolves runId queries through the gateway run-to-session lookup", async () => {
    hoisted.resolveSessionKeyForRun.mockReturnValue("agent:main:main");
    mockedMessages([assistantImageMessage({ alt: "run-result.png", runId: "run-1" })]);
    const { calls } = await listArtifacts({ runId: "run-1" }, { id: "4" });

    expect(hoisted.resolveSessionKeyForRun).toHaveBeenCalledWith("run-1", {
      agentId: "main",
    });
    expectFields(expectFirstArtifact(calls), { runId: "run-1" });
  });

  it("passes agentId to runId artifact queries", async () => {
    hoisted.resolveSessionKeyForRun.mockReturnValue("main");
    mockedMessages([assistantImageMessage({ alt: "run-result.png", runId: "run-1" })]);

    await listArtifacts({ runId: "run-1", agentId: "work" }, { id: "agent-run-scope" });

    expect(hoisted.resolveSessionKeyForRun).toHaveBeenCalledWith("run-1", {
      agentId: "work",
    });
    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("agent:work:main");
  });

  it("preserves task agent scope when taskId resolves through runId", async () => {
    hoisted.getTaskSessionLookupByIdForStatus.mockReturnValue({
      runId: "run-for-task-1",
      agentId: "work",
    });
    hoisted.resolveSessionKeyForRun.mockReturnValue("acp:run-for-task-1");
    mockedMessages([
      assistantImageMessage({ alt: "task-result.png", data: "dGFyZ2V0", taskId: "task-1" }),
    ]);
    const { calls } = await listArtifacts({ taskId: "task-1" }, { id: "task-run-agent-scope" });

    expect(calls[0]?.ok).toBe(true);
    expect(hoisted.resolveSessionKeyForRun).toHaveBeenCalledWith("run-for-task-1", {
      agentId: "work",
    });
    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("agent:work:acp:run-for-task-1");
  });

  it("resolves taskId queries through task status access and filters artifacts by messageTaskId", async () => {
    hoisted.getTaskSessionLookupByIdForStatus.mockReturnValue({
      requesterSessionKey: "agent:main:main",
      runId: "run-for-task-1",
      agentId: "main",
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

    const get = await getArtifact(
      { taskId: "task-1", artifactId: artifactIdString },
      { id: "task-get" },
    );
    const getPayload = expectOkPayload(get.calls) as { artifact?: Record<string, unknown> };
    expectFields(getPayload.artifact, {
      id: artifactId,
      taskId: "task-1",
      title: "task-result.png",
    });

    const download = await downloadArtifact(
      { taskId: "task-1", artifactId },
      { id: "task-download" },
    );
    const downloadPayload = expectOkPayload(download.calls) as {
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

  it("does not resolve taskId artifact queries when agentId does not match the task", async () => {
    hoisted.getTaskSessionLookupByIdForStatus.mockReturnValue({
      requesterSessionKey: "agent:work:main",
      runId: "run-for-task-1",
      agentId: "work",
    });
    const { calls } = await listArtifacts(
      { taskId: "task-1", agentId: "main" },
      { id: "task-agent-mismatch" },
    );

    expectArtifactScopeNotFound(calls, {
      message: "no session found for artifact query",
    });
  });

  it("keeps cross-agent task artifacts scoped to the requester transcript", async () => {
    hoisted.getTaskSessionLookupByIdForStatus.mockReturnValue({
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      runId: "run-for-task-1",
      agentId: "worker",
      requesterAgentId: "main",
    });
    mockedMessages([
      assistantImageMessage({ alt: "task-result.png", data: "dGFyZ2V0", taskId: "task-1" }),
    ]);

    const { calls } = await listArtifacts(
      { taskId: "task-1", agentId: "worker" },
      { id: "task-cross-agent-requester-session" },
    );

    expect(hoisted.resolveSessionKeyForRun).not.toHaveBeenCalled();
    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("agent:main:main");
    expectFields(expectFirstArtifact(calls), {
      taskId: "task-1",
      sessionKey: "agent:main:main",
    });
  });

  it("uses the requester agent store for cross-agent global task artifacts", async () => {
    hoisted.getTaskSessionLookupByIdForStatus.mockReturnValue({
      requesterSessionKey: "global",
      ownerKey: "global",
      runId: "run-for-task-1",
      agentId: "worker",
      requesterAgentId: "main",
    });
    mockedMessages([
      assistantImageMessage({ alt: "task-result.png", data: "dGFyZ2V0", taskId: "task-1" }),
    ]);

    const { calls } = await listArtifacts(
      { taskId: "task-1", agentId: "worker" },
      {
        id: "task-cross-agent-global-requester",
        context: runtimeContext({
          session: { scope: "global" },
          agents: { list: [{ id: "main", default: true }, { id: "worker" }] },
        }),
      },
    );

    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("global", { agentId: "main" });
    expectFields(expectFirstArtifact(calls), {
      taskId: "task-1",
      sessionKey: "global",
    });
  });

  it("derives taskId artifact scope from requesterSessionKey when task agentId is absent", async () => {
    hoisted.getTaskSessionLookupByIdForStatus.mockReturnValue({
      requesterSessionKey: "agent:work:main",
      runId: "run-for-task-1",
    });
    const { calls } = await listArtifacts(
      { taskId: "task-1", agentId: "main" },
      { id: "task-requester-agent-mismatch" },
    );

    expectArtifactScopeNotFound(calls);
  });

  it("treats legacy task requester session keys as the main agent for artifact scope", async () => {
    hoisted.getTaskSessionLookupByIdForStatus.mockReturnValue({
      requesterSessionKey: "main",
      runId: "run-for-task-1",
    });
    const { calls } = await listArtifacts(
      { taskId: "task-1", agentId: "work" },
      { id: "task-legacy-requester-agent-mismatch" },
    );

    expectArtifactScopeNotFound(calls);
  });

  it("uses the configured default agent for legacy task requester session keys", async () => {
    hoisted.getTaskSessionLookupByIdForStatus.mockReturnValue({
      requesterSessionKey: "main",
      runId: "run-for-task-1",
    });
    mockedMessages([
      assistantImageMessage({ alt: "task-result.png", data: "dGFyZ2V0", taskId: "task-1" }),
    ]);

    const { calls } = await listArtifacts(
      { taskId: "task-1", agentId: "work" },
      {
        id: "task-legacy-default-agent",
        context: runtimeContext({
          agents: { list: [{ id: "work", default: true }] },
        }),
      },
    );

    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("agent:work:main");
    expectFields(expectFirstArtifact(calls), {
      taskId: "task-1",
      sessionKey: "agent:work:main",
    });
  });

  it("does not return untagged session artifacts for scoped runId queries", async () => {
    hoisted.resolveSessionKeyForRun.mockReturnValue("agent:main:main");
    const { calls } = await listArtifacts({ runId: "run-1" }, { id: "run-scope" });

    expect(expectArtifactList(calls)).toEqual({ artifacts: [] });
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
    const { calls } = await listArtifacts({ sessionKey: "agent:main:main" }, { id: "image-url" });

    const payload = expectArtifactList(calls);
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

  it("treats transcript non-base64 data URLs as unsupported downloads", async () => {
    mockedMessages([
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
    ]);

    const { calls } = await listArtifacts({ sessionKey: "agent:main:main" });
    const artifacts = expectArtifactList(calls).artifacts;
    expect(artifacts).toHaveLength(1);
    expectFields(artifacts?.[0], {
      type: "image",
      title: "uploaded.txt",
    });
    expectFields(artifacts?.[0]?.download, { mode: "unsupported" });
    expect(artifacts?.[0]?.download).not.toHaveProperty("encoding", "base64");
  });

  it("treats non-base64 data URLs in the content field as unsupported downloads", async () => {
    mockedMessages([
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
    ]);

    const { calls } = await listArtifacts({ sessionKey: "agent:main:main" });
    const artifacts = expectArtifactList(calls).artifacts;
    expect(artifacts).toHaveLength(1);
    expectFields(artifacts?.[0], {
      title: "plain.txt",
    });
    expectFields(artifacts?.[0]?.download, { mode: "unsupported" });
    expect(artifacts?.[0]).not.toHaveProperty("data");
  });

  it("treats malformed direct artifact data as unsupported downloads", async () => {
    mockedMessages([
      {
        role: "assistant",
        content: [
          {
            type: "file",
            data: "not-base64!",
            title: "bad.txt",
          },
        ],
        __openclaw: { seq: 6 },
      },
    ]);

    const { calls } = await listArtifacts({ sessionKey: "agent:main:main" });
    const artifacts = expectArtifactList(calls).artifacts;
    expect(artifacts).toHaveLength(1);
    expectFields(artifacts?.[0], {
      title: "bad.txt",
    });
    expectFields(artifacts?.[0]?.download, { mode: "unsupported" });
    expect(artifacts?.[0]).not.toHaveProperty("data");
  });

  it("keeps unpadded direct artifact base64 downloadable", async () => {
    mockedMessages([
      {
        role: "assistant",
        content: [
          {
            type: "file",
            data: "JVBERi0",
            title: "report.pdf",
          },
        ],
        __openclaw: { seq: 7 },
      },
    ]);

    const listed = await listArtifacts({ sessionKey: "agent:main:main" });
    const artifact = expectArtifactList(listed.calls).artifacts?.[0];
    const artifactId = requireNonEmptyString(artifact?.id, "expected listed artifact id");
    expectFields(artifact, {
      title: "report.pdf",
      sizeBytes: 5,
    });
    expectFields(artifact?.download, { mode: "bytes" });

    const download = await downloadArtifact({
      sessionKey: "agent:main:main",
      artifactId,
    });
    const downloadPayload = expectOkPayload(download.calls) as Record<string, unknown>;
    expectFields(downloadPayload, {
      encoding: "base64",
      data: "JVBERi0=",
    });
  });

  it("treats malformed base64 data URLs as unsupported downloads", async () => {
    mockedMessages([
      {
        role: "assistant",
        content: [
          {
            type: "image",
            image_url: "data:image/png;base64,not-base64!",
            alt: "bad.png",
          },
        ],
        __openclaw: { seq: 7 },
      },
    ]);

    const { calls } = await listArtifacts({ sessionKey: "agent:main:main" });
    const artifacts = expectArtifactList(calls).artifacts;
    expect(artifacts).toHaveLength(1);
    expectFields(artifacts?.[0], {
      title: "bad.png",
    });
    expectFields(artifacts?.[0]?.download, { mode: "unsupported" });
    expect(artifacts?.[0]).not.toHaveProperty("data");
  });

  it("keeps unpadded base64 data URLs downloadable", async () => {
    mockedMessages([
      {
        role: "assistant",
        content: [
          {
            type: "image",
            image_url: "data:image/gif;base64,R0lGOD",
            alt: "tiny.gif",
          },
        ],
        __openclaw: { seq: 8 },
      },
    ]);

    const listed = await listArtifacts({ sessionKey: "agent:main:main" });
    const artifact = expectArtifactList(listed.calls).artifacts?.[0];
    const artifactId = requireNonEmptyString(artifact?.id, "expected listed artifact id");
    expectFields(artifact, {
      title: "tiny.gif",
      mimeType: "image/gif",
      sizeBytes: 4,
    });
    expectFields(artifact?.download, { mode: "bytes" });

    const download = await downloadArtifact({
      sessionKey: "agent:main:main",
      artifactId,
    });
    const downloadPayload = expectOkPayload(download.calls) as Record<string, unknown>;
    expectFields(downloadPayload, {
      encoding: "base64",
      data: "R0lGOD==",
    });
  });

  it("treats unsafe artifact URLs as unsupported downloads", async () => {
    mockedMessages([
      {
        role: "assistant",
        content: [{ type: "file", title: "secret.txt", url: "file:///etc/passwd" }],
        __openclaw: { seq: 4 },
      },
    ]);

    const { calls } = await listArtifacts({ sessionKey: "agent:main:main" });
    const artifacts = expectArtifactList(calls).artifacts;
    expectFields(artifacts?.[0], {
      title: "secret.txt",
    });
    expectFields(artifacts?.[0]?.download, { mode: "unsupported" });
    expect(artifacts?.[0]).not.toHaveProperty("url");
  });

  it("returns typed errors for missing query scope and missing artifacts", async () => {
    const missingScope = await listArtifacts({}, { id: "5" });
    expectFields(expectErrorDetails(missingScope.calls), { type: "artifact_query_unsupported" });

    const notFound = await getArtifact(
      { sessionKey: "agent:main:main", artifactId: "artifact_missing" },
      { id: "6" },
    );
    expectFields(expectErrorDetails(notFound.calls), {
      type: "artifact_not_found",
      artifactId: "artifact_missing",
    });
  });
});
