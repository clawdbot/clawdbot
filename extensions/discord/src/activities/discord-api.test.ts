import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const providerFetchGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: providerFetchGuardMock,
}));

import { initializeDiscordProviderEndpointForTest } from "../provider-endpoint.test-support.js";

let fetchDiscordJson: typeof import("./discord-api.js").fetchDiscordJson;
let resolveActivityInstanceChannel: typeof import("./discord-api.js").resolveActivityInstanceChannel;
let userRoute: typeof import("./discord-api.js").DISCORD_ACTIVITY_USER_ROUTE;

const TEST_DESCRIPTOR = {
  restApiBaseUrl: "http://127.0.0.1:43123/custom/rest/v10",
  gatewayBotUrl: "http://127.0.0.1:43123/custom/gateway-metadata",
  gatewayOrigin: "ws://127.0.0.1:43124",
} as const;

describe("Discord Activity API", () => {
  beforeEach(async () => {
    vi.resetModules();
    providerFetchGuardMock.mockReset();
    ({
      DISCORD_ACTIVITY_USER_ROUTE: userRoute,
      fetchDiscordJson,
      resolveActivityInstanceChannel,
    } = await import("./discord-api.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

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
        route: userRoute,
        init: { headers: { Authorization: "Bearer test-token" } },
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
        route: userRoute,
        init: { headers: { Authorization: "Bearer test-token" } },
      }),
    ).resolves.toEqual({ ok: false, status: 429 });
    expect(release).toHaveBeenCalledOnce();
  });

  it("routes Bot-authenticated activity instance lookup through the provider REST base", async () => {
    const release = vi.fn(async () => undefined);
    providerFetchGuardMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          users: ["user-1"],
          location: { channel_id: "123456" },
        }),
        { headers: { "content-type": "application/json" } },
      ),
      release,
    });
    await initializeDiscordProviderEndpointForTest(TEST_DESCRIPTOR);
    const publicFetchGuard = vi.fn();
    const proxyFetch = vi.fn();

    await expect(
      resolveActivityInstanceChannel({
        fetchGuard: publicFetchGuard as unknown as typeof fetchWithSsrFGuard,
        applicationId: "app-1",
        instanceId: "instance/one",
        discordUserId: "user-1",
        botAuth: "bot-token",
        proxyFetch,
      }),
    ).resolves.toBe("123456");

    expect(publicFetchGuard).not.toHaveBeenCalled();
    expect(proxyFetch).not.toHaveBeenCalled();
    expect(providerFetchGuardMock).toHaveBeenCalledOnce();
    const guarded = providerFetchGuardMock.mock.calls[0]?.[0];
    expect(guarded.url).toBe(
      "http://127.0.0.1:43123/custom/rest/v10/applications/app-1/activity-instances/instance%2Fone",
    );
    expect(new Headers(guarded.init.headers).get("Authorization")).toBe("Bot bot-token");
    expect(release).toHaveBeenCalledOnce();
  });

  it("fails provider activity lookup closed without falling back to public Discord", async () => {
    providerFetchGuardMock.mockResolvedValue({
      response: new Response("unavailable", { status: 503 }),
      release: vi.fn(async () => undefined),
    });
    await initializeDiscordProviderEndpointForTest(TEST_DESCRIPTOR);
    const publicFetchGuard = vi.fn();
    const proxyFetch = vi.fn();

    await expect(
      resolveActivityInstanceChannel({
        fetchGuard: publicFetchGuard as unknown as typeof fetchWithSsrFGuard,
        applicationId: "app-1",
        instanceId: "instance-1",
        discordUserId: "user-1",
        botAuth: "bot-token",
        proxyFetch,
      }),
    ).resolves.toBeUndefined();

    expect(publicFetchGuard).not.toHaveBeenCalled();
    expect(proxyFetch).not.toHaveBeenCalled();
  });

  it("bounds a provider activity lookup that never responds", async () => {
    vi.useFakeTimers();
    let providerSignal: AbortSignal | undefined;
    providerFetchGuardMock.mockImplementation(
      async ({ signal }: { signal?: AbortSignal }) =>
        await new Promise((_, reject) => {
          providerSignal = signal;
          signal?.addEventListener("abort", () => reject(new Error("provider request aborted")), {
            once: true,
          });
        }),
    );
    await initializeDiscordProviderEndpointForTest(TEST_DESCRIPTOR);
    const publicFetchGuard = vi.fn();

    const lookup = resolveActivityInstanceChannel({
      fetchGuard: publicFetchGuard as unknown as typeof fetchWithSsrFGuard,
      applicationId: "app-1",
      instanceId: "instance-1",
      discordUserId: "user-1",
      botAuth: "bot-token",
    });
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(lookup).resolves.toBeUndefined();
    expect(providerSignal?.aborted).toBe(true);
    expect(publicFetchGuard).not.toHaveBeenCalled();
  });
});
