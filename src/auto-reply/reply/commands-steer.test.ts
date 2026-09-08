// Tests /steer target capture, prepared-path continuation, and visible fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import type { ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import type { ReplyBackendQueueMessageOptions, ReplyOperation } from "./reply-run-registry.js";
import { createReplyOperation } from "./reply-run-registry.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { createMockFollowupRun } from "./test-helpers.js";

const { handleSteerCommand } = await import("./commands-steer.js");

const baseCfg = {
  commands: { text: true },
  session: { mainKey: "main", scope: "per-sender" },
} as OpenClawConfig;
const queueMessage = vi.fn(
  async (_text: string, _options?: ReplyBackendQueueMessageOptions) => undefined,
);
const operations: ReplyOperation[] = [];

function buildParams(commandBody: string) {
  return buildCommandTestParams(commandBody, baseCfg);
}

function beginActiveOperation(
  sessionKey: string,
  sessionId = "session-active",
  taskSuggestionDeliveryMode?: "gateway",
  authorityRun = createMockFollowupRun({ run: { sessionId, sessionKey } }),
) {
  const operation = createReplyOperation({ sessionKey, sessionId, resetTriggered: false });
  const authorityRoute = {
    provider: authorityRun.run.provider,
    model: authorityRun.run.model,
  };
  operation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(authorityRun));
  const toolAuthorityFingerprint = operation.bindToolAuthorityRoute(authorityRoute);
  operation.setPhase("running");
  operation.attachBackend({
    kind: "embedded",
    cancel: vi.fn(),
    taskSuggestionDeliveryMode,
    messageInjection: { isAvailable: () => true, queueMessage },
  });
  operations.push(operation);
  return { operation, toolAuthorityFingerprint };
}

function createCommandAuthorityRun(params: ReturnType<typeof buildParams>) {
  return createMockFollowupRun({
    originatingChannel: params.ctx.OriginatingChannel,
    toolsAllow: params.opts?.toolsAllow,
    disableTools: params.opts?.disableTools,
    run: {
      agentId: params.agentId ?? "main",
      agentDir: params.agentDir ?? "/tmp/agent",
      sessionId: "session-active",
      sessionKey: params.sessionKey,
      messageProvider: params.ctx.OriginatingChannel ?? params.ctx.Provider ?? params.ctx.Surface,
      chatType: params.ctx.ChatType as ChatType | undefined,
      agentAccountId: params.ctx.AccountId,
      conversationToolPolicy: params.ctx.ConversationToolPolicy,
      groupId: undefined,
      groupChannel: undefined,
      groupSpace: undefined,
      memberRoleIds: params.ctx.MemberRoleIds,
      spawnedBy: params.sessionEntry?.spawnedBy,
      senderId: params.ctx.SenderId,
      senderName: params.ctx.SenderName,
      senderUsername: params.ctx.SenderUsername,
      senderE164: params.ctx.SenderE164,
      senderIsOwner: params.command.senderIsOwner,
      traceAuthorized:
        params.command.senderIsOwner ||
        (params.ctx.GatewayClientScopes ?? []).includes("operator.admin"),
      approvalReviewerDeviceId: params.ctx.ApprovalReviewerDeviceId,
      clientCaps: params.ctx.GatewayClientCaps,
      toolBindings: params.ctx.GatewayRunToolBindings,
      inputProvenance: params.ctx.InputProvenance,
      workspaceDir: params.workspaceDir,
      config: params.cfg,
      toolOverrides: params.sessionEntry?.toolOverrides,
      provider: params.provider,
      model: params.model,
    },
  });
}

describe("handleSteerCommand", () => {
  beforeEach(() => queueMessage.mockReset().mockResolvedValue(undefined));

  afterEach(() => {
    for (const operation of operations.splice(0)) {
      operation.complete();
    }
  });

  it("routes an active /steer through the prepared reply path without a premature ack", async () => {
    const params = buildParams("/steer keep going");
    params.opts = { toolsAllow: ["read"] };
    const { toolAuthorityFingerprint } = beginActiveOperation(
      "agent:main:main",
      "session-active",
      undefined,
      createCommandAuthorityRun(params),
    );

    const result = await handleSteerCommand(params, true);

    expect(toolAuthorityFingerprint).toEqual(expect.any(String));
    expect(result).toEqual({ shouldContinue: true, queueModeOverride: "steer" });
    expect(params.ctx.BodyForAgent).toBe("keep going");
    expect(params.command.commandBodyNormalized).toBe("keep going");
    // Injection now happens only after the normal path has prepared durable
    // transcript, identity, media, cancellation, and adoption ownership.
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("defers tool-authority admission to the prepared steer path", async () => {
    const activeParams = buildParams("/steer keep going");
    activeParams.opts = { toolsAllow: ["exec"] };
    beginActiveOperation(
      "agent:main:main",
      "session-active",
      undefined,
      createCommandAuthorityRun(activeParams),
    );
    const params = buildParams("/steer keep going");
    params.opts = { toolsAllow: ["read"] };

    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({ shouldContinue: true, queueModeOverride: "steer" });
    expect(params.ctx.BodyForAgent).toBe("keep going");
    expect(params.command.commandBodyNormalized).toBe("keep going");
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("keeps initiating surface options for prepared steering", async () => {
    beginActiveOperation("agent:main:main", "session-active", "gateway");
    const params = buildParams("/steer keep going");
    params.opts = { taskSuggestionDeliveryMode: "gateway" };

    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({ shouldContinue: true, queueModeOverride: "steer" });
    expect(params.opts.taskSuggestionDeliveryMode).toBe("gateway");
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("prefers the native command target over the slash-command source", async () => {
    beginActiveOperation("agent:main:discord:direct:target", "session-target");
    const params = buildParams("/steer check the target");
    params.ctx.CommandSource = "native";
    params.ctx.CommandTargetSessionKey = "agent:main:discord:direct:target";
    params.sessionKey = "agent:main:discord:slash:user";

    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({ shouldContinue: true, queueModeOverride: "steer" });
    expect(params.ctx.BodyForAgent).toBe("check the target");
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("maps a text slash source lane to its active direct conversation", async () => {
    beginActiveOperation("agent:main:telegram:direct:123", "session-direct-active");
    const params = buildParams("/steer use the active direct lane");
    params.sessionKey = "agent:main:telegram:slash:123";

    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({ shouldContinue: true, queueModeOverride: "steer" });
    expect(params.ctx.BodyForAgent).toBe("use the active direct lane");
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("maps a text slash source lane after its active embedded owner's operation clears", async () => {
    const sessionId = "session-direct-active";
    const sessionKey = "agent:main:telegram:direct:123";
    const handle = {
      kind: "embedded" as const,
      queueMessage: vi.fn(),
      isStreaming: () => true,
      isCompacting: () => false,
      abort: vi.fn(),
    };
    setActiveEmbeddedRun(sessionId, handle, sessionKey);
    try {
      const params = buildParams("/steer use the active direct lane");
      params.sessionKey = "agent:main:telegram:slash:123";

      const result = await handleSteerCommand(params, true);

      expect(result).toEqual({ shouldContinue: true, queueModeOverride: "steer" });
      expect(params.ctx.BodyForAgent).toBe("use the active direct lane");
    } finally {
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    }
  });

  it("returns usage for an empty steer command", async () => {
    const result = await handleSteerCommand(buildParams("/steer"), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "Usage: /steer <message>" },
    });
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("continues visibly as a normal prompt when no direct owner is active", async () => {
    const params = buildParams("/steer keep going");
    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({ shouldContinue: true });
    expect(params.ctx.Body).toBe("keep going");
    expect(params.ctx.BodyForAgent).toBe("keep going");
    expect(params.command.commandBodyNormalized).toBe("keep going");
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("does not contact the backend before prepared admission", async () => {
    beginActiveOperation("agent:main:main");
    const params = buildParams("/steer keep going");

    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({ shouldContinue: true, queueModeOverride: "steer" });
    expect(params.ctx.BodyForAgent).toBe("keep going");
    expect(params.command.commandBodyNormalized).toBe("keep going");
    expect(queueMessage).not.toHaveBeenCalled();
  });
});
