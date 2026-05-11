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
          model: "aimock/gpt-5.5",
          stream: false,
          input: [makeResponsesInput("hello aimock")],
        }),
      });
      expect(response.status).toBe(200);
      const responseBody = (await response.json()) as { model?: unknown; status?: unknown };
      expect(responseBody.status).toBe("completed");
      expect(responseBody.model).toBe("aimock/gpt-5.5");

      const debug = await fetch(`${server.baseUrl}/debug/last-request`);
      expect(debug.status).toBe(200);
      const expectedBody = {
        model: "aimock/gpt-5.5",
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
        model: "aimock/gpt-5.5",
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
          model: "aimock/gpt-5.5",
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
        model: "aimock/gpt-5.5",
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
          model: "aimock/gpt-5.5",
          providerVariant: "openai",
          imageInputCount: 0,
        },
      ]);
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
          model: "openai-codex/gpt-5.5",
          stream: false,
          input: [makeResponsesInput("hello codex-compatible aimock")],
        }),
      });
      expect(response.status).toBe(200);

      const debug = await fetch(`${server.baseUrl}/debug/last-request`);
      expect(debug.status).toBe(200);
      const expectedBody = {
        model: "openai-codex/gpt-5.5",
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
        model: "openai-codex/gpt-5.5",
        providerVariant: "openai",
        imageInputCount: 0,
      });
    } finally {
      await server.stop();
    }
  });
});
