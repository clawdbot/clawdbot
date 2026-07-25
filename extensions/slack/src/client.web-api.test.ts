// Slack tests cover real Web API routing behavior.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebClient } from "@slack/web-api";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSlackLookupClient,
  createSlackWebClient,
  getSlackListenerUploadCompletionClient,
} from "./client.js";

const SLACK_API_URL_KEYS = ["SLACK_API_URL"] as const;
const PROXY_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "NO_PROXY",
  "no_proxy",
  "OPENCLAW_PROXY_ACTIVE",
  "OPENCLAW_PROXY_CA_FILE",
] as const;
const TEST_ENV_KEYS = [...SLACK_API_URL_KEYS, ...PROXY_KEYS] as const;
const originalEnv = { ...process.env };

type SlackApiRequest = {
  authorization?: string;
  body?: string;
  method?: string;
  url?: string;
};

function restoreTestEnv() {
  for (const key of TEST_ENV_KEYS) {
    if (originalEnv[key] !== undefined) {
      process.env[key] = originalEnv[key];
    } else {
      delete process.env[key];
    }
  }
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function startSlackApiServer(
  requests: SlackApiRequest[],
  responseDelayMs = 0,
): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      method: request.method,
      url: request.url,
    });
    request.resume();
    const sendResponse = () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        `${JSON.stringify({
          ok: true,
          team: "Mock Slack",
          team_id: "TMOCK",
          url: "https://mock.slack.test/",
          user: "mock-bot",
          user_id: "UMOCK",
        })}\n`,
      );
    };
    if (responseDelayMs > 0) {
      setTimeout(sendResponse, responseDelayMs);
    } else {
      sendResponse();
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

async function startDroppedResponseSlackApiServer(requests: SlackApiRequest[]): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer((request) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.once("end", () => {
      requests.push({
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
        method: request.method,
        url: request.url,
      });
      request.socket.destroy();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

async function startStalledHeadersSlackApiServer(requests: SlackApiRequest[]): Promise<{
  baseUrl: string;
  close(): Promise<void>;
  socketClosed: Promise<void>;
}> {
  let resolveSocketClosed: () => void = () => {};
  const socketClosed = new Promise<void>((resolve) => {
    resolveSocketClosed = resolve;
  });
  const server = createServer((request) => {
    requests.push({
      authorization: request.headers.authorization,
      method: request.method,
      url: request.url,
    });
    request.resume();
    request.socket.once("close", resolveSocketClosed);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await closeServer(server);
    },
    socketClosed,
  };
}

async function startRateLimitedSlackApiServer(requests: SlackApiRequest[]): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      method: request.method,
      url: request.url,
    });
    request.resume();
    response.writeHead(429, {
      "content-type": "application/json",
      "retry-after": "2",
    });
    response.end(`${JSON.stringify({ ok: false, error: "ratelimited" })}\n`);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

afterEach(() => {
  restoreTestEnv();
});

describe("Slack Web API routing", () => {
  it("aborts a stalled-header lookup after one request", async () => {
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }
    const requests: SlackApiRequest[] = [];
    const server = await startStalledHeadersSlackApiServer(requests);
    try {
      const client = createSlackLookupClient("lookup-fixture", {
        slackApiUrl: `${server.baseUrl}/api/`,
        timeout: 50,
      });

      await expect(client.auth.test()).rejects.toThrow();
      await server.socketClosed;

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: "POST", url: "/api/auth.test" });
    } finally {
      await server.close();
    }
  });

  it("rejects rate limits without sleeping through Retry-After", async () => {
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }
    const requests: SlackApiRequest[] = [];
    const server = await startRateLimitedSlackApiServer(requests);
    try {
      const client = createSlackLookupClient("lookup-fixture", {
        slackApiUrl: `${server.baseUrl}/api/`,
        timeout: 1000,
      });
      const startedAt = Date.now();

      await expect(client.auth.test()).rejects.toThrow();

      expect(Date.now() - startedAt).toBeLessThan(1000);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: "POST", url: "/api/auth.test" });
    } finally {
      await server.close();
    }
  });

  it("keeps dropped Enterprise upload completion responses to one team-scoped request", async () => {
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }
    const requests: SlackApiRequest[] = [];
    const server = await startDroppedResponseSlackApiServer(requests);
    try {
      const clientOptions = {
        headers: {
          Authorization: "Bearer stale-fixture",
          "X-Slack-Test": "preserved",
        },
        slackApiUrl: `${server.baseUrl}/api/`,
        retryConfig: { retries: 2 },
      };
      const listenerClient = new WebClient("listener-fixture", clientOptions);
      const completionClient = getSlackListenerUploadCompletionClient({
        listenerClient,
        teamId: "TENTERPRISE1",
        clientOptions,
      });
      expect(completionClient).toBeDefined();
      if (!completionClient) {
        throw new Error("missing Enterprise upload completion client");
      }
      expect(
        getSlackListenerUploadCompletionClient({
          listenerClient,
          teamId: "TENTERPRISE1",
          clientOptions,
        }),
      ).toBe(completionClient);
      expect(
        getSlackListenerUploadCompletionClient({
          listenerClient,
          teamId: "TENTERPRISE2",
          clientOptions,
        }),
      ).toBeUndefined();

      await expect(
        completionClient.files.completeUploadExternal({
          files: [{ id: "F123", title: "proof.txt" }],
          channel_id: "C123",
        }),
      ).rejects.toThrow();

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        authorization: "Bearer listener-fixture",
        method: "POST",
        url: "/api/files.completeUploadExternal",
      });
      expect(new URLSearchParams(requests[0]?.body).get("team_id")).toBe("TENTERPRISE1");
      expect(requests[0]?.authorization).not.toContain("stale-fixture");
    } finally {
      await server.close();
    }
  });

  it("does not inherit the listener request timeout for upload completion", async () => {
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }
    const requests: SlackApiRequest[] = [];
    const server = await startSlackApiServer(requests, 80);
    try {
      const clientOptions = {
        slackApiUrl: `${server.baseUrl}/api/`,
        retryConfig: { retries: 2 },
        timeout: 20,
      };
      const listenerClient = new WebClient("listener-fixture", clientOptions);
      const completionClient = getSlackListenerUploadCompletionClient({
        listenerClient,
        teamId: "TENTERPRISE1",
        clientOptions,
      });
      expect(completionClient).toBeDefined();
      if (!completionClient) {
        throw new Error("missing Enterprise upload completion client");
      }

      const result = await completionClient.files.completeUploadExternal({
        files: [{ id: "F123", title: "proof.txt" }],
        channel_id: "C123",
      });

      expect(result.ok).toBe(true);
      expect(requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("routes real WebClient requests to the SLACK_API_URL root", async () => {
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }
    const requests: SlackApiRequest[] = [];
    const server = await startSlackApiServer(requests);
    try {
      process.env.SLACK_API_URL = `${server.baseUrl}/api/`;

      const client = createSlackWebClient("xoxb-route-proof", {
        retryConfig: { retries: 0 },
        timeout: 1000,
      });
      const result = await client.auth.test();

      expect(result.ok).toBe(true);
      expect(requests).toEqual([
        {
          authorization: "Bearer xoxb-route-proof",
          method: "POST",
          url: "/api/auth.test",
        },
      ]);
    } finally {
      await server.close();
    }
  });

  it("routes real WebClient requests to explicit Slack API URL options before SLACK_API_URL", async () => {
    for (const key of TEST_ENV_KEYS) {
      delete process.env[key];
    }
    const envRequests: SlackApiRequest[] = [];
    const explicitRequests: SlackApiRequest[] = [];
    const envServer = await startSlackApiServer(envRequests);
    const explicitServer = await startSlackApiServer(explicitRequests);
    try {
      process.env.SLACK_API_URL = `${envServer.baseUrl}/api/`;

      const client = createSlackWebClient("xoxb-route-proof", {
        retryConfig: { retries: 0 },
        slackApiUrl: `${explicitServer.baseUrl}/api/`,
        timeout: 1000,
      });
      const result = await client.auth.test();

      expect(result.ok).toBe(true);
      expect(envRequests).toEqual([]);
      expect(explicitRequests).toEqual([
        {
          authorization: "Bearer xoxb-route-proof",
          method: "POST",
          url: "/api/auth.test",
        },
      ]);
    } finally {
      await explicitServer.close();
      await envServer.close();
    }
  });
});
