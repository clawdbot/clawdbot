import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expect, it, vi } from "vitest";
import { setQaChannelRuntime } from "../api.js";
import { handleQaInbound } from "./inbound.js";
import { createQaInboundParams } from "./inbound.test-harness.js";

it("admits symbolic group members from each supplied config snapshot", async () => {
  const runtime = createPluginRuntimeMock();
  setQaChannelRuntime(runtime);
  for (const members of [["alice"], ["bob"], ["alice"]]) {
    vi.mocked(runtime.channel.inbound.dispatch).mockClear();
    const params = createQaInboundParams({
      accountConfig: {
        groupPolicy: "allowlist",
        groupAllowFrom: ["accessGroup:reviewers"],
      },
      message: { conversation: { kind: "group", id: "qa-room" } },
    });
    const config = {
      channels: {},
      accessGroups: {
        reviewers: { type: "message.senders", members: { "qa-channel": members } },
      },
    } satisfies OpenClawConfig;

    await handleQaInbound({ ...params, config });

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(
      members.includes("alice") ? 1 : 0,
    );
  }
});
