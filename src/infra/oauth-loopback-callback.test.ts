import type { LookupAddress } from "node:dns";
import * as dnsPromises from "node:dns/promises";
import type { Server } from "node:http";
import { createServer } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getFreePort } from "../test-utils/ports.js";
import {
  startOAuthLoopbackCallbackServer,
  type OAuthLoopbackCallbackServer,
} from "./oauth-loopback-callback.js";

const openCallbacks: OAuthLoopbackCallbackServer[] = [];

afterEach(async () => {
  await Promise.all(openCallbacks.splice(0).map((callback) => callback.close()));
  vi.restoreAllMocks();
});

function callbackUrl(hostname: string, port: number, query = ""): string {
  const host = hostname.includes(":") ? `[${hostname}]` : hostname;
  return `http://${host}:${port}/oauth/callback${query}`;
}

async function getFreeIpv6Port(): Promise<number | undefined> {
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "::1", resolve);
    });
    const address = probe.address();
    return typeof address === "object" && address ? address.port : undefined;
  } catch {
    return undefined;
  } finally {
    await new Promise<void>((resolve) => {
      probe.close(() => resolve());
    });
  }
}

async function start(hostname = "127.0.0.1") {
  const port = hostname === "::1" ? await getFreeIpv6Port() : await getFreePort();
  if (!port) {
    return undefined;
  }
  const callback = await startOAuthLoopbackCallbackServer({
    redirectUrl: callbackUrl(hostname, port),
    expectedState: "state-1234567890",
    timeoutMs: 5_000,
  });
  openCallbacks.push(callback);
  return { callback, port };
}

describe("OAuth loopback callback server", () => {
  it("is listening before start resolves, returns the full response, then closes", async () => {
    const started = await start();
    if (!started) {
      throw new Error("IPv4 loopback unavailable");
    }
    const responsePromise = fetch(
      callbackUrl("127.0.0.1", started.port, "?code=authorization-code&state=state-1234567890"),
    ).then(async (response) => ({
      status: response.status,
      body: await response.text(),
      headers: response.headers,
    }));

    await expect(started.callback.waitForCallback()).resolves.toEqual({
      type: "authorization_code",
      code: "authorization-code",
      state: "state-1234567890",
    });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.body).toContain("Authorization received");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");

    await vi.waitFor(async () => {
      await expect(fetch(callbackUrl("127.0.0.1", started.port))).rejects.toThrow();
    });
  });

  it("keeps waiting after wrong path, method, missing state, and wrong state", async () => {
    const started = await start();
    if (!started) {
      throw new Error("IPv4 loopback unavailable");
    }
    const base = callbackUrl("127.0.0.1", started.port);
    expect((await fetch(`http://127.0.0.1:${started.port}/wrong`)).status).toBe(404);
    expect((await fetch(base, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${base}?code=code`)).status).toBe(400);
    expect((await fetch(`${base}?code=code&state=wrong`)).status).toBe(400);

    const response = await fetch(`${base}?code=right&state=state-1234567890`);
    expect(response.status).toBe(200);
    await response.text();
    await expect(started.callback.waitForCallback()).resolves.toMatchObject({
      type: "authorization_code",
      code: "right",
    });
  });

  it("settles a matching-state OAuth error after flushing its response", async () => {
    const started = await start();
    if (!started) {
      throw new Error("IPv4 loopback unavailable");
    }
    const responsePromise = fetch(
      callbackUrl(
        "127.0.0.1",
        started.port,
        "?error=access_denied&error_description=nope&state=state-1234567890",
      ),
    ).then(async (response) => ({ status: response.status, body: await response.text() }));

    await expect(started.callback.waitForCallback()).resolves.toEqual({
      type: "oauth_error",
      error: "access_denied",
      errorDescription: "nope",
    });
    await expect(responsePromise).resolves.toEqual({
      status: 400,
      body: "Authorization was not completed.",
    });
  });

  it("accepts only one concurrent valid callback", async () => {
    const started = await start();
    if (!started) {
      throw new Error("IPv4 loopback unavailable");
    }
    const url = callbackUrl("127.0.0.1", started.port, "?code=only-code&state=state-1234567890");
    const responses = await Promise.allSettled([fetch(url), fetch(url)]);
    const statuses = responses.flatMap((result) =>
      result.status === "fulfilled" ? [result.value.status] : [],
    );
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    await expect(started.callback.waitForCallback()).resolves.toMatchObject({ code: "only-code" });
  });

  it("rejects on timeout and abort and closes the listener", async () => {
    const timedOut = await start();
    if (!timedOut) {
      throw new Error("IPv4 loopback unavailable");
    }
    await timedOut.callback.close();
    await expect(timedOut.callback.waitForCallback()).rejects.toThrow("cancelled");

    const port = await getFreePort();
    const controller = new AbortController();
    const callback = await startOAuthLoopbackCallbackServer({
      redirectUrl: callbackUrl("127.0.0.1", port),
      expectedState: "state-1234567890",
      timeoutMs: 30,
      signal: controller.signal,
    });
    openCallbacks.push(callback);
    await expect(callback.waitForCallback()).rejects.toThrow("timeout");

    const abortPort = await getFreePort();
    const abortController = new AbortController();
    const aborted = await startOAuthLoopbackCallbackServer({
      redirectUrl: callbackUrl("127.0.0.1", abortPort),
      expectedState: "state-1234567890",
      timeoutMs: 5_000,
      signal: abortController.signal,
    });
    openCallbacks.push(aborted);
    abortController.abort();
    await expect(aborted.waitForCallback()).rejects.toThrow("cancelled");
  });

  it("observes aborts that arrive while localhost resolution is pending", async () => {
    let releaseLookup!: () => void;
    const pendingLookup = new Promise<LookupAddress[]>((resolve) => {
      releaseLookup = () => resolve([{ address: "127.0.0.1", family: 4 }]);
    });
    const controller = new AbortController();
    const port = await getFreePort();
    const startPromise = startOAuthLoopbackCallbackServer({
      redirectUrl: `http://localhost:${port}/oauth/callback`,
      expectedState: "state-1234567890",
      timeoutMs: 5_000,
      signal: controller.signal,
      lookup: () => pendingLookup,
    });
    controller.abort();
    await expect(startPromise).rejects.toThrow("cancelled");
    releaseLookup();
  });

  it("validates localhost resolution even with an explicit IPv4 bind host", async () => {
    await expect(
      startOAuthLoopbackCallbackServer({
        redirectUrl: "http://localhost:8989/oauth/callback",
        bindHostname: "127.0.0.1",
        expectedState: "state-1234567890",
        timeoutMs: 5_000,
        lookup: async () => [{ address: "203.0.113.1", family: 4 }],
      }),
    ).rejects.toThrow("exclusively to loopback");
  });

  it("binds every loopback address resolved for localhost", async () => {
    const port = await getFreePort();
    const addresses = [
      ...new Set(
        (await dnsPromises.lookup("localhost", { all: true, verbatim: true })).map(
          (entry) => entry.address,
        ),
      ),
    ];
    const callback = await startOAuthLoopbackCallbackServer({
      redirectUrl: `http://localhost:${port}/oauth/callback`,
      bindHostname: "127.0.0.1",
      expectedState: "state-1234567890",
      timeoutMs: 5_000,
    });
    openCallbacks.push(callback);

    for (const address of addresses) {
      const response = await fetch(callbackUrl(address, port, "?code=bad&state=wrong"));
      expect(response.status).toBe(400);
    }
    const response = await fetch(
      callbackUrl(addresses[0]!, port, "?code=right&state=state-1234567890"),
    );
    expect(response.status).toBe(200);
    await response.text();
    await expect(callback.waitForCallback()).resolves.toMatchObject({ code: "right" });
  });

  it("supports an IPv6 loopback redirect when IPv6 is available", async () => {
    const started = await start("::1");
    if (!started) {
      return;
    }
    const response = await fetch(
      callbackUrl("::1", started.port, "?code=ipv6&state=state-1234567890"),
    );
    expect(response.status).toBe(200);
    await response.text();
    await expect(started.callback.waitForCallback()).resolves.toMatchObject({ code: "ipv6" });
  });

  it("uses HTTP port 80 when the redirect omits a port and rejects port zero", async () => {
    let observedPort: number | undefined;
    const fakeServer = {
      listening: false,
      once: () => fakeServer,
      listen: (port: number, _hostname: string, callback: () => void) => {
        observedPort = port;
        fakeServer.listening = true;
        callback();
        return fakeServer;
      },
      removeAllListeners: () => fakeServer,
      on: () => fakeServer,
      close: (callback: () => void) => {
        fakeServer.listening = false;
        callback();
        return fakeServer;
      },
      closeAllConnections: () => undefined,
    };
    const callback = await startOAuthLoopbackCallbackServer({
      redirectUrl: "http://127.0.0.1/oauth/callback",
      expectedState: "state-1234567890",
      timeoutMs: 5_000,
      createServer: (() =>
        fakeServer as unknown as Server) as typeof import("node:http").createServer,
    });
    expect(observedPort).toBe(80);
    await callback.close();
    await expect(
      startOAuthLoopbackCallbackServer({
        redirectUrl: "http://127.0.0.1:0/oauth/callback",
        expectedState: "state-1234567890",
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow("valid TCP port");
  });
});
