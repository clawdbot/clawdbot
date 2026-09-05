// Real OpenClaw stream helpers and Slack SDK with synthetic HTTP responses.
import { WebClient, type WebClientOptions } from "@slack/web-api";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { createSlackWriteClient, resolveSlackWriteClientOptions } from "./client.js";
import { appendSlackStream, startSlackStream, stopSlackStream } from "./streaming.js";

type StreamMethod = "chat.startStream" | "chat.appendStream" | "chat.stopStream";
const STREAM_TS = "1700000000.000100";

function createRateLimitTransport(
  method: StreamMethod,
  terminal: "success" | "socket" | "http500",
  brokenBody = false,
) {
  const requests: Array<{ method: string; body: string }> = [];
  let attempts = 0;
  const fetch: NonNullable<WebClientOptions["fetch"]> = async (input, init) => {
    const currentMethod = new URL(input).pathname.split("/").at(-1) ?? "";
    if (typeof init?.body !== "string") {
      throw new Error("Expected Slack's URL-encoded streaming request");
    }
    requests.push({ method: currentMethod, body: init.body });
    if (currentMethod === method) {
      attempts += 1;
      if (attempts === 1) {
        const body = brokenBody
          ? new ReadableStream({
              start(controller) {
                controller.error(new Error("rejected response body interrupted"));
              },
            })
          : JSON.stringify({ ok: false, error: "ratelimited" });
        return new Response(body, {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      if (terminal === "socket") {
        throw new Error("synthetic lost acknowledgment");
      }
      if (terminal === "http500") {
        return new Response("synthetic server failure", { status: 500 });
      }
    }
    return new Response(JSON.stringify({ ok: true, ts: STREAM_TS }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, requests };
}

async function runStreamOperation(
  method: StreamMethod,
  fetch: NonNullable<WebClientOptions["fetch"]>,
) {
  const clientOptions: WebClientOptions = {
    fetch,
    slackApiUrl: "https://synthetic.slack.invalid/api/",
    retryConfig: { retries: 2, minTimeout: 1, maxTimeout: 1 },
    teamId: "TFIXTURE",
  };
  const client = new WebClient("synthetic-rate-limit-fixture", clientOptions);
  const session = await startSlackStream({
    client,
    clientOptions,
    channel: "CFIXTURE",
    threadTs: "1700000000.000001",
    teamId: "TRECIPIENT",
    userId: "UFIXTURE",
    text: method === "chat.startStream" ? "answer" : "prefix",
    chunks: [],
  });
  if (method === "chat.appendStream") {
    await appendSlackStream({ session, text: "answer", chunks: [] });
  }
  if (method === "chat.stopStream") {
    await appendSlackStream({ session, text: "answer" });
  }
  await stopSlackStream({ session });
  return session;
}

const STREAM_METHODS = ["chat.startStream", "chat.appendStream", "chat.stopStream"] as const;

describe("Slack explicit rate-limit recovery", () => {
  it("recovers an authoritative rejection even if its discarded body fails", async () => {
    const transport = createRateLimitTransport("chat.startStream", "success", true);
    const session = await runStreamOperation("chat.startStream", transport.fetch);
    expect(session).toMatchObject({ stopped: true, delivered: true, pendingText: "" });
    expect(
      transport.requests.filter((request) => request.method === "chat.startStream"),
    ).toHaveLength(2);
  });

  it.each(["retry", "abort"] as const)(
    "allows %s while a discarded 429 body and its cancellation remain pending",
    async (action) => {
      const cleanup = createDeferred<void>();
      let bodyController!: ReadableStreamDefaultController;
      let cancelled = false;
      let attempts = 0;
      const body = new ReadableStream({
        start(controller) {
          bodyController = controller;
        },
        cancel() {
          cancelled = true;
          return cleanup.promise;
        },
      });
      const fetch: NonNullable<WebClientOptions["fetch"]> = async () => {
        attempts += 1;
        return attempts === 1
          ? new Response(body, {
              status: 429,
              headers: { "retry-after": action === "abort" ? "60" : "0" },
            })
          : new Response(JSON.stringify({ ok: true, ts: STREAM_TS }));
      };
      const operation =
        action === "retry"
          ? runStreamOperation("chat.startStream", fetch)
          : createSlackWriteClient("synthetic-stalled-cancel-fixture", {
              fetch,
              timeout: 20,
            }).apiCall("chat.postMessage", { channel: "CFIXTURE", text: "answer" });
      const settled = operation.then(
        () => "delivered",
        () => "aborted",
      );
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcome = await Promise.race([
          settled,
          new Promise<string>((resolve) => {
            deadline = setTimeout(() => resolve("stalled"), 1_000);
          }),
        ]);
        expect(outcome).toBe(action === "retry" ? "delivered" : "aborted");
        expect(cancelled).toBe(true);
        expect(attempts).toBe(action === "retry" ? 3 : 1);
      } finally {
        clearTimeout(deadline);
        bodyController.error(new Error("test cleanup"));
        cleanup.resolve();
        await settled;
      }
    },
  );
  it.each(STREAM_METHODS)(
    "retries a rejected %s without duplicating buffered text",
    async (method) => {
      const transport = createRateLimitTransport(method, "success");
      const session = await runStreamOperation(method, transport.fetch);
      const attempts = transport.requests.filter((request) => request.method === method);
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.body).toBe(attempts[1]?.body);
      const body = new URLSearchParams(attempts[1]?.body);
      expect(body.get("team_id")).toBe("TFIXTURE");
      expect(JSON.parse(body.get("chunks") ?? "[]")).toEqual([
        { type: "markdown_text", text: "answer" },
      ]);
      expect(session).toMatchObject({ stopped: true, delivered: true, pendingText: "" });
    },
  );

  it.each(["socket", "http500"] as const)(
    "does not replay an ambiguous %s response after an explicit rate-limit retry",
    async (terminal) => {
      const transport = createRateLimitTransport("chat.appendStream", terminal);
      await expect(runStreamOperation("chat.appendStream", transport.fetch)).rejects.toThrow();
      expect(
        transport.requests.filter((request) => request.method === "chat.appendStream"),
      ).toHaveLength(2);
      expect(transport.requests.some((request) => request.method === "chat.stopStream")).toBe(
        false,
      );
    },
  );

  it.each(["chat.postMessage", "files.completeUploadExternal"] as const)(
    "retries rejected %s writes with their original workspace and body",
    async (method) => {
      const bodies: string[] = [];
      const rejected = new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "0" },
      });
      const client = createSlackWriteClient("synthetic-write-fixture", {
        teamId: "TWORKSPACE",
        fetch: async (_input, init) => {
          if (typeof init?.body !== "string") {
            throw new Error("Expected Slack's URL-encoded write request");
          }
          bodies.push(init.body);
          return bodies.length === 1
            ? rejected
            : new Response(JSON.stringify({ ok: true, ts: STREAM_TS }));
        },
      });
      await expect(
        method === "chat.postMessage"
          ? client.apiCall("chat.postMessage", { channel: "CFIXTURE", text: "answer" })
          : client.files.completeUploadExternal({
              files: [{ id: "FFIXTURE", title: "answer.txt" }],
              channel_id: "CFIXTURE",
            }),
      ).resolves.toMatchObject({ ok: true });
      expect(rejected.bodyUsed).toBe(true);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toBe(bodies[1]);
      expect(new URLSearchParams(bodies[1]).get("team_id")).toBe("TWORKSPACE");
    },
  );

  it.each([
    { header: "0", calls: 3 },
    { header: "invalid", calls: 1 },
    { header: "2147001", calls: 1 },
    { header: "0", calls: 1, rejectRateLimitedCalls: true },
    { header: "0", calls: 2, retryConfig: { retries: 1, minTimeout: 1, maxTimeout: 1 } },
    { header: "0", calls: 3, retryConfig: { retries: 2, minTimeout: 1, maxTimeout: 1 } },
  ])("bounds rate-limit recovery for $header ($calls requests)", async (testCase) => {
    const responses: Response[] = [];
    const client = createSlackWriteClient("synthetic-budget-fixture", {
      rejectRateLimitedCalls: testCase.rejectRateLimitedCalls,
      retryConfig: testCase.retryConfig,
      fetch: async () => {
        const response = new Response("rate limited", {
          status: 429,
          headers: { "retry-after": testCase.header },
        });
        responses.push(response);
        return response;
      },
    });
    await expect(
      client.apiCall("chat.postMessage", { channel: "CFIXTURE", text: "answer" }),
    ).rejects.toThrow();
    expect(responses).toHaveLength(testCase.calls);
    if (!testCase.rejectRateLimitedCalls && !testCase.retryConfig) {
      expect(responses.every((response) => response.bodyUsed)).toBe(true);
    }
  });

  it("aborts a rate-limit wait when the request deadline closes", async () => {
    const responses: Response[] = [];
    const client = createSlackWriteClient("synthetic-cancel-fixture", {
      timeout: 20,
      fetch: async () => {
        const response = new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "60" },
        });
        responses.push(response);
        return response;
      },
    });
    await expect(
      client.apiCall("chat.postMessage", { channel: "CFIXTURE", text: "answer" }),
    ).rejects.toThrow();
    expect(responses).toHaveLength(1);
    expect(responses[0]?.bodyUsed).toBe(true);
  });

  it("does not multiply the retry budget when pre-resolved options are reused", async () => {
    let attempts = 0;
    const options = resolveSlackWriteClientOptions({
      fetch: async () => {
        attempts += 1;
        return new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      },
    });
    const client = createSlackWriteClient("synthetic-reused-fixture", options);
    await expect(
      client.apiCall("chat.postMessage", { channel: "CFIXTURE", text: "answer" }),
    ).rejects.toThrow();
    expect(attempts).toBe(3);
  });
});
