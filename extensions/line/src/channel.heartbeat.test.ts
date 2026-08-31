// Line tests cover heartbeat typing plugin behavior.
import type { PluginRuntime } from "openclaw/plugin-sdk/channel-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { linePlugin } from "./channel.js";
import { setLineRuntime } from "./runtime.js";

const userId = `U${"a".repeat(32)}`;
const groupId = `C${"b".repeat(32)}`;
const roomId = `R${"c".repeat(32)}`;
const cfg = {} as OpenClawConfig;

const showLoadingAnimation = vi.fn(async () => {});

async function sendTyping(to: string) {
  await linePlugin.heartbeat?.sendTyping?.({ cfg, to, accountId: "default" });
}

describe("linePlugin heartbeat.sendTyping", () => {
  beforeEach(() => {
    showLoadingAnimation.mockClear();
    setLineRuntime({
      channel: { line: { showLoadingAnimation } },
    } as unknown as PluginRuntime);
  });

  it.each([
    { name: "a bare user id", to: userId },
    { name: "a prefixed user id", to: `line:user:${userId}` },
  ])("shows the loading animation for $name", async ({ to }) => {
    await sendTyping(to);

    expect(showLoadingAnimation).toHaveBeenCalledTimes(1);
    expect(showLoadingAnimation).toHaveBeenCalledWith(userId, { cfg, accountId: "default" });
  });

  // LINE only shows the indicator in one-to-one chats, so anything else would be a
  // call that can only fail; it is skipped instead of sent and logged as a failure.
  it.each([
    { name: "a group", to: groupId },
    { name: "a room", to: roomId },
    { name: "an unusable target", to: "not-a-line-id" },
    { name: "an empty target", to: "   " },
  ])("stays quiet for $name", async ({ to }) => {
    await sendTyping(to);

    expect(showLoadingAnimation).not.toHaveBeenCalled();
  });
});
