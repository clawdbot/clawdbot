import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import {
  buildConnector,
  fetch as undiciFetch,
  getGlobalDispatcher,
  Headers,
  Pool,
  ProxyAgent,
  setGlobalDispatcher,
} from "undici";
import { describe, expect, it, vi } from "vitest";
import {
  PROXY_FIXTURE_HOST as TARGET_HOST,
  PROXY_FIXTURE_PAYLOAD as PAYLOAD,
  withProxyFixture,
} from "../../test-fixtures/proxy-fixture.js";
import { fetchWithSsrFGuard } from "./fetch-guard.js";
import { resolveProxyFetchFromEnv } from "./proxy-fetch.js";
import {
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
} from "./proxy/active-proxy-state.js";
import * as familyPolicy from "./undici-family-policy.js";
import {
  ensureGlobalUndiciDispatcherStreamTimeouts,
  forceResetGlobalDispatcher,
  resetGlobalUndiciStreamTimeoutsForTests,
} from "./undici-global-dispatcher.js";
import * as undiciRuntime from "./undici-runtime.js";
import { createHttp1EnvHttpProxyAgent, createHttp1ProxyAgent } from "./undici-runtime.js";

const TARGET_URL = `https://${TARGET_HOST}/media`;

async function fetchPayload(
  dispatcher: ReturnType<typeof createHttp1ProxyAgent>,
  protocolProof?: Promise<void>,
) {
  try {
    await Promise.all([
      undiciFetch(TARGET_URL, { dispatcher, signal: AbortSignal.timeout(5_000) }).then(
        async (response) => {
          expect(await response.text()).toBe(PAYLOAD);
        },
      ),
      protocolProof,
    ]);
  } finally {
    await dispatcher.destroy();
  }
}

describe("SOCKS proxy protocol boundaries", () => {
  it.each(
    ["http", "socks5"].flatMap((protocol) => [
      {
        protocol,
        input: "conflicting credentials",
        options: { auth: "fixture-auth", token: "fixture-token" },
        error: "opts.auth cannot be used in combination with opts.token",
      },
      {
        protocol,
        input: "null clientFactory",
        options: { clientFactory: null },
        error: "Proxy opts.clientFactory must be a function.",
      },
    ]),
  )("preserves $protocol constructor refusal for $input", async ({ protocol, options, error }) => {
    let dispatcher: ReturnType<typeof createHttp1ProxyAgent> | undefined;
    try {
      expect(() => {
        // JavaScript SDK callers can supply malformed constructor options.
        dispatcher = Reflect.apply(createHttp1ProxyAgent, undefined, [
          { uri: `${protocol}://127.0.0.1:1080`, ...options },
        ]);
      }).toThrow(error);
    } finally {
      await dispatcher?.destroy();
    }
  });

  it.each(["socks:", "socks5:"])(
    "keeps %s proxies plaintext with generated timeout/family defaults",
    async (protocol) => {
      await withProxyFixture(async ({ socksProxy, connections, certificate }) => {
        await fetchPayload(
          createHttp1ProxyAgent(
            { uri: socksProxy.replace("socks5:", protocol), requestTls: { ca: certificate } },
            5_000,
          ),
        );
        expect(connections).toEqual([`socks:${TARGET_HOST}`]);
      });
    },
  );

  it.each(["fixed", "environment"])(
    "authenticates decoded SOCKS URL credentials through the %s helper",
    async (mode) => {
      const credentials = { username: "fixture@user:space %", password: "fixture:p@ss/%" };
      await withProxyFixture(async ({ socksProxy, certificate, connections, originRoutes }) => {
        const url = new URL(socksProxy);
        url.username = encodeURIComponent(credentials.username);
        const create = () => {
          const options = { requestTls: { ca: certificate } };
          return mode === "environment"
            ? createHttp1EnvHttpProxyAgent({ ...options, httpsProxy: url.href, noProxy: "" })
            : createHttp1ProxyAgent({ ...options, uri: url.href });
        };
        url.password = encodeURIComponent(`${credentials.password}-wrong`);
        const rejected = create();
        try {
          await expect(
            undiciFetch(TARGET_URL, { dispatcher: rejected, signal: AbortSignal.timeout(5_000) }),
          ).rejects.toMatchObject({ cause: { code: "UND_ERR_SOCKS5_AUTH_FAILED" } });
          expect(connections).toEqual([]);
          expect(originRoutes).toEqual([]);
        } finally {
          await rejected.destroy();
        }
        url.password = encodeURIComponent(credentials.password);
        await fetchPayload(create());
        expect(connections).toEqual([`socks:${TARGET_HOST}`]);
        expect(originRoutes).toEqual(["proxy"]);
      }, credentials);
    },
  );

  it.each(["explicit", "environment", "custom-http", "forward-http"])(
    "preserves TCP policy on the actual %s proxy connection",
    async (mode) => {
      const family = vi
        .spyOn(familyPolicy, "resolveUndiciAutoSelectFamilyConnectOptions")
        .mockReturnValue({ autoSelectFamily: false, autoSelectFamilyAttemptTimeout: 321 });
      const connect = vi.spyOn(net, "connect");
      const keepAlive = vi.spyOn(net.Socket.prototype, "setKeepAlive");
      try {
        await withProxyFixture(async ({ socksProxy, httpProxy, httpOrigin, certificate }) => {
          const options = {
            requestTls: { ca: certificate },
            connect: {
              family: 4,
              keepAlive: mode !== "forward-http",
              keepAliveInitialDelay: 30_000,
            },
            ...(mode === "custom-http" ? { proxyTls: { keepAliveInitialDelay: 7_000 } } : {}),
          };
          const clientFactory = vi.fn(
            (origin: URL, poolOptions: object) => new Pool(origin, poolOptions),
          );
          const proxyUrl =
            mode === "forward-http" ? httpOrigin : mode === "custom-http" ? httpProxy : socksProxy;
          const dispatcher =
            mode === "environment"
              ? createHttp1EnvHttpProxyAgent({ ...options, httpsProxy: proxyUrl, noProxy: "" })
              : createHttp1ProxyAgent({
                  ...options,
                  uri: proxyUrl,
                  proxyTunnel: mode !== "forward-http",
                  ...(mode === "custom-http" ? { clientFactory } : {}),
                });
          if (mode === "forward-http") {
            try {
              const response = await undiciFetch(`http://${TARGET_HOST}/media`, { dispatcher });
              expect(await response.text()).toBe(PAYLOAD);
            } finally {
              await dispatcher.destroy();
            }
          } else {
            await fetchPayload(dispatcher);
          }
          const proxyPort = Number(new URL(proxyUrl).port);
          if (mode === "custom-http") {
            expect(clientFactory).toHaveBeenCalledOnce();
          }
          const socketCalls: ReadonlyArray<readonly unknown[]> = connect.mock.calls;
          const proxyIndex = socketCalls.findIndex(
            ([value]) =>
              value !== null &&
              typeof value === "object" &&
              "port" in value &&
              Number(value.port) === proxyPort,
          );
          const proxySocket = connect.mock.results[proxyIndex]?.value;
          expect({
            options: socketCalls[proxyIndex]?.[0],
            keepAliveCalls: keepAlive.mock.calls.filter(
              (_, index) => keepAlive.mock.contexts[index] === proxySocket,
            ),
          }).toMatchObject({
            options: {
              family: 4,
              autoSelectFamily: false,
              autoSelectFamilyAttemptTimeout: 321,
            },
            keepAliveCalls:
              mode === "forward-http" ? [] : [[true, mode === "custom-http" ? 7_000 : 30_000]],
          });
        });
      } finally {
        connect.mockRestore();
        keepAlive.mockRestore();
        family.mockRestore();
      }
    },
  );

  // Each row owns its server, sockets, and dispatcher, so native deadline waits can overlap.
  it.concurrent.each([
    { name: "fixed target", mode: "fixed", stall: "target", target: 100, proxy: 0 },
    { name: "environment target", mode: "environment", stall: "target", target: 100, proxy: 0 },
    {
      name: "target despite wrapper budget",
      mode: "fixed",
      stall: "target",
      target: 100,
      proxy: 0,
      budget: 5_000,
    },
    {
      name: "request TLS override",
      mode: "fixed",
      stall: "target",
      target: 0,
      proxy: 0,
      request: 100,
      budget: 5_000,
    },
    { name: "proxy TLS override", mode: "fixed", stall: "proxy", target: 0, proxy: 100 },
    {
      name: "wrapper proxy budget",
      mode: "fixed",
      stall: "proxy",
      target: 0,
      proxy: 0,
      budget: 100,
    },
    {
      name: "wrapper over null proxy default",
      mode: "fixed",
      stall: "proxy",
      target: 0,
      proxy: null,
      budget: 100,
    },
    {
      name: "native null proxy default",
      mode: "native",
      stall: "proxy",
      target: 0,
      proxy: null,
      defaultProxyTimeout: true,
    },
    {
      name: "fixed null HTTPS proxy default",
      mode: "fixed",
      stall: "proxy",
      target: 0,
      proxy: null,
      defaultProxyTimeout: true,
    },
    {
      name: "environment undefined HTTPS proxy default",
      mode: "environment",
      stall: "proxy",
      target: 0,
      proxy: undefined,
      defaultProxyTimeout: true,
    },
    {
      name: "fixed null SOCKS TLS proxy default",
      mode: "fixed",
      stall: "proxy",
      target: 0,
      proxy: null,
      protocol: "socks5",
      defaultProxyTimeout: true,
    },
    {
      name: "environment undefined SOCKS TLS proxy default",
      mode: "environment",
      stall: "proxy",
      target: 0,
      proxy: undefined,
      protocol: "socks5",
      defaultProxyTimeout: true,
    },
    {
      name: "fixed direct-only connector timeout",
      mode: "fixed",
      stall: "proxy",
      target: undefined,
      generic: 0,
      omitProxyTimeout: true,
      defaultProxyTimeout: true,
    },
    {
      name: "environment direct-only connector timeout",
      mode: "environment",
      stall: "proxy",
      target: undefined,
      generic: 0,
      omitProxyTimeout: true,
      protocol: "socks5",
      defaultProxyTimeout: true,
    },
  ])(
    "preserves the independent $name deadline",
    async ({
      mode,
      stall,
      target,
      proxy,
      request,
      budget,
      protocol,
      defaultProxyTimeout,
      generic,
      omitProxyTimeout,
    }) => {
      const server = stall === "proxy" ? net.createServer() : http.createServer();
      const sockets = new Set<net.Socket>();
      let sawTlsHandshake = false;
      const observeTls = (chunk: Buffer) => {
        sawTlsHandshake = chunk[0] === 22;
      };
      server.on("connection", (socket: net.Socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.once("close", () => sockets.delete(socket));
        if (stall === "proxy") {
          socket.once("data", observeTls);
        }
      });
      if (server instanceof http.Server) {
        server.on("connect", (_request, socket) => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          socket.once("data", observeTls);
        });
      }
      let dispatcher: ReturnType<typeof createHttp1ProxyAgent> | undefined;
      try {
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("expected a listening loopback proxy");
        }
        const uri = `${protocol ?? (stall === "proxy" ? "https" : "http")}://127.0.0.1:${address.port}`;
        const options = {
          connectTimeout: target,
          proxyTls: omitProxyTimeout ? {} : { timeout: proxy },
          ...(generic === undefined ? {} : { connect: { timeout: generic } }),
          ...(request === undefined ? {} : { requestTls: { timeout: request } }),
        };
        if (mode === "environment") {
          dispatcher = createHttp1EnvHttpProxyAgent(
            // @ts-expect-error Undici's Node TLS intersection rejects its runtime-valid null timeout.
            { ...options, httpProxy: uri, httpsProxy: uri, noProxy: "" },
            budget,
          );
        } else if (mode === "native") {
          // Raw Undici forwards the proxy IP as SNI; a DNS name keeps this a timeout probe.
          const nativeOptions = {
            ...options,
            uri,
            proxyTls: { ...options.proxyTls, servername: "proxy.test" },
          };
          // @ts-expect-error Undici's Node TLS intersection rejects its runtime-valid null timeout.
          dispatcher = new ProxyAgent(nativeOptions);
        } else {
          // @ts-expect-error Undici's Node TLS intersection rejects its runtime-valid null timeout.
          dispatcher = createHttp1ProxyAgent({ ...options, uri }, budget);
        }
        const outcome = await undiciFetch(TARGET_URL, {
          dispatcher,
          // Undici's explicit null/undefined timeout contract uses its 10-second default.
          signal: AbortSignal.timeout(defaultProxyTimeout ? 12_000 : 2_000),
        }).catch((error: unknown) => error);
        expect(sawTlsHandshake).toBe(true);
        expect(outcome).toMatchObject({ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
      } finally {
        for (const socket of sockets) {
          socket.destroy();
        }
        await dispatcher?.destroy();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
    15_000,
  );

  it.each(["object", "flat array", "Headers", "inherited object"])(
    "rejects per-request proxy credentials from %s before any SOCKS dispatch",
    async (form) => {
      await withProxyFixture(async ({ socksProxy, connections, originRoutes }) => {
        const dispatcher = form.endsWith("object")
          ? createHttp1ProxyAgent(socksProxy)
          : createHttp1EnvHttpProxyAgent({ httpProxy: socksProxy, noProxy: "" });
        const auth = { "pRoXy-AuThOrIzAtIoN": "Basic fixture-proxy-only" };
        const inherited = {};
        Object.setPrototypeOf(inherited, auth);
        try {
          const request =
            form === "Headers"
              ? undiciFetch(`http://${TARGET_HOST}/media`, {
                  dispatcher,
                  headers: new Headers(auth),
                })
              : dispatcher.request({
                  origin: `http://${TARGET_HOST}`,
                  path: "/media",
                  method: "GET",
                  headers:
                    form === "flat array"
                      ? Object.entries(auth).flat()
                      : form === "inherited object"
                        ? inherited
                        : auth,
                });
          const error = { code: "UND_ERR_INVALID_ARG" };
          await expect(request).rejects.toMatchObject(
            form === "Headers" ? { cause: error } : error,
          );
          expect(connections).toEqual([]);
          expect(originRoutes).toEqual([]);
          const response = await dispatcher.request({
            origin: `http://${TARGET_HOST}`,
            path: "/media",
            method: "GET",
            headers: { Authorization: "Bearer fixture-origin-only" },
          });
          expect(await response.body.text()).toBe(PAYLOAD);
          expect(connections).toEqual([`socks:${TARGET_HOST}`]);
        } finally {
          await dispatcher.destroy();
        }
      });
    },
  );

  it("preserves explicitly requested SOCKS-over-TLS", async () => {
    await withProxyFixture(async ({ tlsSocksProxy, connections, certificate }) => {
      await fetchPayload(
        createHttp1ProxyAgent(
          {
            uri: tlsSocksProxy,
            proxyTls: { ca: certificate, servername: TARGET_HOST },
            requestTls: { ca: certificate },
          },
          5_000,
        ),
      );
      expect(connections).toEqual([`socks:${TARGET_HOST}`]);
    });
  });

  it.each([
    { source: "active", managedHop: "https" },
    { source: "supplied-env", managedHop: "https" },
    { source: "active", managedHop: "http" },
  ])("keeps $source managed TLS on the $managedHop proxy hop", async ({ source, managedHop }) => {
    await withProxyFixture(async ({ socksProxy, httpsProxy, connections, certificate }) => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-socks-ca-"));
      const caFile = path.join(dir, "ca.pem");
      await writeFile(caFile, certificate);
      const registration =
        source === "active"
          ? registerActiveManagedProxyUrl(new URL(httpsProxy), {
              proxyTls: { ca: certificate },
            })
          : undefined;
      const dispatcher = createHttp1EnvHttpProxyAgent(
        {
          httpProxy: managedHop === "http" ? httpsProxy : socksProxy,
          httpsProxy: managedHop === "http" ? socksProxy : httpsProxy,
          noProxy: "",
          requestTls: { ca: certificate },
        },
        undefined,
        {
          HTTPS_PROXY: httpsProxy,
          OPENCLAW_PROXY_ACTIVE: "1",
          OPENCLAW_PROXY_CA_FILE: caFile,
        },
      );
      try {
        for (const url of [`http://${TARGET_HOST}/media`, TARGET_URL]) {
          const response = await undiciFetch(url, { dispatcher });
          expect(await response.text()).toBe(PAYLOAD);
        }
        expect(connections).toEqual(
          (managedHop === "http" ? ["https", "socks"] : ["socks", "https"]).map(
            (kind) => `${kind}:${TARGET_HOST}`,
          ),
        );
      } finally {
        await dispatcher.destroy();
        if (registration) {
          stopActiveManagedProxyRegistration(registration);
        }
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  it.each([false, true])("routes both mixed proxies with explicit TLS opt-in=%s", async (tls) => {
    await withProxyFixture(
      async ({
        socksProxy,
        tlsSocksProxy,
        httpProxy,
        httpsProxy,
        connections,
        certificate,
        waitForProxyProtocol,
        waitForSocketsClosed,
      }) => {
        const dispatcher = createHttp1EnvHttpProxyAgent(
          {
            httpProxy: tls ? tlsSocksProxy : socksProxy,
            httpsProxy: tls ? httpsProxy : httpProxy,
            noProxy: "",
            ...(tls ? { proxyTls: { ca: certificate, servername: TARGET_HOST } } : {}),
            requestTls: { ca: certificate },
          },
          5_000,
        );
        try {
          const plain = await undiciFetch(`http://${TARGET_HOST}/media`, { dispatcher });
          expect(await plain.text()).toBe(PAYLOAD);
          const protocol = tls ? waitForProxyProtocol() : undefined;
          const secure = await undiciFetch(TARGET_URL, { dispatcher });
          expect(await secure.text()).toBe(PAYLOAD);
          if (protocol) {
            expect(await protocol).toBe("http/1.1");
          }
          expect(connections).toEqual([
            `socks:${TARGET_HOST}`,
            `${tls ? "https" : "http"}:${TARGET_HOST}`,
          ]);
        } finally {
          await dispatcher.destroy();
        }
        await waitForSocketsClosed();
      },
    );
  });

  it.each([
    { proxy: "HTTPS", kind: "verification" },
    { proxy: "HTTPS", kind: "trust" },
    { proxy: "HTTPS", kind: "connector" },
    { proxy: "SOCKS-over-TLS", kind: "verification" },
    { proxy: "SOCKS-over-TLS", kind: "trust" },
    { proxy: "SOCKS-over-TLS", kind: "connector" },
  ])("keeps direct-origin TLS $kind out of $proxy proxy policy", async ({ proxy, kind }) => {
    await withProxyFixture(async ({ httpsProxy, tlsSocksProxy, certificate, connections }) => {
      const options = {
        httpsProxy: proxy === "HTTPS" ? httpsProxy : tlsSocksProxy,
        noProxy: "",
        connect:
          kind === "connector"
            ? buildConnector({ rejectUnauthorized: false })
            : kind === "verification"
              ? { rejectUnauthorized: false }
              : { ca: certificate },
        requestTls: { ca: certificate },
        ...(proxy === "HTTPS" ? {} : { proxyTls: { servername: TARGET_HOST } }),
      };
      const untrusted = createHttp1EnvHttpProxyAgent(options, 5_000);
      try {
        await expect(undiciFetch(TARGET_URL, { dispatcher: untrusted })).rejects.toMatchObject({
          cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
        });
        expect(connections).toEqual([]);
      } finally {
        await untrusted.destroy();
      }
      await fetchPayload(
        createHttp1EnvHttpProxyAgent(
          { ...options, proxyTls: { ...options.proxyTls, ca: certificate } },
          5_000,
        ),
      );
      expect(connections).toEqual([`${proxy === "HTTPS" ? "https" : "socks"}:${TARGET_HOST}`]);
    });
  });

  it("keeps managed trust isolated between two native HTTPS proxy hops", async () => {
    await withProxyFixture(async ({ httpsProxy, otherHttpsProxy, certificate, connections }) => {
      const registration = registerActiveManagedProxyUrl(new URL(httpsProxy), {
        proxyTls: { ca: certificate },
      });
      const dispatcher = createHttp1EnvHttpProxyAgent(
        {
          httpProxy: otherHttpsProxy,
          httpsProxy,
          noProxy: "",
          requestTls: { ca: certificate },
        },
        5_000,
      );
      try {
        await expect(
          undiciFetch(`http://${TARGET_HOST}/media`, { dispatcher }),
        ).rejects.toMatchObject({ cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" } });
        expect(connections).toEqual([]);
        const response = await undiciFetch(TARGET_URL, { dispatcher });
        expect(await response.text()).toBe(PAYLOAD);
        expect(connections).toEqual([`https:${TARGET_HOST}`]);
      } finally {
        await dispatcher.destroy();
        stopActiveManagedProxyRegistration(registration);
      }
    });
  });

  it.each(["127.0.0.0/8", "127.0.*"])(
    "routes confirmed NO_PROXY=%s directly despite another native proxy",
    async (noProxy) => {
      await withProxyFixture(
        async ({ httpProxy, socksProxy, httpsOrigin, certificate, connections, originRoutes }) => {
          const dispatcher = createHttp1EnvHttpProxyAgent({
            httpProxy,
            httpsProxy: socksProxy,
            noProxy,
            connect: { ca: certificate },
          });
          try {
            const response = await undiciFetch(`${httpsOrigin}/media`, {
              dispatcher,
              signal: AbortSignal.timeout(5_000),
            });
            expect(await response.text()).toBe(PAYLOAD);
            expect(connections).toEqual([]);
            expect(originRoutes).toEqual(["direct"]);
          } finally {
            await dispatcher.destroy();
          }
        },
      );
    },
  );

  it("joins an in-flight graceful close while the SOCKS response drains", async () => {
    await withProxyFixture(async ({ socksProxy, waitForSocketsClosed }) => {
      const dispatcher = createHttp1EnvHttpProxyAgent({ httpProxy: socksProxy, noProxy: "" });
      try {
        const response = await undiciFetch(`http://${TARGET_HOST}/stall`, { dispatcher });
        const first = dispatcher.close();
        // Empty native children finish through microtasks; the SOCKS response still owns work.
        await setImmediate();
        const destroyedWhileDraining = Reflect.get(dispatcher, "destroyed");
        const second = dispatcher.close().then(
          () => "closed",
          (error: unknown) => error,
        );
        await response.body?.cancel();
        await first;
        expect.soft(destroyedWhileDraining).toBe(false);
        expect(await second).toBe("closed");
        expect(Reflect.get(dispatcher, "destroyed")).toBe(true);
        await waitForSocketsClosed();
      } finally {
        await dispatcher.destroy();
      }
    });
  });

  it.each(["explicit SOCKS", "environment SOCKS", "native HTTP"])(
    "preserves maxOrigins admission with an active %s response",
    async (mode) => {
      await withProxyFixture(async ({ socksProxy, httpProxy, certificate, originRoutes }) => {
        const options = { maxOrigins: 1, requestTls: { ca: certificate } };
        const dispatcher =
          mode === "environment SOCKS"
            ? createHttp1EnvHttpProxyAgent({ ...options, httpProxy: socksProxy, noProxy: "" })
            : createHttp1ProxyAgent({
                ...options,
                uri: mode === "native HTTP" ? httpProxy : socksProxy,
              });
        let response: Awaited<ReturnType<typeof undiciFetch>> | undefined;
        try {
          response = await undiciFetch(`http://${TARGET_HOST}/stall`, {
            dispatcher,
            signal: AbortSignal.timeout(5_000),
          });
          await expect(
            undiciFetch(TARGET_URL, { dispatcher, signal: AbortSignal.timeout(5_000) }).then(
              (second) => second.text(),
            ),
          ).rejects.toMatchObject({ cause: { code: "UND_ERR_MAX_ORIGINS_REACHED" } });
          expect(originRoutes).toEqual(["proxy"]);
        } finally {
          await response?.body?.cancel();
          await dispatcher.destroy();
        }
      });
    },
  );

  it("does not replace an explicit SOCKS global dispatcher with a default Agent", async () => {
    const previous = getGlobalDispatcher();
    const dispatcher = createHttp1ProxyAgent("socks5://127.0.0.1:1080");
    try {
      setGlobalDispatcher(dispatcher);
      ensureGlobalUndiciDispatcherStreamTimeouts();
      expect(getGlobalDispatcher()).toBe(dispatcher);
    } finally {
      const current = getGlobalDispatcher();
      setGlobalDispatcher(previous);
      resetGlobalUndiciStreamTimeoutsForTests();
      await dispatcher.destroy();
      if (current !== dispatcher && current !== previous) {
        await current.destroy();
      }
    }
  });

  it.each(["proxy-fetch", "global"])("keeps managed TLS hop-local through %s", async (entry) => {
    await withProxyFixture(async ({ socksProxy, httpsProxy, certificate, connections }) => {
      const registration = registerActiveManagedProxyUrl(new URL(httpsProxy), {
        proxyTls: { ca: certificate },
      });
      const previous = getGlobalDispatcher();
      const created: ReturnType<typeof createHttp1EnvHttpProxyAgent>[] = [];
      const create = undiciRuntime.createHttp1EnvHttpProxyAgent;
      const capture = vi
        .spyOn(undiciRuntime, "createHttp1EnvHttpProxyAgent")
        .mockImplementation((...args) => {
          const dispatcher = create(...args);
          created.push(dispatcher);
          return dispatcher;
        });
      const env = { http_proxy: socksProxy, https_proxy: httpsProxy, no_proxy: "" };
      try {
        for (const [key, value] of Object.entries(env)) {
          vi.stubEnv(key, value);
        }
        const fetch = entry === "proxy-fetch" ? resolveProxyFetchFromEnv(env) : undiciFetch;
        if (entry === "global") {
          forceResetGlobalDispatcher();
        }
        if (!fetch) {
          throw new Error("expected configured proxy fetch");
        }
        const response = await fetch(`http://${TARGET_HOST}/media`);
        expect(await response.text()).toBe(PAYLOAD);
        expect(connections).toEqual([`socks:${TARGET_HOST}`]);
      } finally {
        setGlobalDispatcher(previous);
        resetGlobalUndiciStreamTimeoutsForTests();
        await Promise.all(created.map((dispatcher) => dispatcher.destroy()));
        capture.mockRestore();
        vi.unstubAllEnvs();
        stopActiveManagedProxyRegistration(registration);
      }
    });
  });

  it.each([
    { method: "close", noProxy: undefined, routes: ["proxy", "direct", "proxy"] },
    { method: "destroy", noProxy: "", routes: ["proxy", "proxy", "proxy"] },
  ] as const)(
    "honors noProxy=$noProxy and $method callback completion on the same env dispatcher",
    async ({ method, noProxy, routes }) => {
      await withProxyFixture(
        async ({ socksProxy, httpOrigin, originRoutes, waitForSocketsClosed }) => {
          const direct = new URL(httpOrigin);
          const connect = buildConnector({});
          vi.stubEnv("no_proxy", "");
          vi.stubEnv("NO_PROXY", "*");
          const dispatcher = createHttp1EnvHttpProxyAgent({
            httpProxy: socksProxy,
            noProxy,
            connect: (params, callback) =>
              connect(
                params.hostname === TARGET_HOST
                  ? { ...params, hostname: direct.hostname, port: direct.port }
                  : params,
                callback,
              ),
          });
          try {
            expect(Reflect.get(dispatcher, "closed")).toBe(false);
            expect(Reflect.get(dispatcher, "destroyed")).toBe(false);
            expect(() =>
              Reflect.apply(
                dispatcher[method],
                dispatcher,
                method === "close" ? ["invalid"] : [null, "invalid"],
              ),
            ).toThrow("invalid callback");
            const intercepted = vi.fn();
            const composed = dispatcher.compose((dispatch) => (request, handler) => {
              intercepted();
              return dispatch(request, handler);
            });
            for (const bypass of ["", TARGET_HOST, ""]) {
              vi.stubEnv("no_proxy", bypass);
              const response = await composed.request({
                origin: `http://${TARGET_HOST}`,
                path: "/media",
                method: "GET",
              });
              expect(await response.body.text()).toBe(PAYLOAD);
            }
            expect(originRoutes).toEqual(routes);
            expect(intercepted).toHaveBeenCalledTimes(3);
            const completion = vi.fn();
            const closing = new Promise<void>((resolve, reject) => {
              dispatcher[method]((error?: Error | null) => {
                completion(error);
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              });
            });
            await Promise.all([closing, dispatcher[method]()]);
            expect(completion).toHaveBeenCalledExactlyOnceWith(null);
            expect(Reflect.get(dispatcher, "destroyed")).toBe(true);
            expect(Reflect.get(dispatcher, "closed")).toBe(method === "close");
            await dispatcher.destroy();
            await expect(dispatcher.close()).rejects.toMatchObject({ code: "UND_ERR_DESTROYED" });
            await expect(
              undiciFetch(`http://${TARGET_HOST}/media`, { dispatcher }),
            ).rejects.toMatchObject({ cause: { code: "UND_ERR_DESTROYED" } });
            expect(originRoutes).toEqual(routes);
            await waitForSocketsClosed();
          } finally {
            await dispatcher.destroy();
            vi.unstubAllEnvs();
          }
        },
      );
    },
  );

  it.each(["explicit", "environment", "custom"])(
    "uses HTTP/1 and preserves TLS trust through an %s HTTPS proxy",
    async (mode) => {
      await withProxyFixture(
        async ({
          httpsProxy,
          certificate,
          connections,
          waitForProxyProtocol,
          waitForSocketsClosed,
        }) => {
          const clientFactory = vi.fn((origin: URL, options: object) => new Pool(origin, options));
          const options = {
            proxyTls: {
              ca: certificate,
              ...(mode === "custom" ? { allowH2: false, servername: TARGET_HOST } : {}),
            },
            requestTls: { ca: certificate },
          };
          const dispatcher =
            mode === "environment"
              ? createHttp1EnvHttpProxyAgent({ ...options, httpsProxy, noProxy: "" }, 5_000)
              : createHttp1ProxyAgent(
                  { ...options, uri: httpsProxy, ...(mode === "custom" ? { clientFactory } : {}) },
                  5_000,
                );
          await fetchPayload(
            dispatcher,
            waitForProxyProtocol().then((protocol) => {
              expect(protocol).toBe("http/1.1");
            }),
          );
          expect(connections).toEqual([`https:${TARGET_HOST}`]);
          if (mode === "custom") {
            expect(clientFactory).toHaveBeenCalledOnce();
          }
          await waitForSocketsClosed();
        },
      );
    },
  );

  it.each(["http", "socks"])(
    "allows trusted explicit %s media without target DNS but preserves target and redirect policy",
    async (kind) => {
      await withProxyFixture(async ({ httpProxy, socksProxy, connections, certificate }) => {
        const lookupFn = vi.fn(async (hostname: string) => {
          if (hostname === "127.0.0.1") {
            return [{ address: hostname, family: 4 }];
          }
          throw Object.assign(new Error("target DNS unavailable"), { code: "EAI_AGAIN" });
        });
        const options = {
          mode: "trusted_explicit_proxy" as const,
          dispatcherPolicy: {
            mode: "explicit-proxy" as const,
            proxyUrl: kind === "http" ? httpProxy : socksProxy,
            allowPrivateProxy: true,
            proxyTls: { ca: certificate },
          },
          policy: { hostnameAllowlist: [TARGET_HOST] },
          lookupFn,
          timeoutMs: 5_000,
        };
        const result = await fetchWithSsrFGuard({ ...options, url: TARGET_URL });
        try {
          expect(await result.response.text()).toBe(PAYLOAD);
        } finally {
          await result.release();
        }
        for (const url of [
          "https://outside.proxy.test/media",
          "https://127.0.0.1/media",
          `https://${TARGET_HOST}/redirect`,
        ]) {
          await expect(fetchWithSsrFGuard({ ...options, url })).rejects.toThrow("not in allowlist");
        }
        await expect(
          fetchWithSsrFGuard({
            ...options,
            url: "https://127.0.0.1/media",
            policy: undefined,
          }),
        ).rejects.toThrow(/private|internal/i);
        await expect(
          fetchWithSsrFGuard({
            ...options,
            url: TARGET_URL,
            dispatcherPolicy: { ...options.dispatcherPolicy, allowPrivateProxy: false },
          }),
        ).rejects.toThrow(/private|internal/i);
        expect(lookupFn.mock.calls.every(([hostname]) => hostname === "127.0.0.1")).toBe(true);
        expect(connections).toEqual([`${kind}:${TARGET_HOST}`, `${kind}:${TARGET_HOST}`]);
      });
    },
  );

  it("does not widen strict-mode SOCKS proxy policy", async () => {
    await withProxyFixture(async ({ socksProxy, connections }) => {
      await expect(
        fetchWithSsrFGuard({
          url: TARGET_URL,
          dispatcherPolicy: {
            mode: "explicit-proxy",
            proxyUrl: socksProxy,
            allowPrivateProxy: true,
          },
        }),
      ).rejects.toThrow("Explicit proxy URL must use http or https");
      expect(connections).toEqual([]);
    });
  });
});
