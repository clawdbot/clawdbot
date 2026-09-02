// System-agent concurrency tests cover the shared execution lane.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { getCommandLaneSnapshot } from "../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../process/command-queue.test-support.js";
import { CommandLane } from "../../process/lanes.js";
import { systemAgentHandlers, type SystemAgentChatSession } from "./system-agent.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

const defaultClient = {
  connId: "conn-test",
  connect: { device: { id: "device-test" } },
} as GatewayClient;

function makeSession(
  handle: () => Promise<{ text: string; action: "none" }>,
): SystemAgentChatSession {
  return {
    engine: {
      handle,
      historyLength: () => 0,
      historySince: () => [],
    },
    welcome: "welcome text",
    lastUsedAt: 1,
    ownerKey: "device:device-test",
  } as unknown as SystemAgentChatSession;
}

afterEach(() => {
  resetCommandQueueStateForTest();
  vi.restoreAllMocks();
});

describe("openclaw.chat concurrency", () => {
  it("tracks every accepted request as active while serializing expensive execution", async () => {
    const firstStarted = createDeferred();
    const secondStarted = createDeferred();
    const releaseFirst = createDeferred();
    const releaseSecond = createDeferred();
    const firstHandle = vi.fn(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return { text: "first setup complete", action: "none" as const };
    });
    const secondHandle = vi.fn(async () => {
      secondStarted.resolve();
      await releaseSecond.promise;
      return { text: "second setup complete", action: "none" as const };
    });
    const sessions = new Map<string, SystemAgentChatSession>([
      ["s1", makeSession(firstHandle)],
      ["s2", makeSession(secondHandle)],
    ]);
    const activeAtResponse: number[] = [];
    const context = { systemAgentSessions: sessions } as unknown as GatewayRequestContext;
    const handleChat = (sessionId: string) =>
      systemAgentHandlers["openclaw.chat"]!({
        params: { sessionId, message: "yes" },
        client: defaultClient,
        context,
        respond: () => {
          activeAtResponse.push(getCommandLaneSnapshot(CommandLane.SystemAgent).activeCount);
        },
      } as never);

    const first = handleChat("s1");
    const second = handleChat("s2");

    await firstStarted.promise;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(getCommandLaneSnapshot(CommandLane.SystemAgent)).toMatchObject({
      activeCount: 2,
      queuedCount: 0,
    });
    expect(secondHandle).not.toHaveBeenCalled();
    releaseFirst.resolve();
    await first;
    await secondStarted.promise;
    expect(getCommandLaneSnapshot(CommandLane.SystemAgent).activeCount).toBe(1);
    releaseSecond.resolve();
    await second;

    expect(activeAtResponse).toEqual([2, 1]);
    expect(getCommandLaneSnapshot(CommandLane.SystemAgent).activeCount).toBe(0);
  });
});
