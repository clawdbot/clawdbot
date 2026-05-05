import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { deliverAgentCommandResult, normalizeAgentCommandReplyPayloads } from "./delivery.js";
import type { AgentCommandOpts } from "./types.js";

const deliverOutboundPayloadsMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => [] as unknown[]),
);
vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsMock,
}));

const createReplyMediaPathNormalizerMock = vi.hoisted(() =>
  vi.fn(
    (..._args: unknown[]) =>
      (payload: ReplyPayload) =>
        Promise.resolve(payload),
  ),
);
vi.mock("../../auto-reply/reply/reply-media-paths.runtime.js", () => ({
  createReplyMediaPathNormalizer: createReplyMediaPathNormalizerMock,
}));

type NormalizeParams = Parameters<typeof normalizeAgentCommandReplyPayloads>[0];
type RunResult = NormalizeParams["result"];
type DeliverParams = Parameters<typeof deliverAgentCommandResult>[0];

const slackOutboundForTest: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ to, text }) => ({
    channel: "slack",
    messageId: `${to}:${text}`,
  }),
};

const emptyRegistry = createTestRegistry([]);
const slackRegistry = createTestRegistry([
  {
    pluginId: "slack",
    source: "test",
    plugin: createOutboundTestPlugin({
      id: "slack",
      outbound: slackOutboundForTest,
      messaging: {
        enableInteractiveReplies: ({ cfg }) =>
          (cfg.channels?.slack as { capabilities?: { interactiveReplies?: boolean } } | undefined)
            ?.capabilities?.interactiveReplies === true,
      },
    }),
  },
]);

function createResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    meta: {
      durationMs: 1,
      ...overrides.meta,
    },
    ...(overrides.payloads ? { payloads: overrides.payloads } : {}),
  } as RunResult;
}

async function deliverMediaReplyForTest(outboundSession: DeliverParams["outboundSession"]) {
  const runtime = { log: vi.fn(), error: vi.fn() };
  return await deliverAgentCommandResult({
    cfg: {
      agents: {
        list: [{ id: "tester", workspace: "/tmp/agent-workspace" }],
      },
    } as OpenClawConfig,
    deps: {} as CliDeps,
    runtime: runtime as never,
    opts: {
      message: "go",
      deliver: true,
      replyChannel: "slack",
      replyTo: "#general",
    } as AgentCommandOpts,
    outboundSession,
    sessionEntry: undefined,
    payloads: [{ text: "here you go", mediaUrls: ["./out/photo.png"] }],
    result: createResult(),
  });
}

describe("normalizeAgentCommandReplyPayloads", () => {
  beforeEach(() => {
    setActivePluginRegistry(slackRegistry);
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("keeps Slack directives in text for direct agent deliveries", () => {
    const normalized = normalizeAgentCommandReplyPayloads({
      cfg: {
        channels: {
          slack: {
            capabilities: { interactiveReplies: true },
          },
        },
      } as OpenClawConfig,
      opts: { message: "test" } as AgentCommandOpts,
      outboundSession: undefined,
      deliveryChannel: "slack",
      payloads: [{ text: "Choose [[slack_buttons: Retry:retry]]" }],
      result: createResult(),
    });

    expect(normalized).toMatchObject([
      {
        text: "Choose [[slack_buttons: Retry:retry]]",
      },
    ]);
  });

  it("renders response prefix templates with the selected runtime model", () => {
    const normalized = normalizeAgentCommandReplyPayloads({
      cfg: {
        messages: {
          responsePrefix: "[{modelFull}]",
        },
      } as OpenClawConfig,
      opts: { message: "test" } as AgentCommandOpts,
      outboundSession: undefined,
      deliveryChannel: "slack",
      payloads: [{ text: "Ready." }],
      result: createResult({
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "session-1",
            provider: "openai-codex",
            model: "gpt-5.4",
          },
        },
      }),
    });

    expect(normalized).toMatchObject([
      {
        text: "[openai-codex/gpt-5.4] Ready.",
      },
    ]);
  });

  it("keeps Slack options text intact for local preview when delivery is disabled", async () => {
    const runtime = {
      log: vi.fn(),
    };

    const delivered = await deliverAgentCommandResult({
      cfg: {
        channels: {
          slack: {
            capabilities: { interactiveReplies: true },
          },
        },
      } as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: runtime as never,
      opts: {
        message: "test",
        channel: "slack",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "Options: on, off." }],
      result: createResult(),
    });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith("Options: on, off.");
    expect(delivered.payloads).toMatchObject([{ text: "Options: on, off." }]);
  });

  it("normalizes reply-media paths before outbound delivery", async () => {
    const normalizerFn = vi.fn(
      async (payload: ReplyPayload): Promise<ReplyPayload> => ({
        ...payload,
        mediaUrl: "/tmp/agent-workspace/out/photo.png",
        mediaUrls: ["/tmp/agent-workspace/out/photo.png"],
      }),
    );
    createReplyMediaPathNormalizerMock.mockReturnValue(normalizerFn);
    deliverOutboundPayloadsMock.mockResolvedValue([]);

    await deliverMediaReplyForTest({
      key: "agent:tester:slack:direct:alice",
      agentId: "tester",
    } as never);

    expect(createReplyMediaPathNormalizerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:tester:slack:direct:alice",
        agentId: "tester",
        workspaceDir: "/tmp/agent-workspace",
        messageProvider: "slack",
      }),
    );
    expect(normalizerFn).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrls: ["./out/photo.png"] }),
    );
    expect(deliverOutboundPayloadsMock).toHaveBeenCalledTimes(1);
    const [firstCallArg] = deliverOutboundPayloadsMock.mock.calls[0] ?? [];
    const deliverArgs = firstCallArg as { payloads: ReplyPayload[] } | undefined;
    expect(deliverArgs?.payloads[0]).toMatchObject({
      mediaUrls: ["/tmp/agent-workspace/out/photo.png"],
    });
  });

  it("reports successful requested delivery", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([]);

    const delivered = await deliverMediaReplyForTest({
      key: "agent:tester:slack:direct:alice",
      agentId: "tester",
    } as never);

    expect(delivered.deliverySucceeded).toBe(true);
  });

  it("does not report success when best-effort delivery records an error", async () => {
    deliverOutboundPayloadsMock.mockImplementationOnce(async (params: unknown) => {
      (params as { onError?: (err: unknown) => void }).onError?.(new Error("send failed"));
      return [];
    });

    const runtime = { log: vi.fn(), error: vi.fn() };
    const delivered = await deliverAgentCommandResult({
      cfg: {
        agents: {
          list: [{ id: "tester", workspace: "/tmp/agent-workspace" }],
        },
      } as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: runtime as never,
      opts: {
        message: "go",
        deliver: true,
        bestEffortDeliver: true,
        replyChannel: "slack",
        replyTo: "#general",
      } as AgentCommandOpts,
      outboundSession: {
        key: "agent:tester:slack:direct:alice",
        agentId: "tester",
      } as never,
      sessionEntry: undefined,
      payloads: [{ text: "here you go" }],
      result: createResult(),
    });

    expect(delivered.deliverySucceeded).toBe(false);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("send failed"));
  });

  it("threads agentId into the normalizer when sessionKey is unresolved", async () => {
    createReplyMediaPathNormalizerMock.mockReturnValue(async (payload: ReplyPayload) => payload);
    deliverOutboundPayloadsMock.mockResolvedValue([]);

    await deliverMediaReplyForTest({ agentId: "tester" } as never);

    expect(createReplyMediaPathNormalizerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "tester",
        sessionKey: undefined,
        workspaceDir: "/tmp/agent-workspace",
      }),
    );
  });

  it("keeps LINE directive-only replies intact for local preview when delivery is disabled", async () => {
    const runtime = {
      log: vi.fn(),
    };

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: runtime as never,
      opts: {
        message: "test",
        channel: "line",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [
        {
          text: "[[buttons: Release menu | Choose an action | Retry:retry, Ignore:ignore]]",
        },
      ],
      result: createResult(),
    });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith(
      "[[buttons: Release menu | Choose an action | Retry:retry, Ignore:ignore]]",
    );
    expect(delivered.payloads).toMatchObject([
      {
        text: "[[buttons: Release menu | Choose an action | Retry:retry, Ignore:ignore]]",
      },
    ]);
  });

  it("merges result metadata overrides into JSON output and returned results", async () => {
    const runtime = {
      log: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
    };

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: runtime as never,
      opts: {
        message: "test",
        json: true,
        resultMetaOverrides: {
          transport: "embedded",
          fallbackFrom: "gateway",
        },
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "local" }],
      result: createResult(),
    });

    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        payloads: [{ text: "local", mediaUrl: null }],
        meta: {
          durationMs: 1,
          transport: "embedded",
          fallbackFrom: "gateway",
        },
      },
      2,
    );
    expect(delivered.meta).toMatchObject({
      durationMs: 1,
      transport: "embedded",
      fallbackFrom: "gateway",
    });
  });
});
