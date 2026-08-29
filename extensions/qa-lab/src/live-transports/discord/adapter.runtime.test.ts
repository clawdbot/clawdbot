import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as credentialLease from "../shared/credential-lease.runtime.js";
import { createDiscordQaTransportAdapter } from "./adapter.runtime.js";
import { discordQaScenarioSupport } from "./discord-live.runtime.js";

function mockAdapterIo() {
  const release = vi.fn(async () => {});
  const heartbeatStop = vi.fn(async () => {});
  vi.spyOn(credentialLease, "acquireQaCredentialLease").mockResolvedValue({
    kind: "discord",
    source: "convex",
    payload: {
      guildId: "123456789012345678",
      channelId: "223456789012345678",
      driverBotToken: "driver-token",
      sutBotToken: "sut-token",
      sutApplicationId: "323456789012345678",
    },
    heartbeat: vi.fn(async () => {}),
    heartbeatIntervalMs: 30_000,
    leaseTtlMs: 120_000,
    release,
  });
  vi.spyOn(credentialLease, "startQaCredentialLeaseHeartbeat").mockReturnValue({
    getFailure: () => null,
    stop: heartbeatStop,
    throwIfFailed: vi.fn(),
  });
  const identity = vi
    .spyOn(discordQaScenarioSupport.testing, "getCurrentDiscordUser")
    .mockResolvedValueOnce({ id: "423456789012345678", bot: true })
    .mockResolvedValueOnce({ id: "323456789012345678", bot: true });
  const poll = vi
    .spyOn(discordQaScenarioSupport.testing, "pollChannelMessages")
    .mockRejectedValue(new Error("observer stopped"));
  const context = {
    channelId: "discord",
    driver: "live",
    outputDir: "/unused",
    credentials: {
      acquire: credentialLease.acquireQaCredentialLease,
      startHeartbeat: credentialLease.startQaCredentialLeaseHeartbeat,
    },
    messages: {
      addInboundMessage: vi.fn(),
      addOutboundMessage: vi.fn(),
      editMessage: vi.fn(),
    },
  } satisfies Parameters<typeof createDiscordQaTransportAdapter>[0];
  return { context, heartbeatStop, identity, poll, release };
}

describe("Discord QA adapter cleanup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "drains polling before gateway stop and releases afterward (heartbeat stop fails: %s)",
    async (heartbeatFails) => {
      const { context, heartbeatStop, poll, release } = mockAdapterIo();
      const pendingPoll = createDeferred<never>();
      poll.mockReturnValue(pendingPoll.promise);
      if (heartbeatFails) {
        heartbeatStop.mockRejectedValue(new Error("heartbeat shutdown failed"));
      }
      const adapter = await createDiscordQaTransportAdapter(context);
      expect(poll).toHaveBeenCalledOnce();

      const drained = vi.fn();
      const cleanup = adapter.cleanup?.().then(drained);
      await Promise.resolve();
      expect(drained).not.toHaveBeenCalled();
      pendingPoll.reject(new Error("observer stopped"));
      await cleanup;

      expect(drained).toHaveBeenCalledOnce();
      expect(heartbeatStop).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      const postStopCleanup = adapter.cleanupAfterGatewayStop?.();
      if (heartbeatFails) {
        await expect(postStopCleanup).rejects.toThrow("heartbeat shutdown failed");
      } else {
        await postStopCleanup;
      }
      expect(heartbeatStop).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(heartbeatStop).toHaveBeenCalledBefore(release);
    },
  );

  it.each([
    {
      name: "bots are identical",
      sutId: "423456789012345678",
      error: "requires two distinct bots",
    },
    {
      name: "SUT application ID mismatches",
      sutId: "523456789012345678",
      error: "application id must match",
    },
  ])("immediately releases when $name", async ({ sutId, error }) => {
    const { context, heartbeatStop, identity, poll, release } = mockAdapterIo();
    identity
      .mockReset()
      .mockResolvedValueOnce({ id: "423456789012345678", bot: true })
      .mockResolvedValueOnce({ id: sutId, bot: true });

    await expect(createDiscordQaTransportAdapter(context)).rejects.toThrow(error);

    expect(poll).not.toHaveBeenCalled();
    expect(heartbeatStop).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});
