import { ServerResponse, type IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import type { OpenClawConfig, RuntimeEnv } from "openclaw/plugin-sdk/mattermost";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedMattermostAccount } from "./accounts.js";

const mockState = vi.hoisted(() => ({
  readRequestBodyWithLimit: vi.fn(async () => "token=valid-token"),
  parseSlashCommandPayload: vi.fn(() => ({
    token: "valid-token",
    command: "/oc_models",
    text: "models",
    channel_id: "chan-1",
    user_id: "user-1",
    user_name: "alice",
    team_id: "team-1",
  })),
  resolveCommandText: vi.fn((_trigger: string, text: string) => text),
  buildModelsProviderData: vi.fn(async () => ({ providers: [], modelNames: new Map() })),
  resolveMattermostModelPickerEntry: vi.fn(() => ({ kind: "summary" })),
  authorizeMattermostCommandInvocation: vi.fn(() => ({
    ok: true,
    commandAuthorized: true,
    channelInfo: { id: "chan-1", type: "O", name: "town-square", display_name: "Town Square" },
    kind: "channel",
    chatType: "channel",
    channelName: "town-square",
    channelDisplay: "Town Square",
    roomLabel: "#town-square",
  })),
  createMattermostClient: vi.fn(() => ({})),
  fetchMattermostChannel: vi.fn(async () => ({
    id: "chan-1",
    type: "O",
    name: "town-square",
    display_name: "Town Square",
  })),
  sendMessageMattermost: vi.fn(async () => ({ messageId: "post-1", channelId: "chan-1" })),
  normalizeMattermostAllowList: vi.fn((value: unknown) => value),
}));

vi.mock("./runtime-api.js", () => {
  return {
    buildModelsProviderData: mockState.buildModelsProviderData,
    createChannelReplyPipeline: vi.fn(() => ({
      onModelSelected: vi.fn(),
      typingCallbacks: {},
    })),
    createDedupeCache: vi.fn(() => ({
      check: () => false,
    })),
    createReplyPrefixOptions: vi.fn(() => ({})),
    createTypingCallbacks: vi.fn(() => ({ onReplyStart: vi.fn() })),
    isRequestBodyLimitError: vi.fn(() => false),
    logTypingFailure: vi.fn(),
    formatInboundFromLabel: vi.fn(() => ""),
    rawDataToString: vi.fn((value: unknown) => (typeof value === "string" ? value : "")),
    readRequestBodyWithLimit: mockState.readRequestBodyWithLimit,
    resolveThreadSessionKeys: vi.fn((params: { baseSessionKey: string }) => ({
      sessionKey: params.baseSessionKey,
      parentSessionKey: undefined,
    })),
  };
});

vi.mock("../runtime.js", () => ({
  getMattermostRuntime: () => ({
    channel: {
      commands: {
        shouldHandleTextCommands: () => true,
      },
      text: {
        hasControlCommand: () => false,
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
      },
      routing: {
        resolveAgentRoute: vi.fn(() => ({
          agentId: "agent-1",
          sessionKey: "mattermost:session:1",
          accountId: "default",
        })),
      },
    },
  }),
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  return {
    ...actual,
    createMattermostClient: mockState.createMattermostClient,
    fetchMattermostChannel: mockState.fetchMattermostChannel,
    normalizeMattermostBaseUrl: vi.fn((value: string | undefined) => value?.trim() ?? ""),
    sendMattermostTyping: vi.fn(),
  };
});

vi.mock("./model-picker.js", () => ({
  renderMattermostModelSummaryView: vi.fn(),
  renderMattermostModelsPickerView: vi.fn(),
  renderMattermostProviderPickerView: vi.fn(),
  resolveMattermostModelPickerCurrentModel: vi.fn(),
  resolveMattermostModelPickerEntry: mockState.resolveMattermostModelPickerEntry,
}));

vi.mock("./monitor-auth.js", () => ({
  authorizeMattermostCommandInvocation: mockState.authorizeMattermostCommandInvocation,
  normalizeMattermostAllowList: mockState.normalizeMattermostAllowList,
}));

vi.mock("./reply-delivery.js", () => ({
  deliverMattermostReplyPayload: vi.fn(),
}));

vi.mock("./send.js", () => ({
  sendMessageMattermost: mockState.sendMessageMattermost,
}));

vi.mock("./slash-commands.js", () => ({
  parseSlashCommandPayload: mockState.parseSlashCommandPayload,
  resolveCommandText: mockState.resolveCommandText,
}));

let createSlashCommandHttpHandler: typeof import("./slash-http.js").createSlashCommandHttpHandler;

function createRequest(body = "token=valid-token"): IncomingMessage {
  const req = new PassThrough();
  const incoming = req as PassThrough & IncomingMessage;
  incoming.method = "POST";
  incoming.headers = {
    "content-type": "application/x-www-form-urlencoded",
  };
  process.nextTick(() => {
    req.end(body);
  });
  return incoming;
}

function createResponse(): {
  res: ServerResponse;
  getBody: () => string;
} {
  let body = "";
  class TestServerResponse extends ServerResponse {
    override setHeader() {
      return this;
    }

    override end(): this;
    override end(cb: () => void): this;
    override end(chunk: string | Buffer | Uint8Array, cb?: () => void): this;
    override end(
      chunk: string | Buffer | Uint8Array,
      encoding: BufferEncoding,
      cb?: () => void,
    ): this;
    override end(
      chunkOrCb?: string | Buffer | Uint8Array | (() => void),
      encodingOrCb?: BufferEncoding | (() => void),
      cb?: () => void,
    ): this {
      const chunk = typeof chunkOrCb === "function" ? undefined : chunkOrCb;
      const callback =
        typeof chunkOrCb === "function"
          ? chunkOrCb
          : typeof encodingOrCb === "function"
            ? encodingOrCb
            : cb;
      body = chunk ? String(chunk) : "";
      callback?.();
      return this;
    }
  }

  const res = new TestServerResponse(createRequest(""));
  return {
    res,
    getBody: () => body,
  };
}

const accountFixture: ResolvedMattermostAccount = {
  accountId: "default",
  enabled: true,
  botToken: "bot-token",
  baseUrl: "https://chat.example.com",
  botTokenSource: "config",
  baseUrlSource: "config",
  config: {},
};

describe("slash-http cfg threading", () => {
  beforeEach(async () => {
    vi.resetModules();
    mockState.readRequestBodyWithLimit.mockClear();
    mockState.parseSlashCommandPayload.mockClear();
    mockState.resolveCommandText.mockClear();
    mockState.buildModelsProviderData.mockClear();
    mockState.resolveMattermostModelPickerEntry.mockClear();
    mockState.authorizeMattermostCommandInvocation.mockClear();
    mockState.createMattermostClient.mockClear();
    mockState.fetchMattermostChannel.mockClear();
    mockState.sendMessageMattermost.mockClear();
    mockState.normalizeMattermostAllowList.mockClear();
    ({ createSlashCommandHttpHandler } = await import("./slash-http.js"));
  });

  it("passes cfg through the no-models slash reply send path", async () => {
    const cfg = {
      channels: {
        mattermost: {
          botToken: "exec:secret-ref",
        },
      },
    } as OpenClawConfig;
    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg,
      runtime: {} as RuntimeEnv,
      commandTokens: new Set(["valid-token"]),
    });
    const response = createResponse();

    await handler(createRequest(), response.res);

    expect(response.res.statusCode).toBe(200);
    expect(response.getBody()).toContain("Processing");
    expect(mockState.sendMessageMattermost).toHaveBeenCalledWith(
      "channel:chan-1",
      "No models available.",
      expect.objectContaining({
        cfg,
        accountId: "default",
      }),
    );
  });

  it("does not rely on Set.has for command token validation", async () => {
    const commandTokens = new Set(["valid-token"]);
    const hasSpy = vi.fn(() => {
      throw new Error("Set.has should not be used for slash token validation");
    });
    Object.defineProperty(commandTokens, "has", {
      value: hasSpy,
      configurable: true,
    });

    const handler = createSlashCommandHttpHandler({
      account: accountFixture,
      cfg: {} as OpenClawConfig,
      runtime: {} as RuntimeEnv,
      commandTokens,
    });
    const response = createResponse();

    await handler(createRequest(), response.res);

    expect(response.res.statusCode).toBe(200);
    expect(response.getBody()).toContain("Processing");
    expect(hasSpy).not.toHaveBeenCalled();
  });
});
