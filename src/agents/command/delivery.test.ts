// Covers agent-command reply normalization and outbound delivery status.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type {
  ChannelOutboundAdapter,
  ChannelThreadingAdapter,
} from "../../channels/plugins/types.public.js";
import type { CliDeps } from "../../cli/outbound-send-deps.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { createAgentRunRestartAbortError } from "../run-termination.js";
import { deliverAgentCommandResult } from "./delivery.js";
import type { AgentCommandOpts } from "./types.js";

const deliverOutboundPayloadsMock = vi.hoisted(() =>
  vi.fn(async (..._args: unknown[]) => [] as unknown[]),
);
vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsMock,
  deliverOutboundPayloadsInternal: deliverOutboundPayloadsMock,
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

type DeliverParams = Parameters<typeof deliverAgentCommandResult>[0];
type RunResult = DeliverParams["result"];
type TextPayloadLike = { text?: unknown };
type ResolveReplyTransportParams = Parameters<
  NonNullable<ChannelThreadingAdapter["resolveReplyTransport"]>
>[0];
type MediaNormalizerOptions = {
  sessionKey?: unknown;
  agentId?: unknown;
  workspaceDir?: unknown;
  messageProvider?: unknown;
};

const slackOutboundForTest: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ to, text }) => ({
    channel: "slack",
    messageId: `${to}:${text}`,
  }),
};

// Two registries let tests switch between no-channel and Slack-capable delivery
// without loading the full plugin runtime.
const emptyRegistry = createTestRegistry([]);
const slackPluginForTest = createOutboundTestPlugin({
  id: "slack",
  outbound: slackOutboundForTest,
  messaging: {
    enableInteractiveReplies: ({ cfg }) =>
      (cfg.channels?.slack as { capabilities?: { interactiveReplies?: boolean } } | undefined)
        ?.capabilities?.interactiveReplies === true,
  },
});
const slackRegistry = createTestRegistry([
  {
    pluginId: "slack",
    source: "test",
    plugin: {
      ...slackPluginForTest,
      threading: {
        resolveReplyTransport: ({ threadId }: ResolveReplyTransportParams) => ({
          replyToId: threadId == null ? undefined : String(threadId),
          threadId: null,
        }),
      },
    },
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

function expectTextPayload(payload: TextPayloadLike | undefined, text: string): void {
  expect(payload?.text).toBe(text);
}

function requirePayload(payloads: readonly ReplyPayload[], index: number): ReplyPayload {
  const payload = payloads.at(index);
  if (!payload) {
    throw new Error(`expected payload at index ${index}`);
  }
  return payload;
}

function lastMockArg(mock: { mock: { calls: Array<Array<unknown>> } }, label: string): unknown {
  const calls = mock.mock.calls;
  const call = calls[calls.length - 1];
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call[0];
}

function latestNormalizerOptions(): MediaNormalizerOptions {
  const options = lastMockArg(createReplyMediaPathNormalizerMock, "media normalizer options");
  if (!options || typeof options !== "object") {
    throw new Error("expected media normalizer options");
  }
  return options as MediaNormalizerOptions;
}

function latestOutboundDeliveryArgs(): {
  channel?: string;
  to?: string;
  accountId?: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  payloads: ReplyPayload[];
  bestEffort?: boolean;
  queuePolicy?: string;
} {
  const args = lastMockArg(deliverOutboundPayloadsMock, "outbound delivery arguments");
  if (!args || typeof args !== "object") {
    throw new Error("expected outbound delivery arguments");
  }
  return args as {
    channel?: string;
    to?: string;
    accountId?: string;
    replyToId?: string | null;
    threadId?: string | number | null;
    payloads: ReplyPayload[];
    bestEffort?: boolean;
    queuePolicy?: string;
  };
}

type DeliveryStatusLike = {
  requested?: unknown;
  attempted?: unknown;
  status?: unknown;
  succeeded?: unknown;
  reason?: unknown;
  error?: unknown;
  errorMessage?: unknown;
  resultCount?: unknown;
  sentBeforeError?: unknown;
  payloadOutcomes?: Array<Record<string, unknown>>;
};

function deliveryStatus(delivered: { deliveryStatus?: unknown }): DeliveryStatusLike {
  return (delivered.deliveryStatus ?? {}) as DeliveryStatusLike;
}

function expectDeliveryStatusFields(
  delivered: { deliveryStatus?: unknown },
  expected: Record<string, unknown>,
) {
  const status = deliveryStatus(delivered);
  for (const [key, value] of Object.entries(expected)) {
    expect(status[key as keyof DeliveryStatusLike], key).toEqual(value);
  }
  return status;
}

function expectRuntimeErrorIncludes(
  runtime: { error: { mock: { calls: Array<Array<unknown>> } } },
  text: string,
) {
  const errorOutput = runtime.error.mock.calls.map(([message]) => String(message)).join("\n");
  expect(errorOutput).toContain(text);
}

function latestJsonOutput(runtime: { writeJson: { mock: { calls: Array<Array<unknown>> } } }) {
  const output = lastMockArg(runtime.writeJson, "JSON output");
  if (!output || typeof output !== "object") {
    throw new Error("expected JSON output");
  }
  return output as { deliveryStatus?: DeliveryStatusLike };
}

async function deliverMediaReplyForTest(
  outboundSession: DeliverParams["outboundSession"],
  optsOverrides: Partial<AgentCommandOpts> = {},
) {
  // Media replies go through the same normalizer seam as production so relative
  // paths are interpreted with agent/session context before delivery.
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
      ...optsOverrides,
    } as AgentCommandOpts,
    outboundSession,
    sessionEntry: undefined,
    payloads: [{ text: "here you go", mediaUrls: ["./out/photo.png"] }],
    result: createResult(),
  });
}

describe("deliverAgentCommandResult payload normalization", () => {
  beforeEach(() => {
    setActivePluginRegistry(slackRegistry);
    deliverOutboundPayloadsMock.mockReset();
    deliverOutboundPayloadsMock.mockResolvedValue([]);
    createReplyMediaPathNormalizerMock.mockReset();
    createReplyMediaPathNormalizerMock.mockImplementation(
      (..._args: unknown[]) =>
        (payload: ReplyPayload) =>
          Promise.resolve(payload),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("keeps Slack directives in text for direct agent deliveries", async () => {
    // Direct CLI deliveries preserve Slack directive markup because no channel
    // adapter has consumed it yet.
    const delivered = await deliverAgentCommandResult({
      cfg: {
        channels: {
          slack: {
            capabilities: { interactiveReplies: true },
          },
        },
      } as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn() } as never,
      opts: { message: "test", channel: "slack" } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "Choose [[slack_buttons: Retry:retry]]" }],
      result: createResult(),
    });

    expect(delivered.payloads).toHaveLength(1);
    expectTextPayload(delivered.payloads[0], "Choose [[slack_buttons: Retry:retry]]");
  });

  it("rechecks delivery ownership after asynchronous payload preparation", async () => {
    let deliveryCurrent = true;
    createReplyMediaPathNormalizerMock.mockImplementationOnce(
      (..._args: unknown[]) =>
        async (payload: ReplyPayload): Promise<ReplyPayload> => {
          deliveryCurrent = false;
          return payload;
        },
    );

    await expect(
      deliverAgentCommandResult({
        cfg: {
          agents: {
            list: [{ id: "tester", workspace: "/tmp/agent-workspace" }],
          },
        } as OpenClawConfig,
        deps: {} as CliDeps,
        runtime: { log: vi.fn(), error: vi.fn() } as never,
        opts: {
          message: "go",
          deliver: true,
          replyChannel: "slack",
          replyTo: "#general",
        } as AgentCommandOpts,
        outboundSession: undefined,
        sessionEntry: undefined,
        payloads: [{ text: "result", mediaUrls: ["./out/photo.png"] }],
        result: createResult(),
        assertDeliveryCurrent: () => {
          if (!deliveryCurrent) {
            throw new Error("stale lifecycle");
          }
        },
      }),
    ).rejects.toThrow("stale lifecycle");
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
  });

  it("forwards the run abort signal into durable delivery", async () => {
    const controller = new AbortController();
    controller.abort(createAgentRunRestartAbortError());

    await deliverMediaReplyForTest(undefined, {
      abortSignal: controller.signal,
    });

    const deliverySignal = (
      deliverOutboundPayloadsMock.mock.calls[0]?.[0] as { abortSignal?: AbortSignal } | undefined
    )?.abortSignal;
    expect(deliverySignal).toBeInstanceOf(AbortSignal);
    expect(deliverySignal?.aborted).toBe(true);
    expect(deliverySignal?.reason).toBe(controller.signal.reason);
  });

  it("does not cancel final delivery for an ordinary run timeout", async () => {
    const controller = new AbortController();
    const timeoutError = new Error("run timed out");
    timeoutError.name = "TimeoutError";
    controller.abort(timeoutError);

    await deliverMediaReplyForTest(undefined, {
      abortSignal: controller.signal,
    });

    const deliverySignal = (
      deliverOutboundPayloadsMock.mock.calls[0]?.[0] as { abortSignal?: AbortSignal } | undefined
    )?.abortSignal;
    expect(deliverySignal).toBeInstanceOf(AbortSignal);
    expect(deliverySignal?.aborted).toBe(false);
  });

  it("cancels durable delivery when restart arrives before the durable intent", async () => {
    const controller = new AbortController();
    let deliverySignal: AbortSignal | undefined;
    deliverOutboundPayloadsMock.mockImplementationOnce(async (params: unknown) => {
      deliverySignal = (params as { abortSignal?: AbortSignal }).abortSignal;
      controller.abort(createAgentRunRestartAbortError());
      expect(deliverySignal?.aborted).toBe(true);
      throw deliverySignal?.reason;
    });

    await expect(
      deliverMediaReplyForTest(undefined, {
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("agent run aborted for restart");

    expect(deliverySignal?.reason).toBe(controller.signal.reason);
  });

  it("finishes durable delivery when restart arrives after the durable intent", async () => {
    const controller = new AbortController();
    let deliverySignal: AbortSignal | undefined;
    deliverOutboundPayloadsMock.mockImplementationOnce(async (params: unknown) => {
      const request = params as {
        abortSignal?: AbortSignal;
        onDeliveryIntent?: (intent: {
          id: string;
          channel: string;
          to: string;
          queuePolicy: "required";
        }) => void;
      };
      deliverySignal = request.abortSignal;
      request.onDeliveryIntent?.({
        id: "intent-after-restart",
        channel: "discord",
        to: "channel:123",
        queuePolicy: "required",
      });
      controller.abort(createAgentRunRestartAbortError());
      expect(deliverySignal?.aborted).toBe(false);
      return [{ channel: "discord", messageId: "sent-after-restart" }];
    });

    const result = await deliverMediaReplyForTest(undefined, {
      abortSignal: controller.signal,
    });

    expect(result.deliverySucceeded).toBe(true);
    expect(deliverySignal?.aborted).toBe(false);
  });

  it("renders response prefix templates with the selected runtime model", async () => {
    const delivered = await deliverAgentCommandResult({
      cfg: {
        channels: { slack: { responsePrefix: "[{modelFull}]" } },
      } as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn() } as never,
      opts: { message: "test", channel: "slack" } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "Ready." }],
      result: createResult({
        meta: {
          durationMs: 1,
          agentMeta: {
            sessionId: "session-1",
            provider: "openai",
            model: "gpt-5.4",
          },
        },
      }),
    });

    expect(delivered.payloads).toHaveLength(1);
    expectTextPayload(delivered.payloads[0], "[openai/gpt-5.4] Ready.");
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
    expect(delivered.payloads).toHaveLength(1);
    expectTextPayload(delivered.payloads[0], "Options: on, off.");
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

    const normalizerOptions = latestNormalizerOptions();
    expect(normalizerOptions.sessionKey).toBe("agent:tester:slack:direct:alice");
    expect(normalizerOptions.agentId).toBe("tester");
    expect(normalizerOptions.workspaceDir).toBe("/tmp/agent-workspace");
    expect(normalizerOptions.messageProvider).toBe("slack");

    const normalizedInput = normalizerFn.mock.calls[0]?.[0];
    expect(normalizedInput?.mediaUrls).toStrictEqual(["./out/photo.png"]);
    expect(deliverOutboundPayloadsMock).toHaveBeenCalledTimes(1);
    const deliverArgs = latestOutboundDeliveryArgs();
    expect(requirePayload(deliverArgs.payloads, 0).mediaUrls).toStrictEqual([
      "/tmp/agent-workspace/out/photo.png",
    ]);
  });

  it("reports successful requested delivery", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([]);

    const delivered = await deliverMediaReplyForTest({
      key: "agent:tester:slack:direct:alice",
      agentId: "tester",
    } as never);

    expect(delivered.deliverySucceeded).toBe(true);
    expectDeliveryStatusFields(delivered, {
      requested: true,
      attempted: true,
      status: "suppressed",
      succeeded: true,
      reason: "no_visible_result",
    });
  });

  it("refreshes stale implicit session routing before final delivery", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);
    const runtime = { log: vi.fn(), error: vi.fn() };
    const resolveFreshSessionEntryForDelivery = vi.fn(async () => ({
      sessionId: "session-1",
      updatedAt: 2,
      delivery: normalizeSessionDeliveryState({
        context: {
          channel: "slack",
          to: "#fresh",
          accountId: "workspace-1",
        },
      }),
    }));

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
        sessionKey: "agent:tester:main",
      } as AgentCommandOpts,
      outboundSession: {
        key: "agent:tester:main",
        agentId: "tester",
      } as never,
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: 1,
      },
      expectedSessionIdForFreshDelivery: "session-1",
      resolveFreshSessionEntryForDelivery,
      payloads: [{ text: "final answer" }],
      result: createResult(),
    });

    expect(resolveFreshSessionEntryForDelivery).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloadsMock).toHaveBeenCalledTimes(1);
    const deliverArgs = latestOutboundDeliveryArgs();
    expect(deliverArgs.channel).toBe("slack");
    expect(deliverArgs.to).toBe("#fresh");
    expect(deliverArgs.accountId).toBe("workspace-1");
    expect(delivered.deliverySucceeded).toBe(true);
    expectDeliveryStatusFields(delivered, {
      requested: true,
      attempted: true,
      status: "sent",
      succeeded: true,
      resultCount: 1,
    });
  });

  it("does not refresh final delivery routing from a different logical session", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);
    const runtime = { log: vi.fn(), error: vi.fn() };
    const resolveFreshSessionEntryForDelivery = vi.fn(async () => ({
      sessionId: "session-2",
      updatedAt: 2,
      delivery: normalizeSessionDeliveryState({
        context: {
          channel: "slack",
          to: "#fresh",
          accountId: "workspace-1",
        },
      }),
    }));

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
        sessionKey: "agent:tester:main",
      } as AgentCommandOpts,
      outboundSession: {
        key: "agent:tester:main",
        agentId: "tester",
      } as never,
      sessionEntry: {
        sessionId: "session-1",
        updatedAt: 1,
      },
      expectedSessionIdForFreshDelivery: "session-1",
      resolveFreshSessionEntryForDelivery,
      payloads: [{ text: "final answer" }],
      result: createResult(),
    });

    expect(resolveFreshSessionEntryForDelivery).toHaveBeenCalledTimes(1);
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
    expect(delivered.deliverySucceeded).toBe(false);
    expectDeliveryStatusFields(delivered, {
      requested: true,
      attempted: false,
      status: "failed",
      succeeded: false,
      reason: "channel_resolved_to_internal",
    });
  });

  it("does not report success when best-effort delivery records an error", async () => {
    deliverOutboundPayloadsMock.mockImplementationOnce(async (params: unknown) => {
      (
        params as {
          onError?: (err: unknown, payload: ReplyPayload) => void;
          onPayloadDeliveryOutcome?: (outcome: {
            index: number;
            payload: ReplyPayload;
            status: "failed";
            error: Error;
            stage: "send";
          }) => void;
        }
      ).onError?.(new Error("send failed"), { text: "here you go" });
      (
        params as {
          onPayloadDeliveryOutcome?: (outcome: {
            index: number;
            payload: ReplyPayload;
            status: "failed";
            error: Error;
            stage: "send";
          }) => void;
        }
      ).onPayloadDeliveryOutcome?.({
        index: 0,
        payload: { text: "here you go" },
        status: "failed",
        error: new Error("send failed"),
        stage: "send",
      });
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
    expectDeliveryStatusFields(delivered, {
      requested: true,
      attempted: true,
      status: "failed",
      succeeded: false,
      error: true,
    });
    expectRuntimeErrorIncludes(runtime, "send failed");
    const deliverArgs = latestOutboundDeliveryArgs();
    expect(deliverArgs.bestEffort).toBe(true);
    expect(deliverArgs.queuePolicy).toBe("best_effort");
  });

  it("threads agentId into the normalizer when sessionKey is unresolved", async () => {
    createReplyMediaPathNormalizerMock.mockReturnValue(async (payload: ReplyPayload) => payload);
    deliverOutboundPayloadsMock.mockResolvedValue([]);

    await deliverMediaReplyForTest({ agentId: "tester" } as never);

    const normalizerOptions = latestNormalizerOptions();
    expect(normalizerOptions.agentId).toBe("tester");
    expect(normalizerOptions.sessionKey).toBeUndefined();
    expect(normalizerOptions.workspaceDir).toBe("/tmp/agent-workspace");
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
    expect(delivered.payloads).toHaveLength(1);
    expectTextPayload(
      delivered.payloads[0],
      "[[buttons: Release menu | Choose an action | Retry:retry, Ignore:ignore]]",
    );
  });

  it("preserves committed message-tool delivery evidence when automatic delivery is disabled", async () => {
    const runtime = { log: vi.fn(), error: vi.fn() };

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: runtime as never,
      opts: {
        message: "completion handoff",
        deliver: false,
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [],
      result: {
        ...createResult(),
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["The image is ready."],
        messagingToolSentMediaUrls: ["/tmp/generated-image.png"],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "telegram",
            to: "telegram:-100123",
            threadId: "22",
            text: "The image is ready.",
            mediaUrls: ["/tmp/generated-image.png"],
          },
        ],
      } as RunResult,
    });

    expect(delivered.didSendViaMessagingTool).toBe(true);
    expect(delivered.messagingToolSentTexts).toEqual(["The image is ready."]);
    expect(delivered.messagingToolSentMediaUrls).toEqual(["/tmp/generated-image.png"]);
    expect(delivered.messagingToolSentTargets).toEqual([
      {
        tool: "message",
        provider: "telegram",
        to: "telegram:-100123",
        threadId: "22",
        text: "The image is ready.",
        mediaUrls: ["/tmp/generated-image.png"],
      },
    ]);
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
  });

  it("does not automatically redeliver text and media already sent to the same target", async () => {
    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
        threadId: "171.222",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "The image is ready.", mediaUrls: ["/tmp/generated-image.png"] }],
      result: {
        ...createResult(),
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["The image is ready."],
        messagingToolSentMediaUrls: ["/tmp/generated-image.png"],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            threadId: "171.222",
            text: "The image is ready.",
            mediaUrls: ["/tmp/generated-image.png"],
          },
        ],
      } as RunResult,
    });

    expect(delivered.payloads).toEqual([]);
    expect(delivered.deliverySucceeded).toBe(true);
    expectDeliveryStatusFields(delivered, {
      requested: true,
      attempted: false,
      status: "suppressed",
      succeeded: true,
      reason: "no_visible_payload",
    });
    expect(delivered.messagingToolSentMediaUrls).toEqual(["/tmp/generated-image.png"]);
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
  });

  it("preserves duplicate media needed for a delivery operation", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);
    const delivery = { pin: { enabled: true, required: true } };

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ mediaUrls: ["/tmp/generated-image.png"], delivery }] as never,
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            mediaUrls: ["/tmp/generated-image.png"],
          },
        ],
      } as RunResult,
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expect(latestOutboundDeliveryArgs().payloads).toEqual([
      expect.objectContaining({
        mediaUrls: ["/tmp/generated-image.png"],
        delivery,
      }),
    ]);
  });

  it("drops audioAsVoice when its media was already delivered", async () => {
    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ mediaUrls: ["/tmp/voice.ogg"], audioAsVoice: true }],
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            mediaUrls: ["/tmp/voice.ogg"],
          },
        ],
      } as RunResult,
    });

    expect(delivered.payloads).toEqual([]);
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
  });

  it("dedupes delivered file media before normalization can add a failure warning", async () => {
    createReplyMediaPathNormalizerMock.mockImplementationOnce(
      (..._args: unknown[]) =>
        async (payload: ReplyPayload): Promise<ReplyPayload> => ({
          ...payload,
          text: `${payload.text ?? ""}\n⚠️ Media failed.`,
          mediaUrl: undefined,
          mediaUrls: undefined,
        }),
    );

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "The image is ready.", mediaUrls: ["file:///tmp/generated-image.png"] }],
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            text: "The image is ready.",
            mediaUrls: ["file:///tmp/generated-image.png"],
          },
        ],
      } as RunResult,
    });

    expect(delivered.payloads).toEqual([]);
    expect(createReplyMediaPathNormalizerMock).not.toHaveBeenCalled();
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
  });

  it("dedupes media encoded in a final MEDIA directive", async () => {
    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "MEDIA:/tmp/generated-image.png" }],
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            mediaUrls: ["/tmp/generated-image.png"],
          },
        ],
      } as RunResult,
    });

    expect(delivered.payloads).toEqual([]);
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
  });

  it("keeps unsent media when only the matching text was already delivered", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
        threadId: "171.222",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "The image is ready.", mediaUrls: ["/tmp/generated-image.png"] }],
      result: {
        ...createResult(),
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["The image is ready."],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            threadId: "171.222",
            text: "The image is ready.",
          },
        ],
      } as RunResult,
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expect(latestOutboundDeliveryArgs().payloads).toEqual([
      expect.objectContaining({
        text: "",
        mediaUrls: ["/tmp/generated-image.png"],
      }),
    ]);
  });

  it("dedupes sent text after applying the delivery response prefix", async () => {
    const delivered = await deliverAgentCommandResult({
      cfg: {
        channels: { slack: { responsePrefix: "Bot:" } },
      } as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "Ready" }],
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            text: "Ready",
          },
        ],
      } as RunResult,
    });

    expect(delivered.payloads).toEqual([]);
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
  });

  it("does not add unresolved dynamic prefixes to message-tool evidence", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);

    const delivered = await deliverAgentCommandResult({
      cfg: {
        channels: { slack: { responsePrefix: "[{modelFull}]" } },
      } as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "Ready" }],
      result: {
        ...createResult({
          meta: {
            durationMs: 1,
            agentMeta: { provider: "openai", model: "gpt-5.4" },
          } as RunResult["meta"],
        }),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            text: "Ready",
          },
        ],
      } as RunResult,
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expect(latestOutboundDeliveryArgs().payloads).toEqual([
      expect.objectContaining({ text: "[openai/gpt-5.4] Ready" }),
    ]);
  });

  it("dedupes exact short text on a confirmed matching route", async () => {
    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "Ready" }],
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            text: "Ready",
          },
        ],
      } as RunResult,
    });

    expect(delivered.payloads).toEqual([]);
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
  });

  it("dedupes visible text after parsing a final reply directive", async () => {
    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "[[reply_to_current]] Ready" }],
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            text: "Ready",
          },
        ],
      } as RunResult,
    });

    expect(delivered.payloads).toEqual([]);
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
  });

  it("does not apply ambiguous global evidence across message-tool targets", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "Ready", mediaUrls: ["/tmp/generated-image.png"] }],
      result: {
        ...createResult(),
        messagingToolSentTexts: ["Ready"],
        messagingToolSentMediaUrls: ["/tmp/generated-image.png"],
        messagingToolSentTargets: [
          { tool: "message", provider: "slack", to: "channel:C123" },
          { tool: "message", provider: "slack", to: "channel:C999" },
        ],
      } as RunResult,
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expect(latestOutboundDeliveryArgs().payloads).toEqual([
      expect.objectContaining({
        text: "Ready",
        mediaUrls: ["/tmp/generated-image.png"],
      }),
    ]);
  });

  it("preserves final text that extends a message-tool send", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "The image is ready. Dimensions are 1024x1024." }],
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            text: "The image is ready.",
          },
        ],
      } as RunResult,
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expect(latestOutboundDeliveryArgs().payloads).toEqual([
      expect.objectContaining({
        text: "The image is ready. Dimensions are 1024x1024.",
      }),
    ]);
  });

  it.each([
    { name: "emoji", sentText: "❌ Failed", finalText: "✅ Failed" },
    { name: "letter case", sentText: "US", finalText: "us" },
    {
      name: "significant whitespace",
      sentText: "const x = 1;\n  return x;",
      finalText: "const x = 1;\n return x;",
    },
  ])("preserves $name differences in exact replies", async ({ sentText, finalText }) => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: finalText }],
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            text: sentText,
          },
        ],
      } as RunResult,
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expect(latestOutboundDeliveryArgs().payloads).toEqual([
      expect.objectContaining({ text: finalText }),
    ]);
  });

  it("matches dedupe against the command thread instead of payload reply metadata", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
        threadId: "thread-a",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "The image is ready.", replyToId: "thread-b" }],
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            threadId: "thread-b",
            text: "The image is ready.",
          },
        ],
      } as RunResult,
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expect(deliverOutboundPayloadsMock).toHaveBeenCalledTimes(1);
    expect(latestOutboundDeliveryArgs().replyToId).toBe("thread-a");
  });

  it("keeps presentation content when only the matching text was already delivered", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);
    const presentation = {
      blocks: [{ type: "buttons" as const, buttons: [{ label: "Open", value: "open" }] }],
    };

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "The image is ready.", presentation }] as never,
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            text: "The image is ready.",
          },
        ],
      } as RunResult,
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expect(latestOutboundDeliveryArgs().payloads).toEqual([
      expect.objectContaining({
        text: "",
        presentation,
      }),
    ]);
  });

  it("keeps location content when only the matching text was already delivered", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);
    const location = { latitude: 48.858844, longitude: 2.294351 };

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "The image is ready.", location }] as never,
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            text: "The image is ready.",
          },
        ],
      } as RunResult,
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expect(latestOutboundDeliveryArgs().payloads).toEqual([
      expect.objectContaining({
        text: "",
        location,
      }),
    ]);
  });

  it("keeps BTW content when the base text was already delivered", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "The image is ready.", btw: { question: "What changed?" } }] as never,
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            text: "The image is ready.",
          },
        ],
      } as RunResult,
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expect(latestOutboundDeliveryArgs().payloads).toEqual([
      expect.objectContaining({
        text: "BTW\nQuestion: What changed?\n\nThe image is ready.",
      }),
    ]);
  });

  it("keeps delivery operations when the base text was already delivered", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);
    const delivery = { pin: { enabled: true, required: true } };

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "Ready", delivery }] as never,
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            text: "Ready",
          },
        ],
      } as RunResult,
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expect(latestOutboundDeliveryArgs().payloads).toEqual([
      expect.objectContaining({ text: "Ready", delivery }),
    ]);
  });

  it.each([{ delivery: { pin: false } }, { delivery: { pin: { enabled: false } } }])(
    "dedupes text for disabled delivery metadata: $delivery",
    async ({ delivery }) => {
      const delivered = await deliverAgentCommandResult({
        cfg: {} as OpenClawConfig,
        deps: {} as CliDeps,
        runtime: { log: vi.fn(), error: vi.fn() } as never,
        opts: {
          message: "completion handoff",
          deliver: true,
          replyChannel: "slack",
          replyTo: "channel:C123",
        } as AgentCommandOpts,
        outboundSession: undefined,
        sessionEntry: undefined,
        payloads: [{ text: "Ready", delivery }] as never,
        result: {
          ...createResult(),
          messagingToolSentTargets: [
            {
              tool: "message",
              provider: "slack",
              to: "channel:C123",
              text: "Ready",
            },
          ],
        } as RunResult,
      });

      expect(delivered.payloads).toEqual([]);
      expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
    },
  );

  it("does not dedupe an explicit send from a different account against the default account", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "Ready" }],
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            accountId: "work",
            to: "channel:C123",
            text: "Ready",
          },
        ],
      } as RunResult,
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expect(deliverOutboundPayloadsMock).toHaveBeenCalledTimes(1);
    expect(latestOutboundDeliveryArgs().accountId).toBe("default");
  });

  it("does not dedupe accountless default-account evidence against an explicit account", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
        replyAccountId: "work",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "Ready" }],
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            text: "Ready",
          },
        ],
      } as RunResult,
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expect(deliverOutboundPayloadsMock).toHaveBeenCalledTimes(1);
    expect(latestOutboundDeliveryArgs().accountId).toBe("work");
  });

  it("dedupes accountless evidence against the non-default run account", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
        replyAccountId: "work",
        runContext: {
          messageChannel: "slack",
          currentChannelId: "channel:C123",
          accountId: "work",
        },
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "Ready" }],
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            text: "Ready",
          },
        ],
      } as RunResult,
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
  });

  it("does not dedupe accountless source evidence against an explicit cross-account delivery", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
        replyAccountId: "other",
        runContext: {
          messageChannel: "slack",
          currentChannelId: "channel:C123",
          accountId: "work",
        },
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "Ready" }],
      result: {
        ...createResult(),
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:C123",
            text: "Ready",
          },
        ],
      } as RunResult,
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expect(deliverOutboundPayloadsMock).toHaveBeenCalledTimes(1);
    expect(latestOutboundDeliveryArgs().accountId).toBe("other");
  });

  it("does not dedupe targetless cross-session messaging evidence", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "The image is ready." }],
      result: {
        ...createResult(),
        didSendViaMessagingTool: true,
        messagingToolSentTexts: ["The image is ready."],
      } as RunResult,
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expect(deliverOutboundPayloadsMock).toHaveBeenCalledTimes(1);
    expect(latestOutboundDeliveryArgs().payloads).toEqual([
      expect.objectContaining({ text: "The image is ready." }),
    ]);
  });

  it("keeps automatic delivery when message-tool media went to another target", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "completion handoff",
        deliver: true,
        replyChannel: "slack",
        replyTo: "channel:C123",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "The image is ready.", mediaUrls: ["/tmp/generated-image.png"] }],
      result: {
        ...createResult(),
        messagingToolSentTexts: ["The image is ready."],
        messagingToolSentMediaUrls: ["/tmp/generated-image.png"],
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "slack",
            to: "channel:OTHER",
            text: "The image is ready.",
            mediaUrls: ["/tmp/generated-image.png"],
          },
        ],
      } as RunResult,
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expect(deliverOutboundPayloadsMock).toHaveBeenCalledTimes(1);
    expect(latestOutboundDeliveryArgs().payloads).toEqual([
      expect.objectContaining({
        text: "The image is ready.",
        mediaUrls: ["/tmp/generated-image.png"],
      }),
    ]);
  });

  it("adds sent deliveryStatus to JSON output after delivery completes", async () => {
    deliverOutboundPayloadsMock.mockResolvedValue([{ channel: "slack", messageId: "msg-1" }]);
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
    };

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
        json: true,
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

    expect(runtime.writeJson).toHaveBeenCalledTimes(1);
    const json = latestJsonOutput(runtime);
    expect(json.deliveryStatus).toEqual({
      requested: true,
      attempted: true,
      status: "sent",
      succeeded: true,
      resultCount: 1,
    });
    expect(delivered.deliverySucceeded).toBe(true);
    expect(delivered.deliveryStatus?.status).toBe("sent");
  });

  it("surfaces hook cancellation as a suppressed terminal deliveryStatus", async () => {
    deliverOutboundPayloadsMock.mockImplementationOnce(async (params: unknown) => {
      (
        params as {
          onPayloadDeliveryOutcome?: (outcome: {
            index: number;
            status: "suppressed";
            reason: "cancelled_by_message_sending_hook";
            hookEffect: { cancelReason: string };
          }) => void;
        }
      ).onPayloadDeliveryOutcome?.({
        index: 0,
        status: "suppressed",
        reason: "cancelled_by_message_sending_hook",
        hookEffect: { cancelReason: "owned-by-other-agent" },
      });
      return [];
    });

    const delivered = await deliverMediaReplyForTest({
      key: "agent:tester:slack:direct:alice",
      agentId: "tester",
    } as never);

    expect(delivered.deliverySucceeded).toBe(true);
    const status = expectDeliveryStatusFields(delivered, {
      requested: true,
      attempted: true,
      status: "suppressed",
      succeeded: true,
      reason: "cancelled_by_message_sending_hook",
    });
    expect(status.payloadOutcomes).toEqual([
      {
        index: 0,
        status: "suppressed",
        reason: "cancelled_by_message_sending_hook",
        hookEffect: { cancelReason: "owned-by-other-agent" },
      },
    ]);
  });

  it("surfaces durable partial failures without clearing delivery retry state", async () => {
    deliverOutboundPayloadsMock.mockImplementationOnce(async (params: unknown) => {
      (
        params as {
          onPayloadDeliveryOutcome?: (outcome: {
            index: number;
            status: "failed";
            error: Error;
            sentBeforeError: true;
            stage: "platform_send";
          }) => void;
        }
      ).onPayloadDeliveryOutcome?.({
        index: 1,
        status: "failed",
        error: new Error("second chunk failed"),
        sentBeforeError: true,
        stage: "platform_send",
      });
      return [{ channel: "slack", messageId: "msg-1" }];
    });

    const delivered = await deliverMediaReplyForTest(
      {
        key: "agent:tester:slack:direct:alice",
        agentId: "tester",
      } as never,
      { bestEffortDeliver: true },
    );

    expect(delivered.deliverySucceeded).toBe(false);
    const status = expectDeliveryStatusFields(delivered, {
      requested: true,
      attempted: true,
      status: "partial_failed",
      succeeded: "partial",
      error: true,
      resultCount: 1,
      sentBeforeError: true,
    });
    expect(String(status.errorMessage)).toContain("second chunk failed");
    expect(status.payloadOutcomes).toHaveLength(1);
    const outcome = status.payloadOutcomes?.[0];
    expect(outcome?.index).toBe(1);
    expect(outcome?.status).toBe("failed");
    expect(String(outcome?.error)).toContain("second chunk failed");
    expect(outcome?.sentBeforeError).toBe(true);
    expect(outcome?.stage).toBe("platform_send");
  });

  it("marks no-payload deliveryStatus as terminal delivery success", async () => {
    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "go",
        deliver: true,
        replyChannel: "slack",
        replyTo: "#general",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [],
      result: createResult(),
    });

    expect(delivered.deliverySucceeded).toBe(true);
    expectDeliveryStatusFields(delivered, {
      requested: true,
      attempted: false,
      status: "suppressed",
      succeeded: true,
      reason: "no_visible_payload",
    });
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
  });

  it("surfaces no-visible-payload deliveryStatus after payload normalization suppresses output", async () => {
    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: { log: vi.fn(), error: vi.fn() } as never,
      opts: {
        message: "go",
        deliver: true,
        replyChannel: "slack",
        replyTo: "#general",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [{ text: "NO_REPLY" }],
      result: createResult(),
    });

    expect(delivered.payloads).toEqual([]);
    expect(delivered.deliverySucceeded).toBe(true);
    expectDeliveryStatusFields(delivered, {
      requested: true,
      attempted: false,
      status: "suppressed",
      succeeded: true,
      reason: "no_visible_payload",
    });
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
  });

  it("preserves preflight deliveryStatus when best-effort delivery has no payloads", async () => {
    const runtime = { log: vi.fn(), error: vi.fn() };

    const delivered = await deliverAgentCommandResult({
      cfg: {} as OpenClawConfig,
      deps: {} as CliDeps,
      runtime: runtime as never,
      opts: {
        message: "go",
        deliver: true,
        bestEffortDeliver: true,
        replyChannel: "not-installed",
        replyTo: "#general",
      } as AgentCommandOpts,
      outboundSession: undefined,
      sessionEntry: undefined,
      payloads: [],
      result: createResult(),
    });

    expect(delivered.deliverySucceeded).toBeUndefined();
    expectDeliveryStatusFields(delivered, {
      requested: true,
      attempted: false,
      status: "failed",
      succeeded: false,
      error: true,
      reason: "unknown_channel",
    });
    expectRuntimeErrorIncludes(runtime, "Unknown channel");
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
  });

  it("emits JSON deliveryStatus before strict delivery failures rethrow", async () => {
    deliverOutboundPayloadsMock.mockRejectedValueOnce(new Error("Slack API timeout"));
    const onDeliveryResult = vi.fn();
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
    };

    await expect(
      deliverAgentCommandResult({
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
          json: true,
          bestEffortDeliver: false,
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
        onDeliveryResult,
      }),
    ).rejects.toThrow("Slack API timeout");

    expect(runtime.writeJson).toHaveBeenCalledTimes(1);
    const json = latestJsonOutput(runtime);
    expect(json.deliveryStatus?.requested).toBe(true);
    expect(json.deliveryStatus?.attempted).toBe(true);
    expect(json.deliveryStatus?.status).toBe("failed");
    expect(json.deliveryStatus?.succeeded).toBe(false);
    expect(json.deliveryStatus?.error).toBe(true);
    expect(String(json.deliveryStatus?.errorMessage)).toContain("Slack API timeout");
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryStatus: expect.objectContaining({ status: "failed" }),
      }),
    );
  });

  it("emits JSON deliveryStatus before strict preflight failures rethrow", async () => {
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
    };
    deliverOutboundPayloadsMock.mockClear();

    await expect(
      deliverAgentCommandResult({
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
          json: true,
          bestEffortDeliver: false,
          replyChannel: "not-installed",
          replyTo: "#general",
        } as AgentCommandOpts,
        outboundSession: {
          key: "agent:tester:not-installed:direct:alice",
          agentId: "tester",
        } as never,
        sessionEntry: undefined,
        payloads: [{ text: "here you go", mediaUrls: ["./out/photo.png"] }],
        result: createResult(),
      }),
    ).rejects.toThrow("Unknown channel: not-installed");

    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
    expect(createReplyMediaPathNormalizerMock).not.toHaveBeenCalled();
    expect(runtime.writeJson).toHaveBeenCalledTimes(1);
    const json = latestJsonOutput(runtime);
    expect(json.deliveryStatus).toEqual({
      requested: true,
      attempted: false,
      status: "failed",
      succeeded: false,
      error: true,
      reason: "unknown_channel",
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
