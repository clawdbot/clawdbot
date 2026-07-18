import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDiscordActivityCustomId } from "../component-custom-id.js";
import { createDiscordActivityHttpHandler } from "./http.js";
import { DiscordActivitiesRuntime } from "./runtime.js";
import {
  createActivityTestConfig,
  createActivityTestRuntime,
  createMemoryActivityStore,
} from "./test-helpers.test-support.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

async function startServer(
  runtime: DiscordActivitiesRuntime,
  options: {
    fetchGuard?: typeof fetchWithSsrFGuard;
    now?: () => number;
    vendorAssetPath?: string;
    readVendorAsset?: (assetPath: string) => Promise<Buffer>;
    logError?: (message: string) => void;
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
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function guardedJsonFetch(params?: {
  tokenStatus?: number;
  userId?: string;
  instanceStatus?: number;
  channelId?: string;
  instanceUsers?: string[];
}) {
  return vi.fn(async ({ url }: { url: string }) => {
    const wantsExchange = url.includes("/oauth2/token");
    const wantsInstance = url.includes("/activity-instances/");
    const status = wantsExchange
      ? (params?.tokenStatus ?? 200)
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

describe("Discord Activity HTTP OAuth", () => {
  it("exchanges a code, creates a session, and uses it on the widget endpoint", async () => {
    const runtime = createActivityTestRuntime();
    const widgetId = await createWidget(runtime);
    const base = await startServer(runtime, { fetchGuard: guardedJsonFetch() });

    const tokenResponse = await fetch(`${base}/discord/activity/api/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://123456789012345678.discordsays.com",
      },
      body: JSON.stringify({ code: "oauth-code" }),
    });
    const token = (await tokenResponse.json()) as {
      access_token: string;
      session_token: string;
    };
    expect(tokenResponse.status).toBe(200);
    expect(token.access_token).toBe("atoken");
    expect(token.session_token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const widgetResponse = await fetch(
      `${base}/discord/activity/api/widget?custom_id=${encodeURIComponent(buildDiscordActivityCustomId(widgetId))}&instance_id=instance-1`,
      { headers: { Authorization: `Bearer ${token.session_token}` } },
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

    const tokenResponse = await fetch(`${base}/discord/activity/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "oauth-code" }),
    });
    const token = (await tokenResponse.json()) as { session_token: string };
    expect(tokenResponse.status).toBe(200);
    const widgetResponse = await fetch(
      `${base}/discord/activity/api/widget?custom_id=${widgetId}&instance_id=instance-1`,
      { headers: { Authorization: `Bearer ${token.session_token}` } },
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
    const response = await fetch(`${base}/discord/activity/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "bad-code" }),
    });
    expect(response.status).toBe(401);
  });

  it("lets a channel member outside the agent allowlist open the widget", async () => {
    const runtime = createActivityTestRuntime();
    const widgetId = await createWidget(runtime);
    const base = await startServer(runtime, {
      fetchGuard: guardedJsonFetch({ userId: "99", instanceUsers: ["99"] }),
    });
    const response = await fetch(`${base}/discord/activity/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "oauth-code" }),
    });
    expect(response.status).toBe(200);
    const token = (await response.json()) as { session_token: string };

    const widgetResponse = await fetch(
      `${base}/discord/activity/api/widget?custom_id=${widgetId}&instance_id=instance-1`,
      { headers: { Authorization: `Bearer ${token.session_token}` } },
    );
    expect(widgetResponse.status).toBe(200);
    await expect(widgetResponse.json()).resolves.toMatchObject({ id: widgetId });
  });

  it("returns 503 when the configured account no longer resolves a secret", async () => {
    const cfg = createActivityTestConfig({ clientSecret: "" });
    const runtime = new DiscordActivitiesRuntime(createMemoryActivityStore(), cfg, undefined, {});
    const base = await startServer(runtime);
    const response = await fetch(`${base}/discord/activity/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "oauth-code" }),
    });
    expect(response.status).toBe(503);
  });

  it("limits token requests to ten per source IP per minute", async () => {
    const base = await startServer(createActivityTestRuntime(), { now: () => 1_000 });
    for (let index = 0; index < 10; index += 1) {
      const response = await fetch(`${base}/discord/activity/api/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(401);
    }
    const limited = await fetch(`${base}/discord/activity/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(limited.status).toBe(429);
  });

  it("does not charge malformed or unresolved requests to the global budget", async () => {
    const base = await startServer(createProxyAwareRuntime(), {
      fetchGuard: guardedJsonFetch(),
      now: () => 1_000,
    });
    for (let index = 0; index < 61; index += 1) {
      const response = await fetch(`${base}/discord/activity/api/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: `https://${100_000_000_000_000_000n + BigInt(index)}.discordsays.com`,
          "X-Forwarded-For": `198.51.100.${index + 1}`,
        },
        body: "{}",
      });
      expect(response.status).toBe(503);
    }
    for (let index = 0; index < 61; index += 1) {
      const response = await fetch(`${base}/discord/activity/api/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://123456789012345678.discordsays.com",
          "X-Forwarded-For": `203.0.113.${index + 1}`,
        },
        body: "{}",
      });
      expect(response.status).toBe(401);
    }
    const legitimate = await fetch(`${base}/discord/activity/api/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://123456789012345678.discordsays.com",
        "X-Forwarded-For": "192.0.2.250",
      },
      body: JSON.stringify({ code: "ok" }),
    });
    expect(legitimate.status).toBe(200);
  });

  it("does not charge Discord-rejected codes to the global budget", async () => {
    // Nonempty codes that Discord rejects must not consume login capacity, or a few
    // rotating sources could 429 every genuine launch with bogus-but-valid-shaped codes.
    const rejectBogusCode = vi.fn(async ({ url, init }: { url: string; init?: RequestInit }) => {
      const wantsExchange = url.includes("/oauth2/token");
      const code = init?.body instanceof URLSearchParams ? init.body.get("code") : null;
      const status = wantsExchange && code === "bogus" ? 400 : 200;
      const body = wantsExchange
        ? { access_token: "atoken" }
        : { id: "42", username: "alice", discriminator: "0" };
      return {
        response: new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
        release: vi.fn(async () => undefined),
      };
    }) as unknown as typeof fetchWithSsrFGuard;
    const base = await startServer(createProxyAwareRuntime(), {
      fetchGuard: rejectBogusCode,
      now: () => 1_000,
    });
    for (let index = 0; index < 61; index += 1) {
      const response = await fetch(`${base}/discord/activity/api/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://123456789012345678.discordsays.com",
          "X-Forwarded-For": `198.51.100.${index + 1}`,
        },
        body: JSON.stringify({ code: "bogus" }),
      });
      expect(response.status).toBe(401);
    }
    const legitimate = await fetch(`${base}/discord/activity/api/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://123456789012345678.discordsays.com",
        "X-Forwarded-For": "192.0.2.250",
      },
      body: JSON.stringify({ code: "ok" }),
    });
    expect(legitimate.status).toBe(200);
  });

  it("reserves global capacity before concurrent exchanges complete", async () => {
    let releaseExchanges = () => {};
    const exchangeGate = new Promise<void>((resolve) => {
      releaseExchanges = resolve;
    });
    let exchangeCalls = 0;
    const guard = vi.fn(async ({ url }: { url: string }) => {
      const wantsExchange = url.includes("/oauth2/token");
      if (wantsExchange) {
        exchangeCalls += 1;
        await exchangeGate;
      }
      const body = wantsExchange
        ? { access_token: "atoken" }
        : { id: "42", username: "alice", discriminator: "0" };
      return {
        response: new Response(JSON.stringify(body), {
          headers: { "Content-Type": "application/json" },
        }),
        release: vi.fn(async () => undefined),
      };
    }) as unknown as typeof fetchWithSsrFGuard;
    const base = await startServer(createProxyAwareRuntime(), {
      fetchGuard: guard,
      now: () => 1_000,
    });
    const pending = Array.from({ length: 60 }, (_, index) =>
      fetch(`${base}/discord/activity/api/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://123456789012345678.discordsays.com",
          "X-Forwarded-For": `198.51.100.${index + 1}`,
        },
        body: JSON.stringify({ code: "ok" }),
      }),
    );
    let limited: Response;
    try {
      await vi.waitFor(() => expect(exchangeCalls).toBe(60), { timeout: 5_000 });
      limited = await fetch(`${base}/discord/activity/api/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://123456789012345678.discordsays.com",
          "X-Forwarded-For": "192.0.2.250",
        },
        body: JSON.stringify({ code: "ok" }),
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
    for (let index = 0; index < 60; index += 1) {
      const response = await fetch(`${base}/discord/activity/api/token`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://123456789012345678.discordsays.com",
          "X-Forwarded-For": `198.51.100.${index + 1}`,
        },
        body: JSON.stringify({ code: "ok" }),
      });
      expect(response.status).toBe(200);
    }
    const limited = await fetch(`${base}/discord/activity/api/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://123456789012345678.discordsays.com",
        "X-Forwarded-For": "192.0.2.250",
      },
      body: JSON.stringify({ code: "ok" }),
    });
    expect(limited.status).toBe(429);
  });
});

describe("Discord Activity widget routes", () => {
  it("requires a valid bearer session", async () => {
    const base = await startServer(createActivityTestRuntime());
    expect((await fetch(`${base}/discord/activity/api/widget?instance_id=abc`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/discord/activity/api/widget?instance_id=abc`, {
          headers: { Authorization: `Bearer ${"a".repeat(43)}` },
        })
      ).status,
    ).toBe(401);
  });

  it("resolves a custom ID in the validated instance channel and consumes its doc token", async () => {
    const runtime = createActivityTestRuntime();
    const firstId = await createWidget(runtime, { createdAt: 1 });
    await createWidget(runtime, { createdAt: 2 });
    const session = await runtime.store.createSession({
      discordUserId: "42",
      accountId: "default",
    });
    const base = await startServer(runtime, { fetchGuard: guardedJsonFetch() });

    const direct = await fetch(
      `${base}/discord/activity/api/widget?custom_id=${encodeURIComponent(buildDiscordActivityCustomId(firstId))}&instance_id=instance-1`,
      { headers: { Authorization: `Bearer ${session}` } },
    );
    expect(direct.status).toBe(200);
    const metadata = (await direct.json()) as { id: string; docUrl: string };
    expect(metadata.id).toBe(firstId);
    const documentUrl = new URL(metadata.docUrl, base);
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
    const runtime = createActivityTestRuntime();
    await createWidget(runtime, { createdAt: 1 });
    const launchedId = await createWidget(runtime, { createdAt: 2 });
    await runtime.store.recordPendingLaunch({
      accountId: "default",
      channelId: "777",
      discordUserId: "42",
      widgetId: launchedId,
      createdAt: 3,
    });
    const session = await runtime.store.createSession({
      discordUserId: "42",
      accountId: "default",
    });
    const base = await startServer(runtime, { fetchGuard: guardedJsonFetch() });

    const response = await fetch(
      `${base}/discord/activity/api/widget?custom_id=${encodeURIComponent(buildDiscordActivityCustomId(launchedId))}&instance_id=instance-1`,
      { headers: { Authorization: `Bearer ${session}` } },
    );

    expect(response.status).toBe(200);
    // Lifecycle closed: a later click on a different widget must not be poisoned.
    await expect(
      runtime.store.consumePendingLaunch("default", "777", "42"),
    ).resolves.toBeUndefined();
  });

  it("keeps a different-widget pending launch when a custom ID resolves", async () => {
    const runtime = createActivityTestRuntime();
    const requestedId = await createWidget(runtime, { createdAt: 1 });
    const pendingId = await createWidget(runtime, { createdAt: 2 });
    await runtime.store.recordPendingLaunch({
      accountId: "default",
      channelId: "777",
      discordUserId: "42",
      widgetId: pendingId,
      createdAt: 3,
    });
    const session = await runtime.store.createSession({
      discordUserId: "42",
      accountId: "default",
    });
    const base = await startServer(runtime, { fetchGuard: guardedJsonFetch() });

    const response = await fetch(
      `${base}/discord/activity/api/widget?custom_id=${encodeURIComponent(buildDiscordActivityCustomId(requestedId))}&instance_id=instance-1`,
      { headers: { Authorization: `Bearer ${session}` } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: requestedId });
    await expect(runtime.store.consumePendingLaunch("default", "777", "42")).resolves.toMatchObject(
      { widgetId: pendingId },
    );
  });

  it.each(["", "ocactivity1_mangled"])(
    "resolves %j custom ID through the pending launch",
    async (customId) => {
      const runtime = createActivityTestRuntime();
      const pendingId = await createWidget(runtime, { createdAt: 1 });
      await createWidget(runtime, { createdAt: 2 });
      await runtime.store.recordPendingLaunch({
        accountId: "default",
        channelId: "777",
        discordUserId: "42",
        widgetId: pendingId,
        createdAt: 3,
      });
      const session = await runtime.store.createSession({
        discordUserId: "42",
        accountId: "default",
      });
      const base = await startServer(runtime, { fetchGuard: guardedJsonFetch() });

      const response = await fetch(
        `${base}/discord/activity/api/widget?custom_id=${encodeURIComponent(customId)}&instance_id=instance-1`,
        { headers: { Authorization: `Bearer ${session}` } },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ id: pendingId });
    },
  );

  it("falls through to the newest widget when overlapping launches target different widgets", async () => {
    const runtime = createActivityTestRuntime();
    const firstId = await createWidget(runtime, { createdAt: 1 });
    const newestId = await createWidget(runtime, { createdAt: 2 });
    const record = (widgetId: string, createdAt: number) =>
      runtime.store.recordPendingLaunch({
        accountId: "default",
        channelId: "777",
        discordUserId: "42",
        widgetId,
        createdAt,
      });
    await Promise.all([record(firstId, 3), record(newestId, 4)]);
    const session = await runtime.store.createSession({
      discordUserId: "42",
      accountId: "default",
    });
    const base = await startServer(runtime, { fetchGuard: guardedJsonFetch() });

    const response = await fetch(`${base}/discord/activity/api/widget?instance_id=instance-1`, {
      headers: { Authorization: `Bearer ${session}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: newestId });
    await expect(
      runtime.store.consumePendingLaunch("default", "777", "42"),
    ).resolves.toBeUndefined();
  });

  it("keeps a pending launch when the same widget is clicked twice", async () => {
    const runtime = createActivityTestRuntime();
    const widgetId = await createWidget(runtime, { createdAt: 1 });
    const record = (createdAt: number) =>
      runtime.store.recordPendingLaunch({
        accountId: "default",
        channelId: "777",
        discordUserId: "42",
        widgetId,
        createdAt,
      });
    await record(2);
    await record(3);

    await expect(runtime.store.consumePendingLaunch("default", "777", "42")).resolves.toMatchObject(
      { widgetId },
    );
  });

  it("consumes a pending launch after one widget resolution", async () => {
    const runtime = createActivityTestRuntime();
    const pendingId = await createWidget(runtime, { createdAt: 1 });
    const newestId = await createWidget(runtime, { createdAt: 2 });
    await runtime.store.recordPendingLaunch({
      accountId: "default",
      channelId: "777",
      discordUserId: "42",
      widgetId: pendingId,
      createdAt: 3,
    });
    const session = await runtime.store.createSession({
      discordUserId: "42",
      accountId: "default",
    });
    const base = await startServer(runtime, { fetchGuard: guardedJsonFetch() });
    const url = `${base}/discord/activity/api/widget?instance_id=instance-1`;

    const first = await fetch(url, { headers: { Authorization: `Bearer ${session}` } });
    const second = await fetch(url, { headers: { Authorization: `Bearer ${session}` } });

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ id: pendingId });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ id: newestId });
  });

  it("keeps pending launches isolated by Discord account", async () => {
    const runtime = createActivityTestRuntime();
    await runtime.store.recordPendingLaunch({
      accountId: "account-b",
      channelId: "777",
      discordUserId: "42",
      widgetId: "AAAAAAAAAAAAAAAAAAAAAA",
      createdAt: 1,
    });

    await expect(
      runtime.store.consumePendingLaunch("account-a", "777", "42"),
    ).resolves.toBeUndefined();
    await expect(
      runtime.store.consumePendingLaunch("account-b", "777", "42"),
    ).resolves.toMatchObject({ widgetId: "AAAAAAAAAAAAAAAAAAAAAA" });
  });

  it("keeps the newest-widget fallback when pending launch lookup fails", async () => {
    const runtime = createActivityTestRuntime();
    await createWidget(runtime, { createdAt: 1 });
    const newestId = await createWidget(runtime, { createdAt: 2 });
    const session = await runtime.store.createSession({
      discordUserId: "42",
      accountId: "default",
    });
    const consumePendingLaunch = vi
      .spyOn(runtime.store, "consumePendingLaunch")
      .mockRejectedValue(new Error("store offline"));
    const logError = vi.fn();
    const base = await startServer(runtime, {
      fetchGuard: guardedJsonFetch(),
      logError,
    });
    const url = `${base}/discord/activity/api/widget?custom_id=missing&instance_id=instance-1`;

    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${session}` } });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ id: newestId });
    }
    expect(consumePendingLaunch).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledOnce();
  });

  it("rejects a custom ID outside the validated instance channel", async () => {
    const runtime = createActivityTestRuntime();
    const widgetId = await createWidget(runtime, { channelId: "888" });
    const session = await runtime.store.createSession({
      discordUserId: "42",
      accountId: "default",
    });
    const base = await startServer(runtime, {
      fetchGuard: guardedJsonFetch({ channelId: "777" }),
    });
    const response = await fetch(
      `${base}/discord/activity/api/widget?custom_id=${widgetId}&instance_id=instance-1`,
      { headers: { Authorization: `Bearer ${session}` } },
    );

    expect(response.status).toBe(404);
  });

  it("ignores a forged channel ID when no Activity instance is supplied", async () => {
    const runtime = createActivityTestRuntime();
    await createWidget(runtime);
    const session = await runtime.store.createSession({
      discordUserId: "42",
      accountId: "default",
    });
    const base = await startServer(runtime);
    const response = await fetch(`${base}/discord/activity/api/widget?channel_id=777`, {
      headers: { Authorization: `Bearer ${session}` },
    });
    expect(response.status).toBe(404);
  });

  it("uses the Activity Instance API channel when exactly one widget matches", async () => {
    const runtime = createActivityTestRuntime();
    await createWidget(runtime, { channelId: "888", createdAt: 1 });
    const newestId = await createWidget(runtime, { channelId: "777", createdAt: 2 });
    const session = await runtime.store.createSession({
      discordUserId: "42",
      accountId: "default",
    });
    const guard = guardedJsonFetch({ channelId: "777" });
    const base = await startServer(runtime, { fetchGuard: guard });
    const response = await fetch(
      `${base}/discord/activity/api/widget?custom_id=missing&instance_id=instance-1&channel_id=888`,
      { headers: { Authorization: `Bearer ${session}` } },
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
    const runtime = createActivityTestRuntime();
    await createWidget(runtime, { channelId: "777", createdAt: 1 });
    const newestId = await createWidget(runtime, { channelId: "777", createdAt: 2 });
    const session = await runtime.store.createSession({
      discordUserId: "42",
      accountId: "default",
    });
    const base = await startServer(runtime, { fetchGuard: guardedJsonFetch() });
    const response = await fetch(`${base}/discord/activity/api/widget?instance_id=instance-1`, {
      headers: { Authorization: `Bearer ${session}` },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ id: newestId });
  });

  it("returns 404 when the Activity instance cannot be resolved", async () => {
    const runtime = createActivityTestRuntime();
    await createWidget(runtime);
    const session = await runtime.store.createSession({
      discordUserId: "42",
      accountId: "default",
    });
    const base = await startServer(runtime, {
      fetchGuard: guardedJsonFetch({ instanceStatus: 404 }),
    });
    const response = await fetch(`${base}/discord/activity/api/widget?instance_id=missing`, {
      headers: { Authorization: `Bearer ${session}` },
    });
    expect(response.status).toBe(404);
  });

  it("returns 404 for a custom ID when the session user is absent from the Activity instance", async () => {
    const runtime = createActivityTestRuntime();
    const widgetId = await createWidget(runtime);
    const session = await runtime.store.createSession({
      discordUserId: "42",
      accountId: "default",
    });
    const base = await startServer(runtime, {
      fetchGuard: guardedJsonFetch({ instanceUsers: ["99"] }),
    });
    const response = await fetch(
      `${base}/discord/activity/api/widget?custom_id=${widgetId}&instance_id=instance-1`,
      { headers: { Authorization: `Bearer ${session}` } },
    );
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
