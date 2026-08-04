import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { describe, expect, it, vi } from "vitest";
import { fetchDiscordJson } from "./discord-api.js";

describe("Discord Activity API", () => {
  it("cancels non-OK response bodies before releasing the dispatcher", async () => {
    const lifecycle: string[] = [];
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("unauthorized"));
        },
        cancel() {
          lifecycle.push("cancel");
        },
      }),
      { status: 401 },
    );
    const fetchGuard = vi.fn(async () => ({
      response,
      release: async () => {
        lifecycle.push("release");
      },
    })) as unknown as typeof fetchWithSsrFGuard;

    await expect(
      fetchDiscordJson({
        fetchGuard,
        url: "https://discord.com/api/v10/users/@me",
        init: { headers: { Authorization: "Bearer test-token" } },
        auditContext: "discord.activities.oauth.user",
      }),
    ).resolves.toEqual({ ok: false, status: 401 });
    expect(lifecycle).toEqual(["cancel", "release"]);
  });

  it("preserves the HTTP status when response cancellation fails", async () => {
    const response = new Response(
      new ReadableStream({
        cancel() {
          throw new Error("cancel failed");
        },
      }),
      { status: 429 },
    );
    const release = vi.fn(async () => undefined);
    const fetchGuard = vi.fn(async () => ({
      response,
      release,
    })) as unknown as typeof fetchWithSsrFGuard;

    await expect(
      fetchDiscordJson({
        fetchGuard,
        url: "https://discord.com/api/v10/users/@me",
        init: { headers: { Authorization: "Bearer test-token" } },
        auditContext: "discord.activities.oauth.user",
      }),
    ).resolves.toEqual({ ok: false, status: 429 });
    expect(release).toHaveBeenCalledOnce();
  });
});
