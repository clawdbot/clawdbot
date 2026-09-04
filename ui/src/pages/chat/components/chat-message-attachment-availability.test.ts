import { describe, expect, it, vi } from "vitest";
import {
  resolveAssistantAttachmentAvailability,
  retryAssistantAttachmentAvailability,
} from "./chat-message-attachment-availability.ts";
import { releaseChatMediaResourceSubscriber } from "./chat-message-media.ts";

async function flushAvailabilityResolution() {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
  }
}

describe("assistant attachment availability", () => {
  it("keeps shared-callback session subscriptions independent through resolution and retry", async () => {
    vi.useFakeTimers();
    const update = vi.fn();
    const source = `/tmp/openclaw/${crypto.randomUUID()}.png`;
    const resolveMedia = vi.fn(async (_source: string, sessionKey?: string) => ({
      available: true as const,
      mediaTicket: `ticket-${sessionKey}`,
      mediaTicketExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    }));
    const sessions = ["agent:main:main", "agent:research:main"] as const;
    const resolve = (session: string) =>
      resolveAssistantAttachmentAvailability(source, "/openclaw", update, resolveMedia, 1, session);
    try {
      for (const session of sessions) {
        expect(resolve(session).status).toBe("checking");
      }
      await flushAvailabilityResolution();
      expect(update).toHaveBeenCalledTimes(2);
      for (const session of sessions) {
        expect(resolve(session)).toMatchObject({
          status: "available",
          mediaTicket: `ticket-${session}`,
        });
      }
      expect(resolveMedia).toHaveBeenCalledTimes(2);

      retryAssistantAttachmentAvailability(source, "/openclaw", update, 1, sessions[0]);
      expect(resolve(sessions[0]).status).toBe("checking");
      expect(resolve(sessions[1]).status).toBe("available");
      await flushAvailabilityResolution();
      expect(resolveMedia).toHaveBeenCalledTimes(3);
      update.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(update).toHaveBeenCalledTimes(2);
      releaseChatMediaResourceSubscriber(update);
      update.mockClear();
      await vi.advanceTimersByTimeAsync(90_000);
      expect(update).not.toHaveBeenCalled();
    } finally {
      releaseChatMediaResourceSubscriber(update);
      vi.useRealTimers();
    }
  });
  it("preserves bootstrap root rejection only without a selected session", async () => {
    const resolver = vi.fn(async () => ({
      available: true as const,
      mediaTicket: "ticket-research",
      mediaTicketExpiresAt: new Date(Date.now() + 90_000).toISOString(),
    }));
    const source = "/tmp/research-agent/private.pdf";

    expect(
      resolveAssistantAttachmentAvailability(
        source,
        "/openclaw",
        undefined,
        resolver,
        1,
        undefined,
        ["/tmp/default-agent"],
      ),
    ).toMatchObject({ status: "unavailable", recoverable: false });
    expect(
      resolveAssistantAttachmentAvailability(
        source,
        "/openclaw",
        undefined,
        resolver,
        1,
        "agent:research:main",
        ["/tmp/default-agent"],
      ).status,
    ).toBe("checking");
    await flushAvailabilityResolution();
    expect(resolver).toHaveBeenCalledWith(source, "agent:research:main");
  });

  it("scopes cached media tickets to the selected session", async () => {
    const source = `/tmp/openclaw/${crypto.randomUUID()}.png`;
    const expiresAt = new Date(Date.now() + 90_000).toISOString();
    const mainResolver = vi.fn(async () => ({
      available: true as const,
      mediaTicket: "ticket-main",
      mediaTicketExpiresAt: expiresAt,
    }));
    const researchResolver = vi.fn(async () => ({
      available: true as const,
      mediaTicket: "ticket-research",
      mediaTicketExpiresAt: expiresAt,
    }));

    expect(
      resolveAssistantAttachmentAvailability(
        source,
        "/openclaw",
        undefined,
        mainResolver,
        1,
        "agent:main:main",
      ).status,
    ).toBe("checking");
    expect(
      resolveAssistantAttachmentAvailability(
        source,
        "/openclaw",
        undefined,
        researchResolver,
        1,
        "agent:research:main",
      ).status,
    ).toBe("checking");

    await flushAvailabilityResolution();

    expect(
      resolveAssistantAttachmentAvailability(
        source,
        "/openclaw",
        undefined,
        mainResolver,
        1,
        "agent:main:main",
      ),
    ).toMatchObject({ status: "available", mediaTicket: "ticket-main" });
    expect(
      resolveAssistantAttachmentAvailability(
        source,
        "/openclaw",
        undefined,
        researchResolver,
        1,
        "agent:research:main",
      ),
    ).toMatchObject({ status: "available", mediaTicket: "ticket-research" });
    expect(mainResolver).toHaveBeenCalledTimes(1);
    expect(researchResolver).toHaveBeenCalledTimes(1);
  });
});
