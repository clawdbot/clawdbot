import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { createGatewayTool } from "../../agents/tools/gateway-tool.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayRequestContext } from "./types.js";
import {
  adoptUpdateCampaignMock,
  detectRespawnSupervisorMock,
  runGatewayUpdateMock,
  scheduleGatewaySigusr1RestartMock,
  sendGatewayLifecycleNoticeMock,
  sentinelState,
  startManagedServiceUpdateHandoffMock,
} from "./update.test-harness.js";

const host = vi.hoisted(() => ({ context: undefined as GatewayRequestContext | undefined }));
vi.mock("../../agents/tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(),
}));
vi.mock("../server-plugins.js", () => ({
  getInProcessGatewayRequestContext: () => host.context,
  hasInProcessGatewayContext: () => Boolean(host.context),
  dispatchGatewayMethodInProcess: async (_method: string, params: Record<string, unknown>) => {
    const { updateHandlers } = await import("./update.js");
    let response: unknown;
    await expectDefined(
      updateHandlers["update.run"],
      "update.run handler",
    )({
      params,
      context: host.context,
      respond: (_ok: boolean, result: unknown) => {
        response = result;
      },
    } as never);
    return response;
  },
}));

describe("update.run current owner authority", () => {
  let config: OpenClawConfig;
  beforeEach(() => {
    config = { commands: { ownerAllowFrom: ["owner"] } };
    host.context = { getRuntimeConfig: () => config } as GatewayRequestContext;
  });

  async function runOwnerTool(tool: ReturnType<typeof createGatewayTool>, channel = "slack") {
    return withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: "agent:main:slack:dm:owner:thread:123",
        turnSourceChannel: channel,
        turnSourceAccountId: "primary",
        turnSourceTo: "owner",
      },
      () => tool.execute("update", { action: "update.run" }),
    );
  }

  it.each(["revoked", "reassigned", "unchanged", "webchat", "channel-less"])(
    "%s owner after tool construction uses current config",
    async (change) => {
      const tool = createGatewayTool({ senderIsOwner: true, requesterSenderId: "owner" });
      config = {
        commands: {
          ownerAllowFrom:
            change === "unchanged" ? ["owner"] : change === "revoked" ? [] : ["replacement"],
        },
      };
      const result =
        change === "channel-less"
          ? await tool.execute("update", { action: "update.run" })
          : await runOwnerTool(tool, change === "webchat" ? "webchat" : "slack");
      const allowed = change === "unchanged" || change === "webchat" || change === "channel-less";
      expect(result.details).toMatchObject({ ok: allowed });
      if (allowed) {
        expect(runGatewayUpdateMock).toHaveBeenCalledOnce();
      } else {
        expect(result.details).toMatchObject({
          reason: "owner_required",
          ackDelivered: false,
          message: expect.stringContaining(
            `openclaw config set commands.ownerAllowFrom '${JSON.stringify(change === "revoked" ? ["slack:owner"] : ["replacement", "slack:owner"])}'`,
          ),
        });
        expect(adoptUpdateCampaignMock).not.toHaveBeenCalled();
        expect(sendGatewayLifecycleNoticeMock).not.toHaveBeenCalled();
        expect(runGatewayUpdateMock).not.toHaveBeenCalled();
        expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
        expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
        expect(sentinelState.capturedPayload).toBeUndefined();
      }
    },
  );

  it.each([false, true])("rechecks after awaited acknowledgement (managed=%s)", async (managed) => {
    detectRespawnSupervisorMock.mockReturnValue(managed ? "launchd" : null);
    sendGatewayLifecycleNoticeMock.mockImplementationOnce(async () => {
      config = { commands: { ownerAllowFrom: ["replacement"] } };
      return true;
    });
    const result = await runOwnerTool(
      createGatewayTool({ senderIsOwner: true, requesterSenderId: "owner" }),
    );
    expect(result.details).toMatchObject({
      ok: false,
      reason: "owner_required",
      ackDelivered: true,
      message: expect.stringContaining(
        'openclaw config set commands.ownerAllowFrom \'["replacement","slack:owner"]\'',
      ),
    });
    expect(runGatewayUpdateMock).not.toHaveBeenCalled();
    expect(startManagedServiceUpdateHandoffMock).not.toHaveBeenCalled();
    expect(scheduleGatewaySigusr1RestartMock).not.toHaveBeenCalled();
    expect(sentinelState.capturedPayload).toBeUndefined();
    expect(sendGatewayLifecycleNoticeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          'openclaw config set commands.ownerAllowFrom \'["replacement","slack:owner"]\'',
        ),
      }),
    );
  });
});
