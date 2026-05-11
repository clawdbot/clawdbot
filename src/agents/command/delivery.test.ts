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

type NormalizeParams = Parameters<typeof normalizeAgentCommandReplyPayloads>[0];
type RunResult = NormalizeParams["result"];
type DeliverParams = Parameters<typeof deliverAgentCommandResult>[0];
type TextPayloadLike = { text?: unknown };
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

function latestNormalizerOptions(): MediaNormalizerOptions {
  const options = createReplyMediaPathNormalizerMock.mock.calls.at(-1)?.[0];
  if (!options || typeof options !== "object") {
    throw new Error("expected media normalizer options");
  }
  return options as MediaNormalizerOptions;
}

function latestOutboundDeliveryArgs(): {
  payloads: ReplyPayload[];
  bestEffort?: boolean;
  queuePolicy?: string;
} {
  const args = deliverOutboundPayloadsMock.mock.calls.at(-1)?.[0];
  if (!args || typeof args !== "object") {
    throw new Error("expected outbound delivery arguments");
  }
  return args as { payloads: ReplyPayload[]; bestEffort?: boolean; queuePolicy?: string };
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
  expect(runtime.error.mock.calls.some(([message]) => String(message).includes(text))).toBe(true);
}

function latestJsonOutput(runtime: { writeJson: { mock: { calls: Array<Array<unknown>> } } }) {
  const output = runtime.writeJson.mock.calls.at(-1)?.[0];
  if (!output || typeof output !== "object") {
    throw new Error("expected JSON output");
  }
  return output as { deliveryStatus?: DeliveryStatusLike };
}

async function deliverMediaReplyForTest(
  outboundSession: DeliverParams["outboundSession"],
  optsOverrides: Partial<AgentCommandOpts> = {},
) {
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

describe("normalizeAgentCommandReplyPayloads", () => {
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

    expect(normalized).toHaveLength(1);
    expectTextPayload(normalized[0], "Choose [[slack_buttons: Retry:retry]]");
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

    expect(normalized).toHaveLength(1);
    expectTextPayload(normalized[0], "[openai-codex/gpt-5.4] Ready.");
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

    const normalizedInput = normalizerFn.mock.calls.at(0)?.[0];
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
    expect(delivered.meta.durationMs).toBe(1);
    expect(delivered.meta.transport).toBe("embedded");
    expect(delivered.meta.fallbackFrom).toBe("gateway");
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
