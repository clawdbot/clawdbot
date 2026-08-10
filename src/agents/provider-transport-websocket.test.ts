import { createServer, type Server } from "node:http";
import {
  connect as connectNet,
  createServer as createNetServer,
  type AddressInfo,
  type Server as NetServer,
  type Socket,
} from "node:net";
import type { Context, Model } from "@openclaw/ai";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { streamOpenAICodexResponses } from "../../packages/ai/src/providers/openai-chatgpt-responses.js";
import {
  registerActiveManagedProxyUrl,
  stopActiveManagedProxyRegistration,
} from "../infra/net/proxy/active-proxy-state.js";
import { withEnvAsync } from "../test-utils/env.js";
import * as localService from "./provider-local-service.js";
import { attachModelProviderRequestTransport } from "./provider-request-config.js";
import { connectGuardedModelWebSocket } from "./provider-transport-websocket.js";
import "../llm/ai-transport-host.js";

const coreTransportHost = getAiTransportHost();

async function listen(server: Server | NetServer | WebSocketServer): Promise<AddressInfo> {
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  return server.address() as AddressInfo;
}

async function closeServer(server: Server | NetServer | WebSocketServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function createJwt(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  })}.signature`;
}

function modelFor(baseUrl: string): Model<"openai-chatgpt-responses"> {
  return {
    id: "gpt-5.5",
    name: "GPT-5.5",
    api: "openai-chatgpt-responses",
    provider: "openai",
    baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_000,
  };
}

function localModelFor(baseUrl: string): Model<"openai-chatgpt-responses"> {
  return attachModelProviderRequestTransport(modelFor(baseUrl), {
    allowPrivateNetwork: true,
  });
}

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;

afterEach(() => {
  vi.restoreAllMocks();
  configureAiTransportHost(coreTransportHost);
});

describe("guarded model WebSocket transport", () => {
  it("keeps Node auto transport WebSocket-first without an ambient global constructor", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const address = await listen(server);
    let connections = 0;
    server.on("connection", (socket) => {
      connections += 1;
      socket.on("message", () => {
        socket.send(
          JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_guarded_node_auto",
              status: "completed",
              output: [],
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          }),
        );
      });
    });
    const fetch = vi.spyOn(globalThis, "fetch");

    try {
      const result = await streamOpenAICodexResponses(
        localModelFor(`http://127.0.0.1:${address.port}`),
        context,
        {
          apiKey: createJwt(),
          transport: "auto",
          requestId: "call-guarded-node-auto",
        },
      ).result();

      expect(result).toMatchObject({
        stopReason: "stop",
        responseId: "resp_guarded_node_auto",
      });
      expect(connections).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      await closeServer(server);
    }
  });

  it("retains the local-service lease until idempotent resource disposal", async () => {
    const release = vi.fn();
    vi.spyOn(localService, "ensureModelProviderLocalService").mockResolvedValue({ release });
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    server.on("headers", (headers) => {
      headers.push("OpenAI-Model: gpt-5.5-served");
    });
    const address = await listen(server);
    const controller = new AbortController();
    const resource = await connectGuardedModelWebSocket(
      localModelFor(`http://127.0.0.1:${address.port}`),
      {
        url: `ws://127.0.0.1:${address.port}/codex/responses`,
        headers: { Authorization: "Bearer test" },
        signal: controller.signal,
      },
    );

    expect(release).not.toHaveBeenCalled();
    expect(resource.handshakeHeaders["openai-model"]).toBe("gpt-5.5-served");
    controller.abort(new DOMException("late request timeout", "TimeoutError"));
    await Promise.resolve();
    expect(release).not.toHaveBeenCalled();
    expect(resource.socket.readyState).toBe(1);
    resource.dispose();
    resource.dispose();
    expect(release).toHaveBeenCalledOnce();
    await closeServer(server);
  });

  it("aborts an opening handshake and releases its local-service lease once", async () => {
    const release = vi.fn();
    vi.spyOn(localService, "ensureModelProviderLocalService").mockResolvedValue({ release });
    const sockets = new Set<Socket>();
    const server = createNetServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    const address = await listen(server);
    const controller = new AbortController();
    const pending = connectGuardedModelWebSocket(
      localModelFor(`http://127.0.0.1:${address.port}`),
      {
        url: `ws://127.0.0.1:${address.port}/codex/responses`,
        headers: { Authorization: "Bearer test" },
        signal: controller.signal,
      },
    );

    await vi.waitFor(() => expect(sockets.size).toBe(1));
    controller.abort(new DOMException("Request was aborted", "AbortError"));

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(release).toHaveBeenCalledOnce();
    for (const socket of sockets) {
      socket.destroy();
    }
    await closeServer(server);
  });

  it("rejects unknown secret sentinels before local-service or socket dispatch", async () => {
    const ensure = vi.spyOn(localService, "ensureModelProviderLocalService");
    const unknown = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";

    await expect(
      connectGuardedModelWebSocket(localModelFor("http://127.0.0.1:1"), {
        url: "ws://127.0.0.1:1/codex/responses",
        headers: { Authorization: `Bearer ${unknown}` },
      }),
    ).rejects.toThrow(/not registered/i);
    expect(ensure).not.toHaveBeenCalled();
  });

  it("blocks a public route resolving directly to a private address", async () => {
    await expect(
      connectGuardedModelWebSocket(modelFor("https://chatgpt.example/backend-api"), {
        url: "wss://127.0.0.1/codex/responses",
        headers: { Authorization: "Bearer test" },
      }),
    ).rejects.toThrow(/private|internal|ssrf|blocked/i);
  });

  it("uses an explicit proxy and honors NO_PROXY as a direct-route boundary", async () => {
    const target = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    const targetAddress = await listen(target);
    const proxy = createServer();
    let proxyConnects = 0;
    const proxyAuthorities: Array<{ host?: string; target?: string }> = [];
    proxy.on("connect", (request, clientSocket, head) => {
      proxyConnects += 1;
      proxyAuthorities.push({ host: request.headers.host, target: request.url });
      const [hostname, rawPort] = (request.url ?? "").split(":");
      const upstream = connectNet(Number(rawPort), hostname, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) {
          upstream.write(head);
        }
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      upstream.on("error", () => clientSocket.destroy());
    });
    proxy.listen(0, "127.0.0.1");
    const proxyAddress = await listen(proxy);
    const targetBaseUrl = `http://localhost:${targetAddress.port}`;
    const targetUrl = `ws://localhost:${targetAddress.port}/codex/responses`;

    try {
      const explicitModel = attachModelProviderRequestTransport(localModelFor(targetBaseUrl), {
        allowPrivateNetwork: true,
        proxy: {
          mode: "explicit-proxy",
          url: `http://127.0.0.1:${proxyAddress.port}`,
        },
      });
      const proxied = await connectGuardedModelWebSocket(explicitModel, {
        url: targetUrl,
        headers: { Authorization: "Bearer test" },
      });
      expect(proxyConnects).toBe(1);
      expect(proxyAuthorities).toEqual([
        {
          host: `localhost:${targetAddress.port}`,
          target: `127.0.0.1:${targetAddress.port}`,
        },
      ]);
      proxied.dispose();

      await withEnvAsync(
        {
          HTTP_PROXY: `http://127.0.0.1:${proxyAddress.port}`,
          http_proxy: undefined,
          NO_PROXY: "localhost",
          no_proxy: undefined,
        },
        async () => {
          const direct = await connectGuardedModelWebSocket(localModelFor(targetBaseUrl), {
            url: targetUrl,
            headers: { Authorization: "Bearer test" },
          });
          direct.dispose();
        },
      );
      expect(proxyConnects).toBe(1);

      const registration = registerActiveManagedProxyUrl(
        new URL(`http://127.0.0.1:${proxyAddress.port}`),
        "gateway-only",
      );
      try {
        await withEnvAsync(
          {
            OPENCLAW_PROXY_ACTIVE: "1",
            HTTP_PROXY: `http://127.0.0.1:${proxyAddress.port}`,
            http_proxy: undefined,
            NO_PROXY: undefined,
            no_proxy: undefined,
          },
          async () => {
            const direct = await connectGuardedModelWebSocket(localModelFor(targetBaseUrl), {
              url: targetUrl,
              headers: { Authorization: "Bearer test" },
            });
            direct.dispose();
          },
        );
      } finally {
        stopActiveManagedProxyRegistration(registration);
      }
      expect(proxyConnects).toBe(1);
    } finally {
      await closeServer(proxy);
      await closeServer(target);
    }
  });

  it("rejects malformed proxy credentials before opening a proxy socket", async () => {
    const proxy = createNetServer();
    let proxyConnections = 0;
    proxy.on("connection", (socket) => {
      proxyConnections += 1;
      socket.destroy();
    });
    proxy.listen(0, "127.0.0.1");
    const proxyAddress = await listen(proxy);
    const model = attachModelProviderRequestTransport(localModelFor("http://localhost:9"), {
      allowPrivateNetwork: true,
      proxy: {
        mode: "explicit-proxy",
        url: `http://%E0%A4%A@127.0.0.1:${proxyAddress.port}`,
      },
    });

    try {
      await expect(
        connectGuardedModelWebSocket(model, {
          url: "ws://localhost:9/codex/responses",
          headers: { Authorization: "Bearer test" },
        }),
      ).rejects.toBeInstanceOf(URIError);
      expect(proxyConnections).toBe(0);
    } finally {
      await closeServer(proxy);
    }
  });

  it("closes a proxy socket when CONNECT is aborted after acquisition", async () => {
    const sockets = new Set<Socket>();
    const proxy = createNetServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
    });
    proxy.listen(0, "127.0.0.1");
    const proxyAddress = await listen(proxy);
    const model = attachModelProviderRequestTransport(localModelFor("http://localhost:9"), {
      allowPrivateNetwork: true,
      proxy: {
        mode: "explicit-proxy",
        url: `http://127.0.0.1:${proxyAddress.port}`,
      },
    });
    const controller = new AbortController();
    const pending = connectGuardedModelWebSocket(model, {
      url: "ws://localhost:9/codex/responses",
      headers: { Authorization: "Bearer test" },
      signal: controller.signal,
    });

    try {
      await vi.waitFor(() => expect(sockets.size).toBe(1));
      controller.abort(new DOMException("Request was aborted", "AbortError"));
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(sockets.size).toBe(0));
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await closeServer(proxy);
    }
  });
});
