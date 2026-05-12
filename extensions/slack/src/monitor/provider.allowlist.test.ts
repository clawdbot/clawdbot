import { beforeEach, describe, expect, it } from "vitest";
import {
  flush,
  getSlackHandlerOrThrow,
  getSlackTestState,
  resetSlackTestState,
  startSlackMonitor,
  stopSlackMonitor,
} from "../monitor.test-helpers.js";
import { formatSlackChannelResolved, formatSlackUserResolved } from "./provider-support.js";

const { monitorSlackProvider } = await import("./provider.js");
const slackTestState = getSlackTestState();

beforeEach(() => {
  resetSlackTestState();
});

function resolveAllowlistCallAt(index: number): { entries?: unknown } {
  const call = slackTestState.resolveSlackUserAllowlistMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected allowlist resolver call ${index}`);
  }
  return call[0] as { entries?: unknown };
}

describe("slack allowlist log formatting", () => {
  it("prints channel names alongside ids", () => {
    expect(
      formatSlackChannelResolved({
        input: "C0AQXEG6QFJ",
        resolved: true,
        id: "C0AQXEG6QFJ",
        name: "openclawtest",
      }),
    ).toBe("C0AQXEG6QFJ→openclawtest (id:C0AQXEG6QFJ)");
  });

  it("prints user names alongside ids", () => {
    expect(
      formatSlackUserResolved({
        input: "U090HHQ029J",
        resolved: true,
        id: "U090HHQ029J",
        name: "steipete",
      }),
    ).toBe("U090HHQ029J→steipete (id:U090HHQ029J)");
  });
});

describe("slack startup user allowlist resolution", () => {
  it("skips user entry resolution when name matching is not enabled", async () => {
    resetSlackTestState({
      messages: {
        responsePrefix: "PFX",
      },
      channels: {
        slack: {
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: ["<@U123GLOBAL>", "@global-user"],
          channels: {
            C123: {
              enabled: true,
              requireMention: false,
              users: ["<@U123CHANNEL>", "@channel-user"],
            },
          },
        },
      },
    });
    slackTestState.replyMock.mockResolvedValue({ text: "ok" });

    const monitor = startSlackMonitor(monitorSlackProvider);
    try {
      const handler = await getSlackHandlerOrThrow("message");
      await flush();
      await flush();

      expect(slackTestState.resolveSlackUserAllowlistMock).not.toHaveBeenCalled();

      await handler({
        event: {
          type: "message",
          user: "U123GLOBAL",
          text: "hello",
          ts: "100.000",
          channel: "D123",
          channel_type: "im",
        },
      });
      expect(slackTestState.replyMock).toHaveBeenCalledTimes(1);

      slackTestState.replyMock.mockClear();
      await handler({
        event: {
          type: "message",
          user: "U123CHANNEL",
          text: "hello",
          ts: "101.000",
          channel: "C123",
          channel_type: "channel",
        },
      });
      expect(slackTestState.replyMock).toHaveBeenCalledTimes(1);
    } finally {
      await stopSlackMonitor(monitor);
    }
  });

  it("resolves user entries when name matching is enabled", async () => {
    resetSlackTestState({
      channels: {
        slack: {
          enabled: true,
          dangerouslyAllowNameMatching: true,
          dmPolicy: "allowlist",
          allowFrom: ["@global-user"],
          channels: {
            C123: { users: ["@channel-user"] },
          },
        },
      },
    });

    const monitor = startSlackMonitor(monitorSlackProvider);
    try {
      await getSlackHandlerOrThrow("message");
      await flush();
      await flush();

      expect(slackTestState.resolveSlackUserAllowlistMock).toHaveBeenCalledTimes(2);
      const globalAllowlist = resolveAllowlistCallAt(0);
      const channelAllowlist = resolveAllowlistCallAt(1);
      expect(globalAllowlist?.entries).toEqual(["@global-user"]);
      expect(channelAllowlist?.entries).toEqual(["@channel-user"]);
    } finally {
      await stopSlackMonitor(monitor);
    }
  });
});
