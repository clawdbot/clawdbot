// Artifact method tests cover collection from transcript messages, run/task
// session lookup, list/get/download responses, and validation errors.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { artifactsHandlers } from "./artifacts.js";
import {
  assistantFileMessage,
  assistantImageMessage,
  expectArtifactList,
  expectErrorDetails,
  expectFields,
  expectFirstArtifact,
  expectOkPayload,
  requireNonEmptyString,
  resultImageMessage,
  runtimeContext,
} from "./artifacts.test-support.js";

const hoisted = vi.hoisted(() => ({
  getTaskSessionLookupByIdForStatus: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveManagedArtifactDownload: vi.fn(),
  resolveManagedUrlDownload: vi.fn(),
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
    loadGatewaySessionEntryReadOnly: hoisted.loadSessionEntry,
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

vi.mock("../managed-image-attachments.js", async () => {
  const actual = await vi.importActual<typeof import("../managed-image-attachments.js")>(
    "../managed-image-attachments.js",
  );
  return {
    ...actual,
    resolveManagedOutgoingMediaArtifactDownload: hoisted.resolveManagedArtifactDownload,
    resolveManagedOutgoingMediaUrlDownload: hoisted.resolveManagedUrlDownload,
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
type ArtifactResponderCalls = ReturnType<typeof createResponder>["calls"];

async function invokeArtifactHandler(
  method: ArtifactMethod,
  params: Record<string, unknown>,
  options: { id?: string; context?: unknown } = {},
) {
  const responder = createResponder();
  const defaultContext = {
    getRuntimeConfig: () => ({ agents: { entries: { main: { default: true } } } }),
  };
  await artifactsHandlers[method]?.({
    req: { type: "req", id: options.id ?? method, method, params: {} },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: responder.respond,
    context: (options.context ?? defaultContext) as never,
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

function expectArtifactScopeNotFound(
  calls: ArtifactResponderCalls,
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
    hoisted.resolveManagedArtifactDownload.mockResolvedValue(null);
    hoisted.resolveManagedUrlDownload.mockResolvedValue(null);
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
    );
  });

  it("applies agentId to direct sessionKey aliases", async () => {
    const { calls } = await listArtifacts(
      { sessionKey: "main", agentId: "work" },
      {
        id: "session-alias-agent-scope",
        context: runtimeContext({ agents: { list: [{ id: "main" }, { id: "work" }] } }),
      },
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

  it("loads a bare artifact session through the persisted fixed-store owner", async () => {
    const { calls } = await listArtifacts(
      { sessionKey: "global" },
      {
        id: "session-persisted-owner",
        context: runtimeContext({
          session: { store: "/tmp/shared-sessions.sqlite", scope: "global" },
          agents: {
            ownership: "explicit",
            list: [{ id: "ops" }, { id: "research" }],
            defaults: { sessionStore: { agentId: "ops" } },
          },
        }),
      },
    );

    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("global", { agentId: "ops" });
    expectFields(expectFirstArtifact(calls), { sessionKey: "global" });
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

  it("uses the run row owner before default selection", async () => {
    hoisted.resolveSessionKeyForRun.mockReturnValue("agent:research:main");
    mockedMessages([assistantFileMessage({ title: "out.txt", runId: "run-owned" })]);

    const { calls } = await listArtifacts(
      { runId: "run-owned" },
      {
        context: runtimeContext({
          agents: {
            ownership: "explicit",
            list: [{ id: "ops" }, { id: "research" }],
          },
        }),
      },
    );

    expect(hoisted.resolveSessionKeyForRun).toHaveBeenCalledWith("run-owned", {});
    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("agent:research:main");
    expect(calls[0]?.ok).toBe(true);
  });

  it("translates run lookup selection-required into INVALID_REQUEST", async () => {
    hoisted.resolveSessionKeyForRun.mockImplementation(() => {
      throw new AgentSelectionRequiredError(["ops", "research"], {
        surface: "artifact run",
        hint: "Pass agentId to select a configured agent.",
      });
    });

    const { calls } = await listArtifacts(
      { runId: "run-ambiguous" },
      {
        context: runtimeContext({
          agents: {
            ownership: "explicit",
            list: [{ id: "ops" }, { id: "research" }],
          },
        }),
      },
    );

    expect(calls[0]).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("agent") },
    });
  });

  it("uses the compatibility owner instead of the executor for a global task requester", async () => {
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

    expect(hoisted.loadSessionEntry).toHaveBeenCalledWith("global", { agentId: "main" });
    expectFields(expectFirstArtifact(calls), { sessionKey: "global", taskId: "task-global" });
  });

  it("returns typed selection-required instead of adopting the task executor", async () => {
    hoisted.getTaskSessionLookupByIdForStatus.mockReturnValue({
      agentId: "work",
      requesterSessionKey: "global",
      ownerKey: "global",
    });
    const { calls } = await listArtifacts(
      { taskId: "task-global" },
      {
        context: runtimeContext({
          session: { scope: "global" },
          agents: {
            ownership: "explicit",
            list: [{ id: "ops" }, { id: "work" }],
          },
        }),
      },
    );

    expect(calls[0]).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("agent") },
    });
    expect(hoisted.loadSessionEntry).not.toHaveBeenCalled();
  });

  it("translates a keyless task selection failure into INVALID_REQUEST", async () => {
    hoisted.getTaskSessionLookupByIdForStatus.mockReturnValue({ runId: "run-keyless" });

    const { calls } = await listArtifacts(
      { taskId: "task-keyless" },
      {
        context: runtimeContext({
          agents: {
            ownership: "explicit",
            list: [{ id: "ops" }, { id: "research" }],
          },
        }),
      },
    );

    expect(calls[0]).toMatchObject({
      ok: false,
      error: { code: "INVALID_REQUEST", message: expect.stringContaining("agent") },
    });
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

  it.each([
    { type: "file", data: "", sizeBytes: 0, title: "direct.bin" },
    {
      type: "file",
      source: { data: "", media_type: "application/octet-stream", sizeBytes: 0 },
      title: "source.bin",
    },
    {
      type: "file",
      data: " data:application/octet-stream;base64, ",
      sizeBytes: 0,
      title: "data-url.bin",
    },
    { data: "", sizeBytes: 0, title: "untyped.bin" },
  ])("lists, gets, and downloads the zero-byte $title artifact", async (block) => {
    mockedMessages([{ role: "assistant", content: [block], __openclaw: { seq: 2 } }]);
    const artifact = expectFirstArtifact(
      (await listArtifacts({ sessionKey: "agent:main:main" })).calls,
    );
    const artifactId = requireNonEmptyString(artifact?.id, "expected zero-byte artifact id");
    const expected = { id: artifactId, sizeBytes: 0, download: { mode: "bytes" } };
    expect(artifact).toMatchObject(expected);
    expect(artifact).not.toHaveProperty("data");
    const get = await getArtifact({ sessionKey: "agent:main:main", artifactId });
    const getPayload = expectOkPayload(get.calls) as { artifact?: Record<string, unknown> };
    expect(getPayload.artifact).toMatchObject(expected);
    expect(getPayload.artifact).not.toHaveProperty("data");
    const download = await downloadArtifact({ sessionKey: "agent:main:main", artifactId });
    const payload = expectOkPayload(download.calls) as { artifact?: Record<string, unknown> };
    expectFields(payload, { encoding: "base64", data: "" });
    expect(payload.artifact).toMatchObject(expected);
  });
  it.each([null, 0, false, {}])(
    "does not discover untyped non-string data as an artifact: %j",
    async (data) => {
      mockedMessages([{ role: "assistant", content: [{ data }], __openclaw: { seq: 2 } }]);
      const listed = await listArtifacts({ sessionKey: "agent:main:main" });
      expect(expectArtifactList(listed.calls)).toEqual({ artifacts: [] });
    },
  );

  it("preserves managed artifact identity and returns a ticketed download URL", async () => {
    const artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111";
    mockedMessages([
      {
        role: "assistant",
        content: [
          {
            type: "image",
            artifactId,
            url: "/api/chat/media/outgoing/agent%3Amain%3Amain/11111111-1111-4111-8111-111111111111/full",
            alt: "chart.png",
            mimeType: "image/png",
            sizeBytes: 14,
          },
        ],
        __openclaw: { seq: 2 },
      },
    ]);
    hoisted.resolveManagedArtifactDownload.mockResolvedValue({
      artifactId,
      sessionKey: "agent:main:main",
      type: "image",
      title: "chart.png",
      mimeType: "image/png",
      sizeBytes: 14,
      url: "/api/chat/media/outgoing/agent%3Amain%3Amain/id/full?mediaTicket=ticket",
      expiresAt: "2026-07-28T05:00:00.000Z",
    });

    const listed = await listArtifacts({ sessionKey: "agent:main:main" });
    expectFields(expectFirstArtifact(listed.calls), { id: artifactId, sizeBytes: 14 });

    const downloaded = await downloadArtifact({ sessionKey: "agent:main:main", artifactId });
    expectFields(expectOkPayload(downloaded.calls), {
      url: "/api/chat/media/outgoing/agent%3Amain%3Amain/id/full?mediaTicket=ticket",
      expiresAt: "2026-07-28T05:00:00.000Z",
    });
    expect(hoisted.resolveManagedArtifactDownload).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      agentId: "main",
      defaultAgentId: "main",
      artifactId,
    });
  });

  it.each([
    { type: "audio", mimeType: "audio/mpeg", data: "YXVkaW8=" },
    { type: "video", mimeType: "video/mp4", data: "dmlkZW8=" },
  ])("downloads inline $type artifacts as bytes", async ({ type, mimeType, data }) => {
    mockedMessages([
      {
        role: "assistant",
        content: [{ type, data, mimeType, fileName: `result.${type}` }],
        __openclaw: { seq: 2 },
      },
    ]);
    const listed = await listArtifacts({ sessionKey: "agent:main:main" });
    const artifact = expectFirstArtifact(listed.calls);
    const artifactId = requireNonEmptyString(artifact?.id, "expected media artifact id");

    const downloaded = await downloadArtifact({
      sessionKey: "agent:main:main",
      artifactId,
    });

    expectFields(artifact, { type, mimeType });
    expectFields(artifact?.download, { mode: "bytes" });
    expectFields(expectOkPayload(downloaded.calls), {
      encoding: "base64",
      data,
    });
  });

  it.each([
    { type: "audio", mimeType: "audio/mpeg", fileName: "theme.mp3" },
    { type: "video", mimeType: "video/mp4", fileName: "clip.mp4" },
  ])("returns ticketed URLs for managed $type artifacts", async ({ type, mimeType, fileName }) => {
    const attachmentId = "22222222-2222-4222-8222-222222222222";
    const artifactId = `artifact_managed_media_${attachmentId}`;
    const url = `/api/chat/media/outgoing/agent%3Amain%3Amain/${attachmentId}/full`;
    mockedMessages([
      {
        role: "assistant",
        openclawDisplayContent: [{ type, artifactId, url, openUrl: url, fileName, mimeType }],
        __openclaw: { seq: 2 },
      },
    ]);
    hoisted.resolveManagedArtifactDownload.mockResolvedValue({
      artifactId,
      sessionKey: "agent:main:main",
      type,
      title: fileName,
      mimeType,
      sizeBytes: 10,
      url: `${url}?mediaTicket=ticket`,
      expiresAt: "2026-07-28T05:00:00.000Z",
    });

    const listed = await listArtifacts({ sessionKey: "agent:main:main" });
    const downloaded = await downloadArtifact({ sessionKey: "agent:main:main", artifactId });

    expectFields(expectFirstArtifact(listed.calls), { id: artifactId, type, mimeType });
    expectFields(expectOkPayload(downloaded.calls), {
      url: `${url}?mediaTicket=ticket`,
      expiresAt: "2026-07-28T05:00:00.000Z",
    });
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

    expect(hoisted.resolveSessionKeyForRun).toHaveBeenCalledWith("run-1", {});
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
