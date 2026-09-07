import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { buildAgentSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleClickClackInbound } from "./inbound.js";
import { setClickClackRuntime } from "./runtime.js";
import type { ClickClackMessage, ResolvedClickClackAccount } from "./types.js";

function createRuntime(): PluginRuntime {
  return createPluginRuntimeMock({
    agent: {
      runEmbeddedAgent: vi.fn().mockResolvedValue({
        payloads: [{ text: "service bot online" }],
        meta: {},
      }),
      session: {
        getSessionEntry: vi.fn(() => ({ sessionId: "session-id", updatedAt: 1 })),
      },
    },
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(
          (params: Parameters<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>[0]) =>
            resolveAgentRoute(params),
        ),
        buildAgentSessionKey: vi.fn(
          (params: Parameters<PluginRuntime["channel"]["routing"]["buildAgentSessionKey"]>[0]) =>
            buildAgentSessionKey(params),
        ),
      },
    },
  } as unknown as PluginRuntime);
}

function createAccount(replyMode: "agent" | "model" = "agent"): ResolvedClickClackAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    baseUrl: "http://127.0.0.1:8080",
    apiEndpoint: "http://127.0.0.1:8080",
    token: "test-token-placeholder",
    workspace: "wsp_1",
    replyMode,
    toolsAllow: [],
    defaultTo: "channel:general",
    allowFrom: ["*"],
    allowBots: false,
    reconnectMs: 1_500,
    agentActivity: false,
    nativeProgress: false,
    commandMenu: true,
    discussions: { enabled: false, workspace: "wsp_1", section: "Sessions" },
    requireMention: false,
    mentionPatterns: [],
    groups: {},
    config: { allowFrom: ["*"] },
  };
}

function createMessage(uploadId: string, byteSize: number): ClickClackMessage {
  return {
    id: "msg_1",
    workspace_id: "wsp_1",
    direct_conversation_id: "dm_1",
    author_id: "usr_owner",
    thread_root_id: "msg_1",
    body: "inspect this plan",
    body_format: "markdown",
    created_at: "2026-05-09T12:00:00.000Z",
    author: {
      id: "usr_owner",
      kind: "human",
      display_name: "Peter",
      handle: "steipete",
      avatar_url: "",
      created_at: "2026-05-09T12:00:00.000Z",
    },
    attachments: [
      {
        id: uploadId,
        workspace_id: "wsp_1",
        owner_id: "usr_owner",
        filename: "floor-plan.png",
        content_type: "image/png",
        byte_size: byteSize,
        width: 100,
        height: 80,
        duration_ms: 0,
        created_at: "2026-05-09T12:00:00.000Z",
      },
    ],
  };
}

describe("ClickClack inbound media", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stages authenticated attachments before dispatching the agent turn", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "image/png" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await handleClickClackInbound({
      account: createAccount(),
      config: {},
      message: createMessage("upl_plan", 3),
      correlationId: "fakeco.media_1",
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:8080/api/uploads/upl_plan");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token-placeholder");
    expect(runtime.channel.media.saveResponseMedia).toHaveBeenCalledWith(
      expect.any(Response),
      expect.objectContaining({
        sourceUrl: "http://127.0.0.1:8080/api/uploads/upl_plan",
        filePathHint: "floor-plan.png",
        fallbackContentType: "image/png",
        subdir: "inbound",
      }),
    );
    const dispatchTurn = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatchTurn.mock.calls[0]?.[0].ctxPayload.media).toEqual([
      expect.objectContaining({
        path: "/tmp/test-media.jpg",
        contentType: "image/jpeg",
        messageId: "msg_1",
      }),
    ]);
  });

  it("uses the agent pipeline for media in text-only model mode", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/png" } }),
      ),
    );

    await handleClickClackInbound({
      account: createAccount("model"),
      config: {},
      message: createMessage("upl_model_plan", 1),
    });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
  });
});
