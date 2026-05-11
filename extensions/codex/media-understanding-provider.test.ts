import { describe, expect, it, vi } from "vitest";
import { buildCodexMediaUnderstandingProvider } from "./media-understanding-provider.js";
import type { CodexAppServerClient } from "./src/app-server/client.js";
import type { CodexServerNotification, JsonValue } from "./src/app-server/protocol.js";

function codexModel(inputModalities: string[] = ["text", "image"]) {
  return {
    id: "gpt-5.4",
    model: "gpt-5.4",
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: "gpt-5.4",
    description: "GPT-5.4",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "fast" }],
    defaultReasoningEffort: "low",
    inputModalities,
    supportsPersonality: false,
    additionalSpeedTiers: [],
    isDefault: true,
  };
}

function threadStartResult() {
  return {
    thread: {
      id: "thread-1",
      sessionId: "session-1",
      forkedFromId: null,
      preview: "",
      ephemeral: true,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: "/tmp/openclaw-agent",
      cliVersion: "0.125.0",
      source: "unknown",
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/tmp/openclaw-agent",
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    permissionProfile: null,
    reasoningEffort: null,
  };
}

function turnStartResult(status = "inProgress", items: JsonValue[] = []) {
  return {
    turn: {
      id: "turn-1",
      status,
      items,
      error: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
    },
  };
}

function createFakeClient(options?: {
  inputModalities?: string[];
  completeWithItems?: boolean;
  notifyError?: string;
  approvalRequestMethod?: string;
  responseText?: string;
}) {
  const notifications = new Set<(notification: CodexServerNotification) => void>();
  const requestHandlers = new Set<(request: { method: string }) => JsonValue | undefined>();
  const requests: Array<{ method: string; params?: JsonValue }> = [];
  const approvalResponses: JsonValue[] = [];
  const request = vi.fn(async (method: string, params?: JsonValue) => {
    requests.push({ method, params });
    if (method === "model/list") {
      return {
        data: [codexModel(options?.inputModalities)],
        nextCursor: null,
      };
    }
    if (method === "thread/start") {
      return threadStartResult();
    }
    if (method === "turn/start") {
      if (options?.approvalRequestMethod) {
        for (const handler of requestHandlers) {
          const response = handler({ method: options.approvalRequestMethod });
          if (response !== undefined) {
            approvalResponses.push(response);
          }
        }
      }
      if (options?.notifyError) {
        for (const notify of notifications) {
          notify({
            method: "error",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              error: {
                message: options.notifyError,
                codexErrorInfo: null,
                additionalDetails: null,
              },
              willRetry: false,
            },
          });
        }
      } else if (!options?.completeWithItems) {
        for (const notify of notifications) {
          notify({
            method: "item/agentMessage/delta",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "msg-1",
              delta: options?.responseText ?? "A red square.",
            },
          });
          notify({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              turn: turnStartResult("completed").turn,
            },
          });
        }
      }
      return turnStartResult(
        options?.completeWithItems ? "completed" : "inProgress",
        options?.completeWithItems
          ? [
              {
                id: "msg-1",
                type: "agentMessage",
                text: options?.responseText ?? "A blue circle.",
                phase: null,
                memoryCitation: null,
              },
            ]
          : [],
      );
    }
    return {};
  });

  const client = {
    request,
    addNotificationHandler(handler: (notification: CodexServerNotification) => void) {
      notifications.add(handler);
      return () => notifications.delete(handler);
    },
    addRequestHandler(handler: (request: { method: string }) => JsonValue | undefined) {
      requestHandlers.add(handler);
      return () => requestHandlers.delete(handler);
    },
  } as unknown as CodexAppServerClient;

  return { client, requests, approvalResponses };
}

describe("codex media understanding provider", () => {
  it("runs image understanding through a bounded Codex app-server turn", async () => {
    const { client, requests } = createFakeClient();
    const provider = buildCodexMediaUnderstandingProvider({
      clientFactory: async () => client,
    });

    const result = await provider.describeImage?.({
      buffer: Buffer.from("image-bytes"),
      fileName: "image.png",
      mime: "image/png",
      provider: "codex",
      model: "gpt-5.4",
      prompt: "Describe briefly.",
      timeoutMs: 30_000,
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
    });

    expect(result).toEqual({ text: "A red square.", model: "gpt-5.4" });
    expect(requests.map((entry) => entry.method)).toEqual([
      "model/list",
      "thread/start",
      "turn/start",
    ]);
    expect(requests[1]?.params).toEqual({
      model: "gpt-5.4",
      modelProvider: "openai",
      cwd: "/tmp/openclaw-agent",
      approvalPolicy: "on-request",
      sandbox: "read-only",
      serviceName: "OpenClaw",
      developerInstructions:
        "You are OpenClaw's bounded image-understanding worker. Describe only the provided image content. Do not call tools, edit files, or ask follow-up questions.",
      dynamicTools: [],
      experimentalRawEvents: true,
      ephemeral: true,
      persistExtendedHistory: false,
    });
    expect(requests[2]?.params).toEqual({
      threadId: "thread-1",
      input: [
        { type: "text", text: "Describe briefly.", text_elements: [] },
        { type: "image", url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=" },
      ],
      cwd: "/tmp/openclaw-agent",
      approvalPolicy: "on-request",
      model: "gpt-5.4",
      effort: "low",
    });
  });

  it("declines approval requests during image understanding", async () => {
    const { client, approvalResponses } = createFakeClient({
      approvalRequestMethod: "item/permissions/requestApproval",
    });
    const provider = buildCodexMediaUnderstandingProvider({
      clientFactory: async () => client,
    });

    await provider.describeImage?.({
      buffer: Buffer.from("image-bytes"),
      fileName: "image.png",
      mime: "image/png",
      provider: "codex",
      model: "gpt-5.4",
      prompt: "Describe briefly.",
      timeoutMs: 30_000,
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
    });

    expect(approvalResponses).toEqual([{ permissions: {}, scope: "turn" }]);
  });

  it("extracts text from terminal turn items", async () => {
    const { client } = createFakeClient({ completeWithItems: true });
    const provider = buildCodexMediaUnderstandingProvider({
      clientFactory: async () => client,
    });

    const result = await provider.describeImages?.({
      images: [{ buffer: Buffer.from("image-bytes"), fileName: "image.png", mime: "image/png" }],
      provider: "codex",
      model: "gpt-5.4",
      prompt: "Describe briefly.",
      timeoutMs: 30_000,
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
    });

    expect(result).toEqual({ text: "A blue circle.", model: "gpt-5.4" });
  });

  it("rejects text-only Codex app-server models before starting a turn", async () => {
    const { client, requests } = createFakeClient({ inputModalities: ["text"] });
    const provider = buildCodexMediaUnderstandingProvider({
      clientFactory: async () => client,
    });

    await expect(
      provider.describeImage?.({
        buffer: Buffer.from("image-bytes"),
        fileName: "image.png",
        mime: "image/png",
        provider: "codex",
        model: "gpt-5.4",
        timeoutMs: 30_000,
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
      }),
    ).rejects.toThrow("Codex app-server model does not support images: gpt-5.4");
    expect(requests.map((entry) => entry.method)).toEqual(["model/list"]);
  });

  it("surfaces Codex app-server turn errors", async () => {
    const { client } = createFakeClient({ notifyError: "vision unavailable" });
    const provider = buildCodexMediaUnderstandingProvider({
      clientFactory: async () => client,
    });

    await expect(
      provider.describeImage?.({
        buffer: Buffer.from("image-bytes"),
        fileName: "image.png",
        mime: "image/png",
        provider: "codex",
        model: "gpt-5.4",
        timeoutMs: 30_000,
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
      }),
    ).rejects.toThrow("vision unavailable");
  });

  it("runs structured extraction through the same bounded Codex app-server path", async () => {
    const { client, requests } = createFakeClient({
      responseText: '{"summary":"red square","tags":["shape"]}',
    });
    const provider = buildCodexMediaUnderstandingProvider({
      clientFactory: async () => client,
    });

    const result = await provider.extractStructured?.({
      input: [
        { type: "text", text: "Extract searchable evidence." },
        {
          type: "image",
          buffer: Buffer.from("image-bytes"),
          fileName: "image.png",
          mime: "image/png",
        },
      ],
      instructions: "Return a compact evidence object.",
      schemaName: "example.media",
      jsonSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["summary"],
      },
      provider: "codex",
      model: "gpt-5.4",
      timeoutMs: 30_000,
      cfg: {},
      agentDir: "/tmp/openclaw-agent",
    });

    expect(result).toEqual({
      text: '{"summary":"red square","tags":["shape"]}',
      parsed: { summary: "red square", tags: ["shape"] },
      model: "gpt-5.4",
      provider: "codex",
      contentType: "json",
    });
    expect(requests.map((entry) => entry.method)).toEqual([
      "model/list",
      "thread/start",
      "turn/start",
    ]);
    expect(requests[1]?.params).toEqual({
      model: "gpt-5.4",
      modelProvider: "openai",
      cwd: "/tmp/openclaw-agent",
      approvalPolicy: "on-request",
      sandbox: "read-only",
      serviceName: "OpenClaw",
      developerInstructions:
        "You are OpenClaw's bounded structured-extraction worker. Return only the requested extraction. Do not call tools, edit files, ask follow-up questions, or include secrets.",
      dynamicTools: [],
      experimentalRawEvents: true,
      ephemeral: true,
      persistExtendedHistory: false,
    });
    const turnParams = requests[2]?.params as
      | {
          threadId?: unknown;
          approvalPolicy?: unknown;
          model?: unknown;
          input?: Array<{ type?: unknown; text?: unknown; text_elements?: unknown; url?: unknown }>;
          cwd?: unknown;
          effort?: unknown;
        }
      | undefined;
    expect(turnParams?.threadId).toBe("thread-1");
    expect(turnParams?.approvalPolicy).toBe("on-request");
    expect(turnParams?.model).toBe("gpt-5.4");
    expect(turnParams?.cwd).toBe("/tmp/openclaw-agent");
    expect(turnParams?.effort).toBe("low");
    expect(turnParams?.input).toHaveLength(3);
    expect(turnParams?.input?.[0]?.type).toBe("text");
    expect(turnParams?.input?.[0]?.text).toContain("Return valid JSON only");
    expect(turnParams?.input?.[0]?.text_elements).toStrictEqual([]);
    expect(turnParams?.input?.[1]).toStrictEqual({
      type: "text",
      text: "Extract searchable evidence.",
      text_elements: [],
    });
    expect(turnParams?.input?.[2]).toStrictEqual({
      type: "image",
      url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=",
    });
  });

  it("rejects text-only structured extraction before starting a turn", async () => {
    const { client, requests } = createFakeClient({
      inputModalities: ["text"],
      responseText: '{"summary":"only text"}',
    });
    const provider = buildCodexMediaUnderstandingProvider({
      clientFactory: async () => client,
    });

    await expect(
      provider.extractStructured?.({
        input: [{ type: "text", text: "The answer is only text." }],
        instructions: "Return summary JSON.",
        provider: "codex",
        model: "gpt-5.4",
        timeoutMs: 30_000,
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
      }),
    ).rejects.toThrow("Codex structured extraction requires at least one image input.");
    expect(requests).toEqual([]);
  });

  it("returns a controlled error when structured JSON parsing fails", async () => {
    const { client } = createFakeClient({ responseText: "not json" });
    const provider = buildCodexMediaUnderstandingProvider({
      clientFactory: async () => client,
    });

    await expect(
      provider.extractStructured?.({
        input: [
          { type: "text", text: "Extract JSON." },
          {
            type: "image",
            buffer: Buffer.from("image-bytes"),
            fileName: "image.png",
            mime: "image/png",
          },
        ],
        instructions: "Return summary JSON.",
        provider: "codex",
        model: "gpt-5.4",
        timeoutMs: 30_000,
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
      }),
    ).rejects.toThrow("Codex structured extraction returned invalid JSON.");
  });

  it("validates structured extraction JSON against the requested schema", async () => {
    const { client } = createFakeClient({
      responseText: '{"summary":123,"tags":["shape"]}',
    });
    const provider = buildCodexMediaUnderstandingProvider({
      clientFactory: async () => client,
    });

    await expect(
      provider.extractStructured?.({
        input: [
          { type: "text", text: "Extract JSON." },
          {
            type: "image",
            buffer: Buffer.from("image-bytes"),
            fileName: "image.png",
            mime: "image/png",
          },
        ],
        instructions: "Return summary JSON.",
        jsonSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
          },
          required: ["summary"],
        },
        provider: "codex",
        model: "gpt-5.4",
        timeoutMs: 30_000,
        cfg: {},
        agentDir: "/tmp/openclaw-agent",
      }),
    ).rejects.toThrow("Codex structured extraction JSON did not match schema");
  });
});
