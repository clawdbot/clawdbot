import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../runtime-api.js";
import "./message-handler-mock-support.test-support.js";
import { getRuntimeApiMockState } from "./message-handler-mock-support.test-support.js";
import { createMSTeamsMessageHandler } from "./message-handler.js";
import { buildChannelActivity, createMessageHandlerDeps } from "./message-handler.test-support.js";

const runtimeApiMockState = getRuntimeApiMockState();

describe("msteams message handler delegated auth", () => {
  beforeEach(() => {
    runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mockClear();
  });

  it("adds the SDK-owned delegated auth context to the agent turn", async () => {
    const cfg = {
      channels: {
        msteams: {
          groupPolicy: "open",
          requireMention: false,
          sso: { enabled: true, connectionName: "GraphConnection" },
        },
      },
    } as OpenClawConfig;
    const { deps, getTeamDetails } = createMessageHandlerDeps(cfg);
    const handler = createMSTeamsMessageHandler(deps);
    const signin = vi.fn(async () => "delegated-token");

    await handler({
      activity: buildChannelActivity({
        channelData: {
          team: { id: "team-1" },
          tenant: { id: "tenant-1" },
        },
      }),
      getTeamDetails,
      signin,
      sendActivity: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof handler>[0]);

    const call = runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mock.calls[0];
    const replyOptions = (
      call?.[0] as {
        replyOptions?: {
          pluginAuth?: {
            getDelegatedAccessToken: (request: { provider: string }) => Promise<unknown>;
          };
        };
      }
    )?.replyOptions;

    await expect(
      replyOptions?.pluginAuth?.getDelegatedAccessToken({ provider: "msteams" }),
    ).resolves.toMatchObject({
      ok: true,
      token: "delegated-token",
      tenantId: "tenant-1",
      userId: "user-aad",
    });
    expect(signin).toHaveBeenCalledWith(
      expect.objectContaining({ connectionName: "GraphConnection" }),
    );
  });
});
