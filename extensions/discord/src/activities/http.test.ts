import fs from "node:fs/promises";
import { createServer, request as createHttpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDiscordActivityCustomId } from "../component-custom-id.js";
import { createDiscordActivityHttpHandler } from "./http.js";
import { DiscordActivitiesRuntime } from "./runtime.js";
import {
  createActivityTestConfig,
  createActivityTestRuntime,
} from "./test-helpers.test-support.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

async function startServer(
  runtime: DiscordActivitiesRuntime,
  options: {
    fetchGuard?: typeof fetchWithSsrFGuard;
    now?: () => number;
    vendorAssetPath?: string;
    readVendorAsset?: (assetPath: string) => Promise<Buffer>;
    logError?: (message: string) => void;
    bodyTimeoutMs?: number;
  } = {},
): Promise<string> {
  const route = createDiscordActivityHttpHandler({
    runtime,
    ...options,
    vendorAssetPath:
      options.vendorAssetPath ?? path.join(os.tmpdir(), "missing-discord-activity-sdk.mjs"),
  });
  const server = createServer((req, res) => {
    void route.handleHttpRequest(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("not found");
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function observeStalledTokenRequest(
  base: string,
  clientTimeoutMs: number,
): Promise<"server-terminated" | "client-timeout"> {
  return await new Promise((resolve) => {
    const request = createHttpRequest(`${base}/discord/activity/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const finish = (outcome: "server-terminated" | "client-timeout") => {
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish("client-timeout");
      request.end();
    }, clientTimeoutMs);
    const finishServerTerminated = () => finish("server-terminated");
    request.on("response", (response) => {
      response.resume();
      response.on("end", finishServerTerminated);
      response.on("close", finishServerTerminated);
    });
    request.on("error", finishServerTerminated);
    request.on("close", finishServerTerminated);
    request.write('{"code":"');
  });
}

function guardedJsonFetch(params?: {
  tokenStatus?: number;
  userId?: string;
  instanceStatus?: number;
  channelId?: string;
  instanceUsers?: string[];
  onExchange?: (code: string | null) => Promise<number | void> | number | void;
}) {
  return vi.fn(async ({ url, init }: { url: string; init?: RequestInit }) => {
    const wantsExchange = url.includes("/oauth2/token");
    const wantsInstance = url.includes("/activity-instances/");
    const exchangeStatus = wantsExchange
      ? await params?.onExchange?.(
          init?.body instanceof URLSearchParams ? init.body.get("code") : null,
        )
      : undefined;
    const status = wantsExchange
      ? (exchangeStatus ?? params?.tokenStatus ?? 200)
      : wantsInstance
        ? (params?.instanceStatus ?? 200)
        : 200;
    const body = wantsExchange
      ? { access_token: "atoken" }
      : wantsInstance
        ? {
            location: { channel_id: params?.channelId ?? "777" },
            users: params?.instanceUsers ?? ["42"],
          }
        : { id: params?.userId ?? "42", username: "alice", discriminator: "0" };
    return {
      response: new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
      release: vi.fn(async () => undefined),
    };
  }) as unknown as typeof fetchWithSsrFGuard;
}

async function createWidget(
  runtime: DiscordActivitiesRuntime,
  params?: { createdAt?: number; channelId?: string; accountId?: string },
) {
  const createdAt = params?.createdAt ?? 1;
  const widgetId = await runtime.store.createWidget({
    html: "<!doctype html><html><body><script>document.body.dataset.ready='yes'</script></body></html>",
    title: "Activity status",
    channelId: params?.channelId ?? "777",
    accountId: params?.accountId ?? "default",
    createdAt,
  });
  await runtime.store.markWidgetDelivered(
    widgetId,
    String(1_000_000_000_000_000_000n + BigInt(createdAt)),
  );
  return widgetId;
}

function createProxyAwareRuntime(): DiscordActivitiesRuntime {
  const cfg = createActivityTestConfig();
  cfg.gateway = { trustedProxies: ["127.0.0.1"] };
  return createActivityTestRuntime(cfg);
}

function fetchInputUrl(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

const activityOrigin = "https://123456789012345678.discordsays.com";

function requestToken(
  base: string,
  params: {
    body?: string;
    code?: string;
    forwardedFor?: string;
    origin?: string;
  } = {},
): Promise<Response> {
  return fetch(`${base}/discord/activity/api/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(params.origin ? { Origin: params.origin } : {}),
      ...(params.forwardedFor ? { "X-Forwarded-For": params.forwardedFor } : {}),
    },
    body: params.body ?? JSON.stringify({ code: params.code ?? "oauth-code" }),
  });
}

async function requestTokens(
  base: string,
  count: number,
  params: (index: number) => Parameters<typeof requestToken>[1],
  onResponse: (response: Response) => void,
): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const response = await requestToken(base, params(index));
    onResponse(response);
  }
}

function requestWidget(base: string, query: string, sessionToken?: string): Promise<Response> {
  return fetch(
    `${base}/discord/activity/api/widget?${query}`,
    sessionToken ? { headers: { Authorization: `Bearer ${sessionToken}` } } : undefined,
  );
}

function recordPendingLaunch(
  runtime: DiscordActivitiesRuntime,
  widgetId: string,
  createdAt: number,
  accountId = "default",
) {
  return runtime.store.recordPendingLaunch({
    accountId,
    channelId: "777",
    discordUserId: "42",
    widgetId,
    createdAt,
  });
}

function consumePendingLaunch(runtime: DiscordActivitiesRuntime, accountId = "default") {
  return runtime.store.consumePendingLaunch(accountId, "777", "42");
}

function createWidgetFixture(
  options: Parameters<typeof startServer>[1] = { fetchGuard: guardedJsonFetch() },
) {
  const runtime = createActivityTestRuntime();
  let base: string | undefined;
  let session: string | undefined;
  const request = async (query: string) => {
    session ??= await runtime.store.createSession({
      discordUserId: "42",
      accountId: "default",
    });
    base ??= await startServer(runtime, options);
    return await requestWidget(base, query, session);
  };
  return {
    get base() {
      if (!base) {
        throw new Error("widget fixture has not issued a request");
      }
      return base;
    },
    runtime,
    widget: (params?: Parameters<typeof createWidget>[1]) => createWidget(runtime, params),
    request,
    recordPending: (widgetId: string, createdAt = 3) =>
      recordPendingLaunch(runtime, widgetId, createdAt),
    consumePending: () => consumePendingLaunch(runtime),
  };
}

describe("Discord Activity HTTP OAuth", () => {
  it.each([
    {
      name: "Activities are unconfigured",
      config: { channels: { discord: { token: "testtok" } } },
    },
    {
      name: "the client secret is unresolved",
      config: createActivityTestConfig({ clientSecret: "" }),
    },
    {
      name: "the bot token is unresolved",
      config: {
        channels: {
          discord: {
            token: { source: "env", provider: "default", id: "DISCORD_BOT_TOKEN" },
            activities: {
              clientSecret: "testsec",
              applicationId: "123456789012345678",
            },
          },
        },
      } as unknown as OpenClawConfig,
    },
  ])("leaves the public prefix externally absent when $name", async ({ config }) => {
    const base = await startServer(createActivityTestRuntime(config));

    const response = await fetch(`${base}/discord/activity/`);
    await expect(response.text()).resolves.toBe("not found");
    expect(response.status).toBe(404);
  });

  it("terminates stalled token request bodies within the read timeout", async () => {
    const base = await startServer(createActivityTestRuntime(), { bodyTimeoutMs: 25 });

    await expect(observeStalledTokenRequest(base, 1_000)).resolves.toBe("server-terminated");
  });

  it("exchanges a code, creates a session, and uses it on the widget endpoint", async () => {
    const runtime = createActivityTestRuntime();
    const widgetId = await createWidget(runtime);
    const base = await startServer(runtime, { fetchGuard: guardedJsonFetch() });

    const tokenResponse = await requestToken(base, { origin: activityOrigin });
    const token = (await tokenResponse.json()) as {
      access_token: string;
      session_token: string;
    };
    expect(tokenResponse.status).toBe(200);
    expect(token.access_token).toBe("atoken");
    expect(token.session_token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const widgetResponse = await requestWidget(
      base,
      `custom_id=${encodeURIComponent(buildDiscordActivityCustomId(widgetId))}&instance_id=instance-1`,
      token.session_token,
    );
    expect(widgetResponse.status).toBe(200);
    await expect(widgetResponse.json()).resolves.toMatchObject({
      id: widgetId,
      title: "Activity status",
    });
  });

  it("routes Discord API calls through the resolved account proxy fetch", async () => {
    const runtime = createActivityTestRuntime();
    const widgetId = await createWidget(runtime);
    const original = runtime.resolveHttpAccount();
    if (!original) {
      throw new Error("missing account");
    }
    const prox = vi.fn(async (input: string | URL | Request) => {
      const url = fetchInputUrl(input);
      const body = url.includes("/oauth2/token")
        ? { access_token: "atoken" }
        : url.includes("/activity-instances/")
          ? { location: { channel_id: "777" }, users: ["42"] }
          : { id: "42", username: "alice", discriminator: "0" };
      return new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json" },
      });
    });
    const account = { ...original, proxyFetch: prox as unknown as typeof fetch };
    vi.spyOn(runtime, "resolveHttpAccount").mockReturnValue(account);
    vi.spyOn(runtime, "resolveAccount").mockReturnValue(account);
    const guard = vi.fn(
      async (params: { url: string; init?: RequestInit; fetchImpl?: typeof fetch }) => {
        if (!params.fetchImpl) {
          throw new Error("missing proxy fetch");
        }
        return {
          response: await params.fetchImpl(params.url, params.init),
          release: vi.fn(async () => undefined),
        };
      },
    ) as unknown as typeof fetchWithSsrFGuard;
    const base = await startServer(runtime, { fetchGuard: guard });

    const tokenResponse = await requestToken(base);
    const token = (await tokenResponse.json()) as { session_token: string };
    expect(tokenResponse.status).toBe(200);
    const widgetResponse = await requestWidget(
      base,
      `custom_id=${widgetId}&instance_id=instance-1`,
      token.session_token,
    );

    expect(widgetResponse.status).toBe(200);
    expect(prox).toHaveBeenCalledTimes(3);
    expect(prox.mock.calls.map(([input]) => fetchInputUrl(input))).toEqual([
      "https://discord.com/api/oauth2/token",
      "https://discord.com/api/v10/users/@me",
      "https://discord.com/api/v10/applications/123456789012345678/activity-instances/instance-1",
    ]);
  });

  it("returns 401 for a rejected code", async () => {
    const base = await startServer(createActivityTestRuntime(), {
      fetchGuard: guardedJsonFetch({ tokenStatus: 400 }),
    });
    const response = await requestToken(base, { code: "bad-code" });
    expect(response.status).toBe(401);
  });

  it("lets a channel member outside the agent allowlist open the widget", async () => {
    const runtime = createActivityTestRuntime();
    const widgetId = await createWidget(runtime);
    const base = await startServer(runtime, {
      fetchGuard: guardedJsonFetch({ userId: "99", instanceUsers: ["99"] }),
    });
    const response = await requestToken(base);
    expect(response.status).toBe(200);
    const token = (await response.json()) as { session_token: string };

    const widgetResponse = await requestWidget(
      base,
      `custom_id=${widgetId}&instance_id=instance-1`,
      token.session_token,
    );
    expect(widgetResponse.status).toBe(200);
    await expect(widgetResponse.json()).resolves.toMatchObject({ id: widgetId });
  });

  it("limits token requests to ten per source IP per minute", async () => {
    const base = await startServer(createActivityTestRuntime(), { now: () => 1_000 });
    await requestTokens(
      base,
      10,
      () => ({ body: "{}" }),
      (response) => expect(response.status).toBe(401),
    );
    const limited = await requestToken(base, { body: "{}" });
    expect(limited.status).toBe(429);
  });

  it("does not charge malformed or unresolved requests to the global budget", async () => {
    const base = await startServer(createProxyAwareRuntime(), {
      fetchGuard: guardedJsonFetch(),
      now: () => 1_000,
    });
    await requestTokens(
      base,
      61,
      (index) => ({
        body: "{}",
        origin: `https://${100_000_000_000_000_000n + BigInt(index)}.discordsays.com`,
        forwardedFor: `198.51.100.${index + 1}`,
      }),
      (response) => expect(response.status).toBe(503),
    );
    await requestTokens(
      base,
      61,
      (index) => ({
        body: "{}",
        origin: activityOrigin,
        forwardedFor: `203.0.113.${index + 1}`,
      }),
      (response) => expect(response.status).toBe(401),
    );
    const legitimate = await requestToken(base, {
      code: "ok",
      origin: activityOrigin,
      forwardedFor: "192.0.2.250",
    });
    expect(legitimate.status).toBe(200);
  });

  it("does not charge Discord-rejected codes to the global budget", async () => {
    // Nonempty codes that Discord rejects must not consume login capacity, or a few
    // rotating sources could 429 every genuine launch with bogus-but-valid-shaped codes.
    const base = await startServer(createProxyAwareRuntime(), {
      fetchGuard: guardedJsonFetch({
        onExchange: (code) => (code === "bogus" ? 400 : 200),
      }),
      now: () => 1_000,
    });
    await requestTokens(
      base,
      61,
      (index) => ({
        code: "bogus",
        origin: activityOrigin,
        forwardedFor: `198.51.100.${index + 1}`,
      }),
      (response) => expect(response.status).toBe(401),
    );
    const legitimate = await requestToken(base, {
      code: "ok",
      origin: activityOrigin,
      forwardedFor: "192.0.2.250",
    });
    expect(legitimate.status).toBe(200);
  });

  it("reserves global capacity before concurrent exchanges complete", async () => {
    let releaseExchanges = () => {};
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchanges = resolve;
    });
    let exchangeCalls = 0;
    const guard = guardedJsonFetch({
      onExchange: async () => {
        exchangeCalls += 1;
        await exchangeGate;
      },
    });
    const base = await startServer(createProxyAwareRuntime(), {
      fetchGuard: guard,
      now: () => 1_000,
    });
    const pending = Array.from({ length: 60 }, (_, index) =>
      requestToken(base, {
        code: "ok",
        origin: activityOrigin,
        forwardedFor: `198.51.100.${index + 1}`,
      }),
    );
    let limited: Response;
    try {
      await vi.waitFor(() => expect(exchangeCalls).toBe(60), { timeout: 5_000 });
      limited = await requestToken(base, {
        code: "ok",
        origin: activityOrigin,
        forwardedFor: "192.0.2.250",
      });
    } finally {
      releaseExchanges();
    }
    expect(limited.status).toBe(429);
    const responses = await Promise.all(pending);
    expect(responses.every((response) => response.status === 200)).toBe(true);
  });

  it("limits valid token exchanges globally across rotating source IPs", async () => {
    const base = await startServer(createProxyAwareRuntime(), {
      fetchGuard: guardedJsonFetch(),
      now: () => 1_000,
    });
    await requestTokens(
      base,
      60,
      (index) => ({
        code: "ok",
        origin: activityOrigin,
        forwardedFor: `198.51.100.${index + 1}`,
      }),
      (response) => expect(response.status).toBe(200),
    );
    const limited = await requestToken(base, {
      code: "ok",
      origin: activityOrigin,
      forwardedFor: "192.0.2.250",
    });
    expect(limited.status).toBe(429);
  });
});

describe("Discord Activity widget routes", () => {
  it("requires a valid bearer session", async () => {
    const base = await startServer(createActivityTestRuntime());
    expect((await requestWidget(base, "instance_id=abc")).status).toBe(401);
    expect((await requestWidget(base, "instance_id=abc", "a".repeat(43))).status).toBe(401);
  });

  it("resolves a custom ID in the validated instance channel and consumes its doc token", async () => {
    const fixture = createWidgetFixture();
    const firstId = await fixture.widget({ createdAt: 1 });
    await fixture.widget({ createdAt: 2 });

    const direct = await fixture.request(
      `custom_id=${encodeURIComponent(buildDiscordActivityCustomId(firstId))}&instance_id=instance-1`,
    );
    expect(direct.status).toBe(200);
    const metadata = (await direct.json()) as { id: string; docUrl: string };
    expect(metadata.id).toBe(firstId);
    const documentUrl = new URL(metadata.docUrl, fixture.base);
    const firstDocument = await fetch(documentUrl);
    expect(firstDocument.status).toBe(200);
    const firstCsp = firstDocument.headers.get("content-security-policy");
    expect(firstCsp).toContain("sandbox allow-scripts");
    expect(firstCsp).toContain("connect-src 'none'");
    expect(await firstDocument.text()).toContain("document.body.dataset.ready");
    const secondDocument = await fetch(documentUrl);
    expect(secondDocument.status).toBe(404);
    const secondCsp = secondDocument.headers.get("content-security-policy");
    expect(secondCsp).toContain("sandbox allow-scripts");
    expect(secondCsp).toContain("connect-src 'none'");
  });

  it("retires the matching pending launch when its custom ID resolves", async () => {
    const fixture = createWidgetFixture();
    await fixture.widget({ createdAt: 1 });
    const launchedId = await fixture.widget({ createdAt: 2 });
    await fixture.recordPending(launchedId);

    const response = await fixture.request(
      `custom_id=${encodeURIComponent(buildDiscordActivityCustomId(launchedId))}&instance_id=instance-1`,
    );

    expect(response.status).toBe(200);
    // Lifecycle closed: a later click on a different widget must not be poisoned.
    await expect(fixture.consumePending()).resolves.toBeUndefined();
  });

  it("keeps a different-widget pending launch when a custom ID resolves", async () => {
    const fixture = createWidgetFixture();
    const requestedId = await fixture.widget({ createdAt: 1 });
    const pendingId = await fixture.widget({ createdAt: 2 });
    await fixture.recordPending(pendingId);

    const response = await fixture.request(
      `custom_id=${encodeURIComponent(buildDiscordActivityCustomId(requestedId))}&instance_id=instance-1`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: requestedId });
    await expect(fixture.consumePending()).resolves.toMatchObject({ widgetId: pendingId });
  });

  it.each(["", "ocactivity1_mangled"])(
    "resolves %j custom ID through the pending launch",
    async (customId) => {
      const fixture = createWidgetFixture();
      const pendingId = await fixture.widget({ createdAt: 1 });
      await fixture.widget({ createdAt: 2 });
      await fixture.recordPending(pendingId);

      const response = await fixture.request(
        `custom_id=${encodeURIComponent(customId)}&instance_id=instance-1`,
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ id: pendingId });
    },
  );

  it("falls through to the newest widget when overlapping launches target different widgets", async () => {
    const fixture = createWidgetFixture();
    const firstId = await fixture.widget({ createdAt: 1 });
    const newestId = await fixture.widget({ createdAt: 2 });
    await Promise.all([fixture.recordPending(firstId, 3), fixture.recordPending(newestId, 4)]);

    const response = await fixture.request("instance_id=instance-1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: newestId });
    await expect(fixture.consumePending()).resolves.toBeUndefined();
  });

  it("keeps a pending launch when the same widget is clicked twice", async () => {
    const runtime = createActivityTestRuntime();
    const widgetId = await createWidget(runtime, { createdAt: 1 });
    await recordPendingLaunch(runtime, widgetId, 2);
    await recordPendingLaunch(runtime, widgetId, 3);

    await expect(consumePendingLaunch(runtime)).resolves.toMatchObject({ widgetId });
  });

  it("consumes a pending launch after one widget resolution", async () => {
    const fixture = createWidgetFixture();
    const pendingId = await fixture.widget({ createdAt: 1 });
    const newestId = await fixture.widget({ createdAt: 2 });
    await fixture.recordPending(pendingId);

    const first = await fixture.request("instance_id=instance-1");
    const second = await fixture.request("instance_id=instance-1");

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ id: pendingId });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ id: newestId });
  });

  it("keeps pending launches isolated by Discord account", async () => {
    const runtime = createActivityTestRuntime();
    await recordPendingLaunch(runtime, "AAAAAAAAAAAAAAAAAAAAAA", 1, "account-b");

    await expect(consumePendingLaunch(runtime, "account-a")).resolves.toBeUndefined();
    await expect(consumePendingLaunch(runtime, "account-b")).resolves.toMatchObject({
      widgetId: "AAAAAAAAAAAAAAAAAAAAAA",
    });
  });

  it("keeps the newest-widget fallback when pending launch lookup fails", async () => {
    const logError = vi.fn();
    const fixture = createWidgetFixture({ fetchGuard: guardedJsonFetch(), logError });
    await fixture.widget({ createdAt: 1 });
    const newestId = await fixture.widget({ createdAt: 2 });
    const pendingLaunchLookup = vi
      .spyOn(fixture.runtime.store, "consumePendingLaunch")
      .mockRejectedValue(new Error("store offline"));
    for (let index = 0; index < 2; index += 1) {
      const response = await fixture.request("custom_id=missing&instance_id=instance-1");
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ id: newestId });
    }
    expect(pendingLaunchLookup).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledOnce();
  });

  it("rejects a custom ID outside the validated instance channel", async () => {
    const fixture = createWidgetFixture({
      fetchGuard: guardedJsonFetch({ channelId: "777" }),
    });
    const widgetId = await fixture.widget({ channelId: "888" });
    const response = await fixture.request(`custom_id=${widgetId}&instance_id=instance-1`);

    expect(response.status).toBe(404);
  });

  it("ignores a forged channel ID when no Activity instance is supplied", async () => {
    const fixture = createWidgetFixture({});
    await fixture.widget();
    const response = await fixture.request("channel_id=777");
    expect(response.status).toBe(404);
  });

  it("uses the Activity Instance API channel when exactly one widget matches", async () => {
    const guard = guardedJsonFetch({ channelId: "777" });
    const fixture = createWidgetFixture({ fetchGuard: guard });
    await fixture.widget({ channelId: "888", createdAt: 1 });
    const newestId = await fixture.widget({ channelId: "777", createdAt: 2 });
    const response = await fixture.request(
      "custom_id=missing&instance_id=instance-1&channel_id=888",
    );

    expect(response.status).toBe(200);
    expect((await response.json()) as { id: string }).toMatchObject({ id: newestId });
    expect(guard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://discord.com/api/v10/applications/123456789012345678/activity-instances/instance-1",
        init: expect.objectContaining({ headers: { Authorization: "Bot testtok" } }),
      }),
    );
  });

  it("uses the latest widget when a client omits the custom ID", async () => {
    const fixture = createWidgetFixture();
    await fixture.widget({ channelId: "777", createdAt: 1 });
    const newestId = await fixture.widget({ channelId: "777", createdAt: 2 });
    const response = await fixture.request("instance_id=instance-1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: newestId });
  });

  it("returns 404 when the Activity instance cannot be resolved", async () => {
    const fixture = createWidgetFixture({
      fetchGuard: guardedJsonFetch({ instanceStatus: 404 }),
    });
    await fixture.widget();
    const response = await fixture.request("instance_id=missing");
    expect(response.status).toBe(404);
  });

  it("returns 404 for a custom ID when the session user is absent from the Activity instance", async () => {
    const fixture = createWidgetFixture({
      fetchGuard: guardedJsonFetch({ instanceUsers: ["99"] }),
    });
    const widgetId = await fixture.widget();
    const response = await fixture.request(`custom_id=${widgetId}&instance_id=instance-1`);
    expect(response.status).toBe(404);
  });
});

describe("Discord Activity shell assets", () => {
  it("serves the generated SDK from a dist plugin root", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-activity-dist-"));
    const vendorAssetPath = path.join(
      root,
      "dist",
      "extensions",
      "discord",
      "assets",
      "embedded-app-sdk.mjs",
    );
    try {
      await fs.mkdir(path.dirname(vendorAssetPath), { recursive: true });
      await fs.writeFile(vendorAssetPath, "export class DiscordSDK {}\n");
      const base = await startServer(createActivityTestRuntime(), { vendorAssetPath });

      const vendor = await fetch(`${base}/discord/activity/vendor/embedded-app-sdk.mjs`);
      expect(vendor.status).toBe(200);
      await expect(vendor.text()).resolves.toContain("DiscordSDK");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("serves the shell, module, and generated SDK asset", async () => {
    // The SDK bundle is a gitignored build artifact absent from synced checkouts, so
    // the vendor read is injected; generation is covered by bundled-plugin-assets tests.
    const base = await startServer(createActivityTestRuntime(), {
      readVendorAsset: async () => Buffer.from("export class DiscordSDK {}\n"),
    });
    const shell = await fetch(`${base}/discord/activity/`);
    expect(shell.status).toBe(200);
    expect(await shell.text()).toContain('<script type="module" src="./shell.js">');
    const script = await fetch(`${base}/discord/activity/shell.js`);
    const scriptBody = await script.text();
    expect(scriptBody).toContain('from "./vendor/embedded-app-sdk.mjs"');
    expect(scriptBody).toContain("url.pathname.slice(gatewayPrefix.length)");
    expect(scriptBody).toContain("instance_id: sdk.instanceId");
    expect(scriptBody).not.toContain("channel_id: sdk.channelId");
    expect(scriptBody).toContain('frame.setAttribute("sandbox", "allow-scripts")');
    const vendor = await fetch(`${base}/discord/activity/vendor/embedded-app-sdk.mjs`);
    expect(vendor.status).toBe(200);
    expect(await vendor.text()).toContain("DiscordSDK");
  });

  it("returns 404 for the vendor asset when the bundle is missing", async () => {
    const base = await startServer(createActivityTestRuntime(), {
      readVendorAsset: async () => {
        throw new Error("missing");
      },
    });
    const vendor = await fetch(`${base}/discord/activity/vendor/embedded-app-sdk.mjs`);
    expect(vendor.status).toBe(404);
  });

  it("retries the vendor asset read after a transient failure", async () => {
    const readVendorAsset = vi
      .fn<(assetPath: string) => Promise<Buffer>>()
      .mockRejectedValueOnce(new Error("transient read failure"))
      .mockResolvedValue(Buffer.from("export class DiscordSDK {}\n"));
    const base = await startServer(createActivityTestRuntime(), { readVendorAsset });

    const first = await fetch(`${base}/discord/activity/vendor/embedded-app-sdk.mjs`);
    expect(first.status).toBe(404);
    const second = await fetch(`${base}/discord/activity/vendor/embedded-app-sdk.mjs`);
    expect(second.status).toBe(200);
    await expect(second.text()).resolves.toContain("DiscordSDK");
    expect(readVendorAsset).toHaveBeenCalledTimes(2);
  });
});
