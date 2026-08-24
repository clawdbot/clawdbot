// Tests /steer target capture, accepted delivery, and visible fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import type { ReplyBackendQueueMessageOptions, ReplyOperation } from "./reply-run-registry.js";
import { createReplyOperation } from "./reply-run-registry.js";
import {
  createFollowupRunToolAuthorityProjector,
  resolveFollowupRunToolAuthorityFingerprint,
} from "./reply-tool-authority.js";
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
  const toolAuthorityFingerprint = resolveFollowupRunToolAuthorityFingerprint(
    authorityRun,
    authorityRoute,
  );
  operation.bindToolAuthorityProjector(createFollowupRunToolAuthorityProjector(authorityRun));
  operation.bindToolAuthorityRoute(authorityRoute);
  operation.bindToolAuthorityFingerprint(toolAuthorityFingerprint);
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

  it("matching authority /steer injects into the captured operation", async () => {
    const params = buildParams("/steer keep going");
    params.opts = { toolsAllow: ["read"] };
    const { toolAuthorityFingerprint } = beginActiveOperation(
      "agent:main:main",
      "session-active",
      undefined,
      createCommandAuthorityRun(params),
    );

    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "steered current session." },
    });
    expect(queueMessage).toHaveBeenCalledWith("keep going", {
      steeringMode: "all",
      isInboundUserMessage: true,
      toolAuthorityFingerprint,
      debounceMs: 0,
      taskSuggestionDeliveryMode: undefined,
      onQueueAccepted: expect.any(Function),
    });
  });

  it("authorized sender with mismatched tool authority cannot inject via /steer", async () => {
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

    expect(result).toEqual({ shouldContinue: true });
    expect(params.ctx.BodyForAgent).toBe("keep going");
    expect(params.command.commandBodyNormalized).toBe("keep going");
    expect(queueMessage).not.toHaveBeenCalled();
  });

  it("passes the initiating surface task capability into steering", async () => {
    beginActiveOperation("agent:main:main", "session-active", "gateway");
    const params = buildParams("/steer keep going");
    params.opts = { taskSuggestionDeliveryMode: "gateway" };

    await handleSteerCommand(params, true);

    expect(queueMessage).toHaveBeenCalledWith(
      "keep going",
      expect.objectContaining({ taskSuggestionDeliveryMode: "gateway" }),
    );
  });

  it("prefers the native command target over the slash-command source", async () => {
    beginActiveOperation("agent:main:discord:direct:target", "session-target");
    const params = buildParams("/steer check the target");
    params.ctx.CommandSource = "native";
    params.ctx.CommandTargetSessionKey = "agent:main:discord:direct:target";
    params.sessionKey = "agent:main:discord:slash:user";

    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "steered current session." },
    });
    expect(queueMessage).toHaveBeenCalledWith("check the target", expect.any(Object));
  });

  it("maps a text slash source lane to its active direct conversation", async () => {
    beginActiveOperation("agent:main:telegram:direct:123", "session-direct-active");
    const params = buildParams("/steer use the active direct lane");
    params.sessionKey = "agent:main:telegram:slash:123";

    await handleSteerCommand(params, true);

    expect(queueMessage).toHaveBeenCalledWith("use the active direct lane", expect.any(Object));
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

  it("continues visibly as a normal prompt when captured injection rejects", async () => {
    beginActiveOperation("agent:main:main");
    queueMessage.mockRejectedValueOnce(new Error("runtime rejected"));
    const params = buildParams("/steer keep going");

    const result = await handleSteerCommand(params, true);

    expect(result).toEqual({ shouldContinue: true });
    expect(params.ctx.BodyForAgent).toBe("keep going");
    expect(params.command.commandBodyNormalized).toBe("keep going");
  });
});
