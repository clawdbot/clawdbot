import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { handleUpdateCommand } from "./commands-update.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

const { dispatch, callGatewayTool, readChannelContextGatewayContextResolver, host } = vi.hoisted(
  () => ({
    dispatch: vi.fn(),
    callGatewayTool: vi.fn(),
    readChannelContextGatewayContextResolver: vi.fn(),
    host: { context: {} as GatewayRequestContext | undefined },
  }),
);
vi.mock("../../agents/tools/gateway.js", () => ({ callGatewayTool }));
vi.mock("../../channels/message-access/admission-evidence.js", () => ({
  readChannelContextGatewayContextResolver,
}));
vi.mock("../../gateway/server-plugins.js", () => ({
  dispatchGatewayMethodInProcess: dispatch,
  getInProcessGatewayRequestContext: (resolve?: () => GatewayRequestContext | undefined) =>
    resolve ? resolve() : host.context,
  hasInProcessGatewayContext: (resolve?: () => GatewayRequestContext | undefined) =>
    Boolean(resolve ? resolve() : host.context),
}));
vi.mock("../../globals.js", () => ({ logVerbose: vi.fn() }));

function updateCommandParams(): HandleCommandsParams {
  return {
    ctx: {},
    cfg: {},
    agentId: "main",
    command: {
      surface: "telegram",
      channel: "telegram",
      ownerList: [],
      senderIsOwner: true,
      isAuthorizedSender: true,
      senderId: "owner",
      rawBodyNormalized: "/update",
      commandBodyNormalized: "/update",
    },
    directives: parseInlineSessionDirectives(""),
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey: "agent:main:telegram:direct:owner:thread:topic",
    workspaceDir: "/tmp",
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "openai",
    model: "gpt-5.6-luna",
    contextTokens: 0,
    isGroup: false,
  };
}

describe("handleUpdateCommand", () => {
  beforeEach(() => {
    dispatch.mockReset();
    callGatewayTool.mockReset();
    readChannelContextGatewayContextResolver.mockReset();
    host.context = {} as GatewayRequestContext;
  });

  it.each([
    { body: "/update", allowTextCommands: false },
    { body: "/update now", allowTextCommands: true },
    { body: "/updated", allowTextCommands: true },
  ])("ignores $body when text commands are $allowTextCommands", async (testCase) => {
    const params = updateCommandParams();
    params.command.commandBodyNormalized = testCase.body;

    expect(await handleUpdateCommand(params, testCase.allowTextCommands)).toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["unauthorized", "non-owner"])(
    "rejects an %s sender before calling the gateway",
    async (gate) => {
      const params = updateCommandParams();
      params.command.isAuthorizedSender = gate !== "unauthorized";
      params.command.senderIsOwner = gate !== "non-owner";

      expect(await handleUpdateCommand(params, true)).toEqual({ shouldContinue: false });
      expect(dispatch).not.toHaveBeenCalled();
    },
  );

  it("returns the native owner-gate reply", async () => {
    const params = updateCommandParams();
    params.ctx.CommandSource = "native";
    params.command.senderIsOwner = false;

    expect(await handleUpdateCommand(params, true)).toEqual({
      shouldContinue: false,
      reply: { text: "You are not authorized to use this command." },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("honors commands.restart=false without starting an update", async () => {
    const params = updateCommandParams();
    params.cfg.commands = { restart: false };

    expect(await handleUpdateCommand(params, true)).toEqual({
      shouldContinue: false,
      reply: { text: "⚠️ /update is disabled (commands.restart=false)." },
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("hands off an owner update with session routing and a 20-minute timeout", async () => {
    const params = updateCommandParams();
    const order: string[] = [];
    const onAdopted = vi.fn(async () => {
      await Promise.resolve();
      order.push("adopt");
    });
    const channelGateway = {} as GatewayRequestContext;
    const channelResolver = () => channelGateway;
    readChannelContextGatewayContextResolver.mockReturnValue(channelResolver);
    params.opts = { turnAdoptionLifecycle: { onAdopted } };
    dispatch.mockImplementationOnce(async () => {
      order.push("update");
      return {
        ok: true,
        result: { status: "skipped", reason: "managed-service-handoff-started", steps: [] },
        handoff: { status: "started", command: "openclaw update" },
      };
    });

    expect(await handleUpdateCommand(params, true)).toEqual({
      shouldContinue: false,
      reply: { text: "⬆️ Updating OpenClaw. Back in a few minutes; I'll confirm here." },
    });
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      "update.run",
      {
        sessionKey: params.sessionKey,
        note: "/update",
        timeoutMs: 1_200_000,
        requester: { channel: "telegram", senderId: "owner", accountId: undefined },
      },
      {
        timeoutMs: 1_200_000,
        resolveGatewayContext: expect.any(Function),
        forceSyntheticClient: true,
        syntheticScopes: ["operator.admin"],
      },
    );
    expect(order).toEqual(["adopt", "update"]);
    expect(readChannelContextGatewayContextResolver).toHaveBeenCalledWith(params.ctx);
    expect(dispatch.mock.calls[0]?.[2].resolveGatewayContext()).toBe(channelGateway);
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("does not update when ingress adoption was lost to another owner", async () => {
    const params = updateCommandParams();
    params.opts = {
      turnAdoptionLifecycle: {
        onAdopted: async () => {
          throw new Error("ingress adoption lost: guillotined");
        },
      },
    };

    await expect(handleUpdateCommand(params, true)).rejects.toThrow("ingress adoption lost");
    expect(dispatch).not.toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("includes known before and after versions in the acknowledgment", async () => {
    dispatch.mockResolvedValueOnce({
      ok: true,
      result: {
        status: "ok",
        before: { version: "2026.9.1" },
        after: { version: "2026.9.2" },
        steps: [],
      },
    });

    expect((await handleUpdateCommand(updateCommandParams(), true))?.reply?.text).toBe(
      "⬆️ Updating OpenClaw (2026.9.1 → 2026.9.2). Back in a few minutes; I'll confirm here.",
    );
  });

  it.each([
    { status: "skipped", reason: "managed-service-handoff-unavailable" },
    { status: "error", reason: "managed-service-handoff-failed" },
  ])("reports $status with the exact manual command", async ({ status, reason }) => {
    const command = "openclaw update --channel stable";
    dispatch.mockResolvedValueOnce({
      ok: false,
      result: { status, reason, steps: [] },
      handoff: {
        status: "unavailable",
        command,
        message: "Managed handoff unavailable.\nRun the update from a terminal.",
      },
    });

    const result = await handleUpdateCommand(updateCommandParams(), true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain(reason);
    expect(result?.reply?.text).toContain(command);
    expect(result?.reply?.text).not.toContain("I'll confirm here");
    expect(result?.reply?.text).not.toContain("\n");
  });

  it("reports missing hosting context without contacting a remote gateway", async () => {
    host.context = undefined;
    const result = await handleUpdateCommand(updateCommandParams(), true);
    expect(result?.reply?.text).toBe(
      "⚠️ Update request failed: Gateway instance unavailable for update.run",
    );
    expect(dispatch).not.toHaveBeenCalled();
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("turns a gateway transport error into a visible failure reply", async () => {
    dispatch.mockRejectedValueOnce(new Error("gateway connection refused"));

    expect(await handleUpdateCommand(updateCommandParams(), true)).toEqual({
      shouldContinue: false,
      reply: { text: "⚠️ Update request failed: gateway connection refused" },
    });
  });
});
