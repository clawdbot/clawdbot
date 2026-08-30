// Discord tests cover private provider endpoint startup and request boundaries.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DISCORD_DEFAULT_REST_API_BASE_URL,
  DISCORD_PROVIDER_ENDPOINT_ENV_KEYS,
  type DiscordProviderEndpointDescriptor,
} from "./provider-endpoint.constants.js";
import { createDiscordProviderEndpointEnvForTest as providerEndpointEnv } from "./provider-endpoint.test-support.js";

const { fetchWithSsrFGuardMock, releaseMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
  releaseMock: vi.fn(async () => undefined),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>()),
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

let providerEndpoint: typeof import("./provider-endpoint.js");
let RequestClient: typeof import("./internal/rest.js").RequestClient;
let setDiscordRuntime: typeof import("./runtime.js").setDiscordRuntime;

const TEST_DESCRIPTOR: DiscordProviderEndpointDescriptor = {
  restApiBaseUrl: "http://127.0.0.1:43123/custom/rest/v10/",
  gatewayBotUrl: "http://127.0.0.1:43123/custom/gateway-metadata",
  gatewayOrigin: "ws://127.0.0.1:43124",
};

function initializeProviderEndpoint(
  descriptor: DiscordProviderEndpointDescriptor = TEST_DESCRIPTOR,
) {
  return providerEndpoint.initializeDiscordProviderEndpointFromEnv(providerEndpointEnv(descriptor));
}

function stubProviderEndpointEnv(
  descriptor: DiscordProviderEndpointDescriptor = TEST_DESCRIPTOR,
): void {
  for (const [key, value] of Object.entries(providerEndpointEnv(descriptor))) {
    vi.stubEnv(key, value);
  }
}

function captureError(run: () => unknown): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) {
      return error;
    }
    throw error;
  }
  throw new Error("expected operation to throw");
}

describe("Discord provider endpoint runtime", () => {
  it("defines the exact private environment contract", () => {
    expect(DISCORD_PROVIDER_ENDPOINT_ENV_KEYS).toEqual({
      restApiBaseUrl: "DISCORD_REST_API_BASE_URL",
      gatewayBotUrl: "DISCORD_GATEWAY_BOT_URL",
      gatewayOrigin: "DISCORD_GATEWAY_ORIGIN",
    });
  });

  beforeEach(async () => {
    vi.resetModules();
    fetchWithSsrFGuardMock.mockReset().mockResolvedValue({
      response: new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      }),
      release: releaseMock,
    });
    releaseMock.mockClear();
    providerEndpoint = await import("./provider-endpoint.js");
    ({ RequestClient } = await import("./internal/rest.js"));
    ({ setDiscordRuntime } = await import("./runtime.js"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is absent for missing input and preserves the live REST base", () => {
    expect(providerEndpoint.initializeDiscordProviderEndpointFromEnv({})).toBeUndefined();
    expect(providerEndpoint.getDiscordProviderEndpointRuntime()).toBeUndefined();
    expect(DISCORD_DEFAULT_REST_API_BASE_URL).toBe("https://discord.com/api/v10");
  });

  it("is absent for whitespace-only input", () => {
    expect(
      providerEndpoint.initializeDiscordProviderEndpointFromEnv({
        [DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.restApiBaseUrl]: "  ",
        [DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.gatewayBotUrl]: "\t",
        [DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.gatewayOrigin]: "\n",
      }),
    ).toBeUndefined();
  });

  it("stores three independent normalized anchors from the private environment", () => {
    initializeProviderEndpoint();

    expect(providerEndpoint.getDiscordProviderEndpointRuntime()?.descriptor).toEqual({
      restApiBaseUrl: "http://127.0.0.1:43123/custom/rest/v10",
      gatewayBotUrl: TEST_DESCRIPTOR.gatewayBotUrl,
      gatewayOrigin: TEST_DESCRIPTOR.gatewayOrigin,
    });
  });

  it("reads the private endpoint while installing the Discord runtime", () => {
    stubProviderEndpointEnv();

    setDiscordRuntime({} as Parameters<typeof setDiscordRuntime>[0]);

    expect(providerEndpoint.getDiscordProviderEndpointRuntime()?.descriptor.restApiBaseUrl).toBe(
      "http://127.0.0.1:43123/custom/rest/v10",
    );
  });

  it("keeps Discord runtime installation closed after caching partial endpoint input", () => {
    vi.stubEnv(DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.restApiBaseUrl, TEST_DESCRIPTOR.restApiBaseUrl);
    const runtime = {} as Parameters<typeof setDiscordRuntime>[0];

    expect(() => setDiscordRuntime(runtime)).toThrow(/DISCORD_GATEWAY_BOT_URL/);
    stubProviderEndpointEnv();
    expect(() => setDiscordRuntime(runtime)).toThrow(/DISCORD_GATEWAY_BOT_URL/);
    expect(providerEndpoint.getDiscordProviderEndpointRuntime()).toBeUndefined();
  });

  it("snapshots the first endpoint and ignores later environment mutation", () => {
    const first = initializeProviderEndpoint();
    const replacementDescriptor = {
      ...TEST_DESCRIPTOR,
      restApiBaseUrl: "http://127.0.0.1:43125/replacement/rest/v10",
    };
    const second = providerEndpoint.initializeDiscordProviderEndpointFromEnv(
      providerEndpointEnv(replacementDescriptor),
    );

    expect(second).toBe(first);
    expect(second?.descriptor.restApiBaseUrl).toBe("http://127.0.0.1:43123/custom/rest/v10");
  });

  it("keeps an absent startup endpoint absent after late configuration", () => {
    expect(providerEndpoint.initializeDiscordProviderEndpointFromEnv({})).toBeUndefined();

    expect(
      providerEndpoint.initializeDiscordProviderEndpointFromEnv(
        providerEndpointEnv(TEST_DESCRIPTOR),
      ),
    ).toBeUndefined();
    expect(providerEndpoint.getDiscordProviderEndpointRuntime()).toBeUndefined();
  });

  it.each([
    {
      [DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.restApiBaseUrl]: TEST_DESCRIPTOR.restApiBaseUrl,
    },
    {
      [DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.gatewayBotUrl]: TEST_DESCRIPTOR.gatewayBotUrl,
    },
    {
      [DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.gatewayOrigin]: TEST_DESCRIPTOR.gatewayOrigin,
    },
    {
      ...providerEndpointEnv(TEST_DESCRIPTOR),
      [DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.gatewayBotUrl]: " ",
    },
  ])("fails closed on partial endpoint input %#", (env) => {
    expect(() => providerEndpoint.initializeDiscordProviderEndpointFromEnv(env)).toThrow(
      "Discord provider endpoint requires DISCORD_REST_API_BASE_URL, DISCORD_GATEWAY_BOT_URL, DISCORD_GATEWAY_ORIGIN to be set together",
    );
    expect(providerEndpoint.getDiscordProviderEndpointRuntime()).toBeUndefined();
  });

  it("rejects aggregate endpoint environment larger than 8 KiB", () => {
    expect(() =>
      providerEndpoint.initializeDiscordProviderEndpointFromEnv({
        ...providerEndpointEnv(TEST_DESCRIPTOR),
        [DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.restApiBaseUrl]: `https://provider.example/${"x".repeat(8 * 1024)}`,
      }),
    ).toThrow(/exceeds 8192 aggregate bytes/);
  });

  it("counts surrounding whitespace toward the aggregate environment limit", () => {
    const env = providerEndpointEnv(TEST_DESCRIPTOR);
    const rawBytes = Object.values(env).reduce(
      (total, value) => total + Buffer.byteLength(value ?? "", "utf8"),
      0,
    );
    const padding = " ".repeat(8 * 1024 - rawBytes + 1);

    expect(() =>
      providerEndpoint.initializeDiscordProviderEndpointFromEnv({
        ...env,
        [DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.restApiBaseUrl]: `${padding}${TEST_DESCRIPTOR.restApiBaseUrl}`,
      }),
    ).toThrow(/exceeds 8192 aggregate bytes/);
  });

  it("rejects aggregate oversized whitespace-only input before treating it as absent", () => {
    expect(() =>
      providerEndpoint.initializeDiscordProviderEndpointFromEnv({
        [DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.restApiBaseUrl]: " ".repeat(3_000),
        [DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.gatewayBotUrl]: " ".repeat(3_000),
        [DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.gatewayOrigin]: " ".repeat(2_193),
      }),
    ).toThrow(/exceeds 8192 aggregate bytes/);
    expect(providerEndpoint.getDiscordProviderEndpointRuntime()).toBeUndefined();
  });

  it("caches partial startup input instead of accepting a late replacement", () => {
    const firstError = captureError(() =>
      providerEndpoint.initializeDiscordProviderEndpointFromEnv({
        [DISCORD_PROVIDER_ENDPOINT_ENV_KEYS.restApiBaseUrl]: TEST_DESCRIPTOR.restApiBaseUrl,
      }),
    );
    const secondError = captureError(() => initializeProviderEndpoint());

    expect(firstError.message).toContain("DISCORD_GATEWAY_BOT_URL");
    expect(secondError).toBe(firstError);
    expect(providerEndpoint.getDiscordProviderEndpointRuntime()).toBeUndefined();
  });

  it.each([
    {
      descriptor: {
        ...TEST_DESCRIPTOR,
        restApiBaseUrl: "http://provider.example/custom/rest/v10",
      },
      expectedError: /HTTPS or loopback HTTP/,
    },
    {
      descriptor: {
        ...TEST_DESCRIPTOR,
        gatewayOrigin: "ws://provider.example",
      },
      expectedError: /WSS or loopback WS/,
    },
  ])("rejects insecure non-loopback anchors %#", ({ descriptor, expectedError }) => {
    expect(() => initializeProviderEndpoint(descriptor)).toThrow(expectedError);
  });

  it.each([
    "wss://10.0.0.8",
    "wss://[fd00::8]",
    "wss://localhost",
    "wss://169.254.169.254",
    "wss://metadata.google.internal",
  ])("rejects blocked WSS Gateway origin %s", (gatewayOrigin) => {
    expect(() => initializeProviderEndpoint({ ...TEST_DESCRIPTOR, gatewayOrigin })).toThrow(
      "Discord provider Gateway origin must not target a private/internal/special-use hostname or IP address",
    );
  });

  it.each(["wss://8.8.8.8", "wss://[2606:4700:4700::1111]"])(
    "allows public literal WSS Gateway origin %s",
    (gatewayOrigin) => {
      initializeProviderEndpoint({ ...TEST_DESCRIPTOR, gatewayOrigin });

      expect(providerEndpoint.getDiscordProviderEndpointRuntime()?.descriptor.gatewayOrigin).toBe(
        gatewayOrigin,
      );
    },
  );

  it("routes REST clients through the exact configured base", async () => {
    initializeProviderEndpoint();
    const ignoredFetch = vi.fn();
    const client = new RequestClient("test-token", {
      fetch: ignoredFetch,
      queueRequests: false,
    });

    await expect(
      client.post("/channels/123/messages", { body: { content: "hello" } }),
    ).resolves.toEqual({ ok: true });

    expect(ignoredFetch).not.toHaveBeenCalled();
    expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
    const guarded = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(guarded.url).toBe("http://127.0.0.1:43123/custom/rest/v10/channels/123/messages");
    expect(guarded.maxRedirects).toBe(0);
    expect(guarded.requireHttps).toBe(false);
    expect(guarded.policy).toEqual({
      allowedOrigins: ["http://127.0.0.1:43123"],
    });
    expect(releaseMock).toHaveBeenCalledOnce();
  });

  it("preserves Request method, headers, body, signal, and duplex", async () => {
    initializeProviderEndpoint();
    const runtime = providerEndpoint.getDiscordProviderEndpointRuntime();
    if (!runtime) {
      throw new Error("expected endpoint runtime");
    }
    const controller = new AbortController();
    const request = new Request(`${TEST_DESCRIPTOR.restApiBaseUrl}messages`, {
      method: "POST",
      headers: { "x-provider-test": "present" },
      body: "streamed body",
      signal: controller.signal,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    await runtime.fetch(request);

    const guarded = fetchWithSsrFGuardMock.mock.calls[0]?.[0];
    expect(guarded.init.method).toBe("POST");
    expect(new Headers(guarded.init.headers).get("x-provider-test")).toBe("present");
    expect(guarded.init.duplex).toBe("half");
    expect(guarded.init.body).toBeInstanceOf(ReadableStream);
    expect(await new Response(guarded.init.body).text()).toBe("streamed body");
    expect(guarded.signal).toBe(guarded.init.signal);
    expect(guarded.signal.aborted).toBe(false);
    controller.abort();
    expect(guarded.signal.aborted).toBe(true);
  });

  it("rejects requests outside both explicit HTTP anchors", async () => {
    initializeProviderEndpoint();
    const runtime = providerEndpoint.getDiscordProviderEndpointRuntime();
    if (!runtime) {
      throw new Error("expected endpoint runtime");
    }

    await expect(runtime.fetch("http://127.0.0.1:43123/not-the-provider")).rejects.toThrow(
      /outside the configured endpoint boundaries/,
    );
    expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
  });

  it("allows provider attachment uploads only on the configured REST origin", () => {
    expect(
      providerEndpoint.resolveDiscordProviderAttachmentUploadGuard(
        "https://cdn.discord.test/upload",
      ),
    ).toBeUndefined();

    initializeProviderEndpoint();

    expect(
      providerEndpoint.resolveDiscordProviderAttachmentUploadGuard(
        "http://127.0.0.1:43123/upload/voice.ogg?signature=test",
      ),
    ).toEqual({
      maxRedirects: 0,
      policy: { allowedOrigins: ["http://127.0.0.1:43123"] },
      requireHttps: false,
    });
    for (const uploadUrl of [
      "http://127.0.0.1:43124/upload",
      "https://127.0.0.1:43123/upload",
      "http://user@127.0.0.1:43123/upload",
      "http://127.0.0.1:43123/upload#fragment",
    ]) {
      expect(() =>
        providerEndpoint.resolveDiscordProviderAttachmentUploadGuard(uploadUrl),
      ).toThrow();
    }
  });

  it("allows inbound media only at the provider REST origin without redirects", () => {
    expect(
      providerEndpoint.resolveDiscordProviderMediaDownloadGuard(
        "https://cdn.discordapp.com/attachment.png",
      ),
    ).toBeUndefined();

    initializeProviderEndpoint();

    expect(
      providerEndpoint.resolveDiscordProviderMediaDownloadGuard(
        "http://127.0.0.1:43123/custom/media/attachment.png",
      ),
    ).toEqual({
      maxRedirects: 0,
      policy: {
        allowedOrigins: ["http://127.0.0.1:43123"],
        hostnameAllowlist: ["127.0.0.1"],
      },
    });
    expect(() =>
      providerEndpoint.resolveDiscordProviderMediaDownloadGuard(
        "https://cdn.discordapp.com/attachment.png",
      ),
    ).toThrow("outside the configured REST origin");
  });
});
