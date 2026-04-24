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
      forkedFromId: null,
      preview: "",
      ephemeral: true,
      modelProvider: "openai",
      createdAt: 1,
      updatedAt: 1,
      status: { type: "idle" },
      path: null,
      cwd: "/tmp/openclaw-agent",
      cliVersion: "0.118.0",
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
    approvalPolicy: "never",
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
}) {
  const notifications = new Set<(notification: CodexServerNotification) => void>();
  const requests: Array<{ method: string; params?: JsonValue }> = [];
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
              delta: "A red square.",
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
                text: "A blue circle.",
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
  } as unknown as CodexAppServerClient;

  return { client, requests };
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
    expect(requests[1]?.params).toMatchObject({
      model: "gpt-5.4",
      modelProvider: "openai",
      approvalPolicy: "never",
      sandbox: "read-only",
      dynamicTools: [],
      ephemeral: true,
      persistExtendedHistory: false,
    });
    expect(requests[2]?.params).toMatchObject({
      threadId: "thread-1",
      approvalPolicy: "never",
      model: "gpt-5.4",
      input: [
        { type: "text", text: "Describe briefly.", text_elements: [] },
        { type: "image", url: "data:image/png;base64,aW1hZ2UtYnl0ZXM=" },
      ],
    });
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
});
