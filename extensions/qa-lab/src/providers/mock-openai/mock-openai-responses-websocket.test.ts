import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, type RawData } from "ws";
import { startQaMockOpenAiServer } from "./server.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function startServer() {
  const server = await startQaMockOpenAiServer({ host: "127.0.0.1", port: 0 });
  cleanups.push(async () => server.stop());
  return server;
}

async function connectResponsesWebSocket(baseUrl: string) {
  const socket = new WebSocket(`${baseUrl.replace(/^http/u, "ws")}/v1/responses`);
  cleanups.push(async () => {
    if (socket.readyState !== WebSocket.CLOSED) {
      socket.terminate();
    }
  });
  await once(socket, "open");
  return socket;
}

async function collectResponseEvents(socket: WebSocket, request: unknown) {
  return await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const events: Array<Record<string, unknown>> = [];
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for the mock Responses WebSocket"));
    }, 5_000);
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onMessage = (data: RawData) => {
      const text = Buffer.isBuffer(data)
        ? data.toString("utf8")
        : Array.isArray(data)
          ? Buffer.concat(data).toString("utf8")
          : Buffer.from(data).toString("utf8");
      const event = JSON.parse(text) as Record<string, unknown>;
      events.push(event);
      if (event.type === "response.completed" || event.type === "error") {
        cleanup();
        resolve(events);
      }
    };
    socket.on("message", onMessage);
    socket.on("error", onError);
    socket.send(typeof request === "string" ? request : JSON.stringify(request));
  });
}

function readCompletedResponse(events: Array<Record<string, unknown>>) {
  const completion = events.find((event) => event.type === "response.completed");
  expect(completion).toBeDefined();
  return completion?.response as Record<string, unknown>;
}

describe("QA mock OpenAI Responses WebSocket", () => {
  it("streams the native response.create protocol and records normal QA request evidence", async () => {
    const server = await startServer();
    const socket = await connectResponsesWebSocket(server.baseUrl);
    const prompt = "Read README.md for the source and docs discovery report.";

    const events = await collectResponseEvents(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      stream: true,
      tools: [{ type: "function", name: "read" }],
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    });

    expect(events[0]).toMatchObject({ type: "response.created" });
    expect(events[0]).toMatchObject({
      sequence_number: 0,
      response: {
        object: "response",
        model: "gpt-5.6-sol",
        status: "in_progress",
        output: [],
      },
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "response.output_item.done" }),
        expect.objectContaining({ type: "response.completed" }),
      ]),
    );
    const lastRequest = await fetch(`${server.baseUrl}/debug/last-request`).then((response) =>
      response.json(),
    );
    expect(lastRequest).toMatchObject({
      model: "gpt-5.6-sol",
      prompt,
      plannedToolName: "read",
    });
  });

  it("reconstructs Codex previous-response deltas on the same reusable connection", async () => {
    const server = await startServer();
    const socket = await connectResponsesWebSocket(server.baseUrl);
    const prompt = "Read README.md for the source and docs discovery report.";
    const firstEvents = await collectResponseEvents(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      stream: true,
      tools: [{ type: "function", name: "read" }],
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    });
    const firstResponse = readCompletedResponse(firstEvents);
    const output = firstResponse.output as Array<Record<string, unknown>>;
    const toolCall = output.find((item) => item.type === "function_call");
    expect(toolCall?.call_id).toEqual(expect.any(String));

    const secondEvents = await collectResponseEvents(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      stream: true,
      previous_response_id: firstResponse.id,
      input: [
        {
          type: "function_call_output",
          call_id: toolCall?.call_id,
          output: "README: source and docs evidence captured",
        },
      ],
    });

    expect(firstEvents.map((event) => event.sequence_number)).toEqual(
      firstEvents.map((_, index) => index),
    );
    expect(secondEvents.map((event) => event.sequence_number)).toEqual(
      secondEvents.map((_, index) => index),
    );

    const requests = (await fetch(`${server.baseUrl}/debug/requests`).then((response) =>
      response.json(),
    )) as Array<Record<string, unknown>>;
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({
      prompt,
      toolOutput: "README: source and docs evidence captured",
      toolOutputCallId: toolCall?.call_id,
    });
  });

  it("rejects a response ID after a newer response replaces the connection cache", async () => {
    const server = await startServer();
    const socket = await connectResponsesWebSocket(server.baseUrl);
    const prompt = "Read README.md for the source and docs discovery report.";
    const firstEvents = await collectResponseEvents(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      stream: true,
      store: false,
      tools: [{ type: "function", name: "read" }],
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    });
    const firstResponse = readCompletedResponse(firstEvents);
    const firstOutput = firstResponse.output as Array<Record<string, unknown>>;
    const toolCall = firstOutput.find((item) => item.type === "function_call");

    const secondEvents = await collectResponseEvents(socket, {
      type: "response.create",
      previous_response_id: firstResponse.id,
      input: [
        {
          type: "function_call_output",
          call_id: toolCall?.call_id,
          output: "README: source and docs evidence captured",
        },
      ],
    });

    expect(readCompletedResponse(secondEvents).id).not.toBe(firstResponse.id);
    await expect(
      collectResponseEvents(socket, {
        type: "response.create",
        previous_response_id: firstResponse.id,
        input: [],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "error",
        sequence_number: 0,
        status: 400,
        error: expect.objectContaining({ code: "previous_response_not_found" }),
      }),
    ]);
  });

  it("answers connection warmups without inventing a model or tool request", async () => {
    const server = await startServer();
    const socket = await connectResponsesWebSocket(server.baseUrl);

    const events = await collectResponseEvents(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      stream: true,
      generate: false,
      input: [],
    });

    expect(events).toEqual([
      expect.objectContaining({ type: "response.created" }),
      expect.objectContaining({
        type: "response.completed",
        response: expect.objectContaining({
          object: "response",
          model: "gpt-5.6-sol",
          status: "completed",
          output: [],
          usage: expect.objectContaining({
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          }),
        }),
      }),
    ]);
    const cursor = await fetch(`${server.baseUrl}/debug/request-cursor`).then((response) =>
      response.json(),
    );
    expect(cursor).toEqual({ cursor: 0 });
  });

  it("preserves the full warmup prompt when the first real response sends an empty delta", async () => {
    const server = await startServer();
    const socket = await connectResponsesWebSocket(server.baseUrl);
    const prompt = "Read README.md for the source and docs discovery report.";

    const warmup = await collectResponseEvents(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      stream: true,
      generate: false,
      tools: [{ type: "function", name: "read" }],
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    });

    const events = await collectResponseEvents(socket, {
      type: "response.create",
      stream: true,
      previous_response_id: readCompletedResponse(warmup).id,
      input: [],
    });

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "response.output_item.done" }),
        expect.objectContaining({ type: "response.completed" }),
      ]),
    );
    const lastRequest = await fetch(`${server.baseUrl}/debug/last-request`).then((response) =>
      response.json(),
    );
    expect(lastRequest).toMatchObject({ model: "gpt-5.6-sol", prompt, plannedToolName: "read" });
    const cursor = await fetch(`${server.baseUrl}/debug/request-cursor`).then((response) =>
      response.json(),
    );
    expect(cursor).toEqual({ cursor: 1 });
  });

  it("preserves the injected post-tool 503 failure on the WebSocket transport", async () => {
    const server = await startServer();
    const socket = await connectResponsesWebSocket(server.baseUrl);
    const prompt = "Provider HTTP 503 after tool QA check: read QA_KICKOFF_TASK.md, then reply.";

    const firstEvents = await collectResponseEvents(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      stream: true,
      tools: [{ type: "function", name: "read" }],
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    });
    const firstResponse = readCompletedResponse(firstEvents);
    const output = firstResponse.output as Array<Record<string, unknown>>;
    const toolCall = output.find((item) => item.type === "function_call");

    const failure = await collectResponseEvents(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      stream: true,
      previous_response_id: firstResponse.id,
      input: [
        {
          type: "function_call_output",
          call_id: toolCall?.call_id,
          output: "QA mission loaded",
        },
      ],
    });

    expect(failure).toEqual([
      expect.objectContaining({
        type: "error",
        status: 503,
        error: { type: "server_error", message: "Service Unavailable" },
      }),
    ]);
    await expect(
      collectResponseEvents(socket, {
        type: "response.create",
        previous_response_id: firstResponse.id,
        input: [],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        type: "error",
        sequence_number: 0,
        status: 400,
        error: expect.objectContaining({ code: "previous_response_not_found" }),
      }),
    ]);
    const requests = (await fetch(`${server.baseUrl}/debug/requests`).then((response) =>
      response.json(),
    )) as Array<Record<string, unknown>>;
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ prompt, toolOutput: "QA mission loaded" });
  });

  it("rejects a response delta whose previous response belongs to another connection", async () => {
    const server = await startServer();
    const socket = await connectResponsesWebSocket(server.baseUrl);

    const events = await collectResponseEvents(socket, {
      type: "response.create",
      model: "gpt-5.6-sol",
      previous_response_id: "resp_qa_unknown",
      input: [],
    });

    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        status: 400,
        error: {
          type: "invalid_request_error",
          code: "previous_response_not_found",
          message: "The previous response was not found on this connection.",
        },
      }),
    ]);
  });

  it("returns a bounded protocol error for malformed WebSocket requests", async () => {
    const server = await startServer();
    const socket = await connectResponsesWebSocket(server.baseUrl);

    const events = await collectResponseEvents(socket, "{invalid-json");

    expect(events).toEqual([
      expect.objectContaining({
        type: "error",
        status: 400,
        error: {
          type: "invalid_request_error",
          message: "Expected a JSON response.create request.",
        },
      }),
    ]);
  });
});
