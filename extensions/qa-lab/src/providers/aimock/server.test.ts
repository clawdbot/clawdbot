// Qa Lab tests cover server plugin behavior.
import { describe, expect, it } from "vitest";
import { startQaAimockServer } from "./server.js";

function makeResponsesInput(text: string) {
  return {
    role: "user",
    content: [
      {
        type: "input_text",
        text,
      },
    ],
  };
}

describe("qa aimock server", () => {
  it("serves OpenAI Responses text replies and debug request snapshots", async () => {
    const server = await startQaAimockServer({
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const response = await fetch(`${server.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "aimock/gpt-5.6-luna",
          stream: false,
          input: [makeResponsesInput("hello aimock")],
        }),
      });
      expect(response.status).toBe(200);
      const responseBody = (await response.json()) as { model?: unknown; status?: unknown };
      expect(responseBody.status).toBe("completed");
      expect(responseBody.model).toBe("aimock/gpt-5.6-luna");

      const debug = await fetch(`${server.baseUrl}/debug/last-request`);
      expect(debug.status).toBe(200);
      const expectedBody = {
        model: "aimock/gpt-5.6-luna",
        messages: [{ role: "user", content: "hello aimock" }],
        stream: false,
        _endpointType: "chat",
      };
      expect(await debug.json()).toEqual({
        raw: JSON.stringify(expectedBody),
        body: expectedBody,
        prompt: "hello aimock",
        allInputText: "hello aimock",
        toolOutput: "",
        model: "aimock/gpt-5.6-luna",
        providerVariant: "openai",
        imageInputCount: 0,
      });
    } finally {
      await server.stop();
    }
  });

  it("records the request list for scenario assertions", async () => {
    const server = await startQaAimockServer({
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const response = await fetch(`${server.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "aimock/gpt-5.6-luna",
          stream: false,
          input: [makeResponsesInput("@openclaw explain the QA lab")],
        }),
      });
      expect(response.status).toBe(200);
      const responseBody = (await response.json()) as { status?: unknown };
      expect(responseBody.status).toBe("completed");

      const debug = await fetch(`${server.baseUrl}/debug/requests`);
      expect(debug.status).toBe(200);
      const expectedBody = {
        model: "aimock/gpt-5.6-luna",
        messages: [{ role: "user", content: "@openclaw explain the QA lab" }],
        stream: false,
        _endpointType: "chat",
      };
      expect(await debug.json()).toEqual([
        {
          raw: JSON.stringify(expectedBody),
          body: expectedBody,
          prompt: "@openclaw explain the QA lab",
          allInputText: "@openclaw explain the QA lab",
          toolOutput: "",
          model: "aimock/gpt-5.6-luna",
          providerVariant: "openai",
          imageInputCount: 0,
        },
      ]);
    } finally {
      await server.stop();
    }
  });

  it("reads requests after a stable debug cursor", async () => {
    const server = await startQaAimockServer({
      host: "127.0.0.1",
      port: 0,
    });
    const post = async (text: string) => {
      const response = await fetch(`${server.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "aimock/gpt-5.6-luna",
          stream: false,
          input: [makeResponsesInput(text)],
        }),
      });
      expect(response.status).toBe(200);
    };
    try {
      expect(
        await fetch(`${server.baseUrl}/debug/request-cursor`).then((response) => response.json()),
      ).toEqual({ cursor: 0 });
      const debugRequestLimit = 1_000;
      for (let index = 0; index < debugRequestLimit; index += 1) {
        await post(`aimock cursor ${index}`);
      }
      const cursor = await fetch(`${server.baseUrl}/debug/request-cursor`).then((response) =>
        response.json(),
      );
      expect(cursor).toEqual({ cursor: debugRequestLimit });
      await post("aimock cursor overflow");

      const retained = (await fetch(`${server.baseUrl}/debug/requests`).then((response) =>
        response.json(),
      )) as Array<{ prompt?: unknown }>;
      expect(retained).toHaveLength(debugRequestLimit);
      expect(retained[0]?.prompt).toBe("aimock cursor 1");
      expect(retained.at(-1)?.prompt).toBe("aimock cursor overflow");

      const after = await fetch(`${server.baseUrl}/debug/requests?after=${debugRequestLimit}`);
      expect(after.status).toBe(200);
      const requests = (await after.json()) as Array<{ prompt?: unknown }>;
      expect(requests).toHaveLength(1);
      expect(requests[0]?.prompt).toBe("aimock cursor overflow");

      const expired = await fetch(`${server.baseUrl}/debug/requests?after=0`);
      expect(expired.status).toBe(409);
      expect(await expired.json()).toEqual({
        error: "request cursor expired",
        after: 0,
        oldestCursor: 2,
        latestCursor: debugRequestLimit + 1,
      });

      const futureCursor = debugRequestLimit + 2;
      const future = await fetch(`${server.baseUrl}/debug/requests?after=${futureCursor}`);
      expect(future.status).toBe(409);
      expect(await future.json()).toEqual({
        error: "request cursor is ahead of the latest recorded request",
        after: futureCursor,
        latestCursor: debugRequestLimit + 1,
      });
    } finally {
      await server.stop();
    }
  });

  it("treats OpenAI Codex model refs as OpenAI-compatible snapshots", async () => {
    const server = await startQaAimockServer({
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const response = await fetch(`${server.baseUrl}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "openai/gpt-5.6-luna",
          stream: false,
          input: [makeResponsesInput("hello codex-compatible aimock")],
        }),
      });
      expect(response.status).toBe(200);

      const debug = await fetch(`${server.baseUrl}/debug/last-request`);
      expect(debug.status).toBe(200);
      const expectedBody = {
        model: "openai/gpt-5.6-luna",
        messages: [{ role: "user", content: "hello codex-compatible aimock" }],
        stream: false,
        _endpointType: "chat",
      };
      expect(await debug.json()).toEqual({
        raw: JSON.stringify(expectedBody),
        body: expectedBody,
        prompt: "hello codex-compatible aimock",
        allInputText: "hello codex-compatible aimock",
        toolOutput: "",
        model: "openai/gpt-5.6-luna",
        providerVariant: "openai",
        imageInputCount: 0,
      });
    } finally {
      await server.stop();
    }
  });
});
