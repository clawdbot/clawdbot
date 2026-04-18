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
          model: "aimock/gpt-5.4",
          stream: false,
          input: [makeResponsesInput("hello aimock")],
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "completed",
        model: "aimock/gpt-5.4",
      });

      const debug = await fetch(`${server.baseUrl}/debug/last-request`);
      expect(debug.status).toBe(200);
      expect(await debug.json()).toMatchObject({
        prompt: "hello aimock",
        allInputText: "hello aimock",
        model: "aimock/gpt-5.4",
        providerVariant: "openai",
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
          model: "aimock/gpt-5.4",
          stream: false,
          input: [makeResponsesInput("@openclaw explain the QA lab")],
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "completed",
      });

      const debug = await fetch(`${server.baseUrl}/debug/requests`);
      expect(debug.status).toBe(200);
      expect(await debug.json()).toEqual([
        expect.objectContaining({
          prompt: "@openclaw explain the QA lab",
        }),
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
          model: "openai-codex/gpt-5.4",
          stream: false,
          input: [makeResponsesInput("hello codex-compatible aimock")],
        }),
      });
      expect(response.status).toBe(200);

      const debug = await fetch(`${server.baseUrl}/debug/last-request`);
      expect(debug.status).toBe(200);
      expect(await debug.json()).toMatchObject({
        model: "openai-codex/gpt-5.4",
        providerVariant: "openai",
      });
    } finally {
      await server.stop();
    }
  });
});
