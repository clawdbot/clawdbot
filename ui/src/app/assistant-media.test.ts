import { describe, expect, it, vi } from "vitest";
import { resolveAssistantMedia } from "./assistant-media.ts";

describe("resolveAssistantMedia", () => {
  it("mints an exact-source capability over the authenticated Gateway client", async () => {
    const result = {
      available: true as const,
      mediaTicket: "ticket-local-media",
      mediaTicketExpiresAt: "2026-09-03T12:00:00.000Z",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    const request = vi.fn().mockResolvedValue(result);

    await expect(
      resolveAssistantMedia({ request } as never, "/tmp/report.png", "agent:main:main"),
    ).resolves.toEqual(result);
    expect(request).toHaveBeenCalledWith(
      "assistant.media.get",
      { source: "/tmp/report.png", sessionKey: "agent:main:main" },
      { timeoutMs: 30_000 },
    );
  });

  it("preserves the selected non-default-agent session", async () => {
    const request = vi.fn().mockResolvedValue({ available: false });

    await resolveAssistantMedia(
      { request } as never,
      "/tmp/research/output.png",
      "agent:research:main",
    );

    expect(request).toHaveBeenCalledWith(
      "assistant.media.get",
      { source: "/tmp/research/output.png", sessionKey: "agent:research:main" },
      { timeoutMs: 30_000 },
    );
  });
});
